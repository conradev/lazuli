use std::cell::Cell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::ops::Range;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use bytemuck::{Pod, Zeroable};
use js_sys::{Array, Float32Array, Object, Promise, Reflect, Uint8Array, Uint32Array};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;
use web_sys::HtmlCanvasElement;
use wgpu::util::DeviceExt;

use crate::clip::gx_exact_draw_raster_geometry;
use crate::packet::{GxCopyKind, GxCopyState, GxFramePacket, GxTriangleAction};
use crate::raster::GxRasterAttributePlaneF32;
use crate::tev::{
    MAX_TEV_TEXTURES, TEV_DRAW_STATE_BYTES, TEV_TEXTURE_METADATA_WORDS, TEV_VERTEX_FLOATS,
    required_texture_coords, required_texture_maps, shader_source as tev_shader_source,
    validate_draw_transport,
};
use crate::{
    EFB_HEIGHT, EFB_WIDTH, GX_DEPTH24_MAX, GX_IDENTITY_COPY_FILTER, GX_MAX_COPY_DIMENSION,
    GX_NON_AA_TO_WEBGPU_POSITION_CORRECTION_EFB, GxBlendFactor, GxBlendOperation, GxCopyClearMask,
    GxDepthCompareLocation, GxDestinationAlphaState, GxEarlyDepthPlan, GxEfbDepthEncoding,
    GxEfbFormat, GxFogState, GxRasterCenterEvidence, GxRasterPoint28_4, GxRasterScissor,
    GxRasterSetup, GxRasterTriangle28_4, GxRasterWinding, GxXfbCopyParameters, GxZTextureFormat,
    GxZTextureOperation, GxZTextureState, RendererFailureState, RendererHostTimings,
    RendererMetrics, RendererPhaseTiming, SamplerIdentity, SelectedTexture, SurfacePixelOrder,
    SurfaceReadbackRequestError, TextureAddressMode, TextureBindingIdentity, ViFieldDescriptor,
    ViFieldPairOutcome, ViFieldPairState, ViFieldParity, ViHostFrame, ViOwnedField,
    ViPresentationMode, XfbCopyMetadata, XfbReadbackLayout, XfbScanoutPlan, clipped_copy_extent,
    compact_surface_readback_rows, compact_xfb_scanout_rows, decoded_texture_cache_hit,
    decoded_texture_is_available, gx_blend_factor_for_component, gx_blend_state,
    gx_copy_clear_mask, gx_copy_clear_rgba, gx_destination_alpha_state, gx_early_depth_plan,
    gx_efb_depth_encoding, gx_fog_state, gx_raster_center_evidence, gx_sampler_identity,
    gx_xfb_copy_parameters, gx_xfb_output_height, gx_z_texture_state, merge_contiguous_draw_range,
    requested_surface_readback_layout, require_tev_texture, reusable_xfb_surface_index,
    rgba8_texture_byte_len, select_texture, xfb_copy_matches_selection, xfb_readback_layout,
    xfb_scanout_plan, xfb_surface_extent_matches,
};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn host_performance_now() -> f64;
}

const PRESENT_SHADER: &str = "
struct XfbPresentUniform {
    geometry: vec4<u32>,
    top_scanout: vec4<u32>,
    bottom_scanout: vec4<u32>,
    options: vec4<u32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

@group(0) @binding(0) var top_texture: texture_2d<f32>;
@group(0) @binding(1) var bottom_texture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> present: XfbPresentUniform;

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
    let positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    var output: VertexOutput;
    output.position = vec4<f32>(positions[index], 0.0, 1.0);
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let logical_width = present.geometry.x;
    let logical_height = present.geometry.y;
    let display_width = present.geometry.z;
    let display_height = present.geometry.w;
    let output_x = min(u32(input.position.x), display_width - 1u);
    let output_y = min(u32(input.position.y), display_height - 1u);
    let logical_x = min(output_x * logical_width / display_width, logical_width - 1u);
    if present.options.x == 1u && (output_y & 1u) == 1u {
        let selected_row = present.bottom_scanout.x;
        let source_row_step = present.bottom_scanout.y;
        let field_height = present.bottom_scanout.z;
        let row_repeat = present.bottom_scanout.w;
        let field_line = min(output_y / row_repeat, field_height - 1u);
        let logical_y = selected_row + field_line * source_row_step;
        let source_size = textureDimensions(bottom_texture);
        let source_x = min(logical_x * source_size.x / logical_width, source_size.x - 1u);
        let source_y = min(logical_y * source_size.y / logical_height, source_size.y - 1u);
        return vec4<f32>(
            textureLoad(bottom_texture, vec2<i32>(i32(source_x), i32(source_y)), 0).rgb,
            1.0,
        );
    }
    let selected_row = present.top_scanout.x;
    let source_row_step = present.top_scanout.y;
    let field_height = present.top_scanout.z;
    let row_repeat = present.top_scanout.w;
    let field_line = min(output_y / row_repeat, field_height - 1u);
    let logical_y = selected_row + field_line * source_row_step;
    let source_size = textureDimensions(top_texture);
    let source_x = min(logical_x * source_size.x / logical_width, source_size.x - 1u);
    let source_y = min(logical_y * source_size.y / logical_height, source_size.y - 1u);
    return vec4<f32>(
        textureLoad(top_texture, vec2<i32>(i32(source_x), i32(source_y)), 0).rgb,
        1.0,
    );
}
";

const DRAW_TIMING_SAMPLE_STRIDE: u64 = 1024;

const XFB_COPY_SHADER: &str = "
struct XfbCopyUniform {
    source_rect: vec4<f32>,
    filter_coefficients: vec4<u32>,
    sampling: vec4<f32>,
    options: vec4<u32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) source_x: f32,
};

@group(0) @binding(0) var efb_texture: texture_2d<f32>;
@group(0) @binding(1) var efb_sampler: sampler;
@group(0) @binding(2) var<uniform> copy: XfbCopyUniform;

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
    let positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    let coordinates = array<f32, 3>(
        0.0,
        2.0,
        0.0,
    );
    var output: VertexOutput;
    output.position = vec4<f32>(positions[index], 0.0, 1.0);
    output.source_x = copy.source_rect.x + coordinates[index] * copy.source_rect.z;
    return output;
}

fn round_even_unorm8(channel: f32) -> u32 {
    let scaled = clamp(channel, 0.0, 1.0) * 255.0;
    let lower = floor(scaled);
    let fraction = scaled - lower;
    let lower_int = u32(lower);
    let increment = fraction > 0.5 || (fraction == 0.5 && (lower_int & 1u) != 0u);
    return lower_int + select(0u, 1u, increment);
}

fn native_efb_sample(tex_sample: vec4<f32>) -> vec4<u32> {
    if copy.options.x == 1u {
        var value = vec4<u32>(
            round_even_unorm8(tex_sample.r),
            round_even_unorm8(tex_sample.g),
            round_even_unorm8(tex_sample.b),
            round_even_unorm8(tex_sample.a),
        );
        value = (value & vec4<u32>(0xfcu)) | (value >> vec4<u32>(6u));
        return value;
    }
    if copy.options.x == 2u {
        let value = vec4<u32>(
            round_even_unorm8(tex_sample.r),
            round_even_unorm8(tex_sample.g),
            round_even_unorm8(tex_sample.b),
            255u,
        );
        return vec4<u32>(
            (value.r & 0xf8u) | (value.r >> 5u),
            (value.g & 0xfcu) | (value.g >> 6u),
            (value.b & 0xf8u) | (value.b >> 5u),
            255u,
        );
    }
    let value = vec4<u32>(tex_sample * 255.0);
    return vec4<u32>(value.rgb, 255u);
}

fn sample_efb(source_x: f32, source_y: f32, row_offset: f32) -> vec4<u32> {
    let y = clamp(
        source_y + row_offset * copy.source_rect.w,
        copy.sampling.y,
        copy.sampling.z,
    );
    return native_efb_sample(textureSample(efb_texture, efb_sampler, vec2<f32>(source_x, y)));
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // The BP y-scale defines source sample spacing directly. output_height is
    // only the number of fragment rows and must not be folded into this ratio.
    let source_y = (input.position.y + copy.source_rect.y)
        * copy.sampling.w * copy.source_rect.w;
    let previous = sample_efb(input.source_x, source_y, -1.0);
    let current = sample_efb(input.source_x, source_y, 0.0);
    let next = sample_efb(input.source_x, source_y, 1.0);
    var combined = previous.rgb * copy.filter_coefficients.x
        + current.rgb * copy.filter_coefficients.y
        + next.rgb * copy.filter_coefficients.z;
    var filtered = combined >> vec3<u32>(6u);
    let coefficient_sum = copy.filter_coefficients.x
        + copy.filter_coefficients.y
        + copy.filter_coefficients.z;
    if coefficient_sum >= 128u {
        filtered = filtered & vec3<u32>(0x1ffu);
    }
    filtered = min(filtered, vec3<u32>(255u));
    // SMB programs identity gamma. Keep the branch uniform so that path does
    // not execute three pow operations for every XFB pixel.
    if copy.options.y != 0u {
        filtered = vec3<u32>(round(
            pow(vec3<f32>(filtered) / 255.0, vec3<f32>(copy.sampling.x)) * 255.0
        ));
    }
    return vec4<f32>(vec4<u32>(filtered, 255u)) / 255.0;
}
";

const COPY_CLEAR_SHADER: &str = "
struct CopyClearUniform {
    color: vec4<f32>,
    depth_and_padding: vec4<f32>,
};

struct FragmentOutput {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
};

@group(0) @binding(0) var<uniform> clear: CopyClearUniform;

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    return vec4<f32>(positions[index], 0.0, 1.0);
}

@fragment
fn fs_main() -> FragmentOutput {
    var output: FragmentOutput;
    output.color = clear.color;
    output.depth = clear.depth_and_padding.x;
    return output;
}
";

const DECODED_TEXTURE_CACHE_CAPACITY: usize = 128;
const XFB_PRESENT_BIND_GROUP_CACHE_CAPACITY: usize = 32;
const XFB_SURFACES_PER_DESTINATION: usize = 4;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct TevVertex {
    position: [f32; 4],
    raster0: [f32; 4],
    raster1: [f32; 4],
    tex_coords: [[f32; 3]; MAX_TEV_TEXTURES],
}

const _: () = assert!(std::mem::size_of::<TevVertex>() == TEV_VERTEX_FLOATS * size_of::<f32>());

const TEV_VERTEX_ATTRIBUTES: [wgpu::VertexAttribute; 11] = wgpu::vertex_attr_array![
    0 => Float32x4,
    1 => Float32x4,
    2 => Float32x4,
    3 => Float32x3,
    4 => Float32x3,
    5 => Float32x3,
    6 => Float32x3,
    7 => Float32x3,
    8 => Float32x3,
    9 => Float32x3,
    10 => Float32x3
];

// Managed draws reconstruct one live projective coordinate from a six-vec3
// flat payload in STQ0..STQ5. STQ6/STQ7's final 24 bytes carry three packed
// exact 28.4 edge points followed by the three raw f32 depth words, without
// inflating native vertex transport.
const MANAGED_COVERAGE_VERTEX_ATTRIBUTES: [wgpu::VertexAttribute; 11] = wgpu::vertex_attr_array![
    0 => Float32x4,
    1 => Float32x4,
    2 => Float32x4,
    3 => Float32x3,
    4 => Float32x3,
    5 => Float32x3,
    6 => Float32x3,
    7 => Float32x3,
    8 => Float32x3,
    11 => Sint32x4,
    12 => Sint32x2
];

/// Proof supplied by a producer that has already performed homogeneous cull
/// classification and normalized each surviving triangle into GX edge order.
///
/// Rounded EFB coordinates cannot synthesize this proof: a tiny positive W can
/// make their area sign disagree with the producer's f32 homogeneous result.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum ManagedCoverageEvidence {
    #[default]
    None,
    TrustedPostCull,
    TrustedExactClip,
}

/// Exact raster geometry prepared while a complete packet is still immutable.
///
/// Keeping both the triangle-list indices and raw-derived scissor here lets
/// live submission select the exact path without topology expansion or legacy
/// scissor reconstruction after the segment has begun.
struct QualifiedExactDraw {
    vertices: Vec<f32>,
    expanded: Vec<usize>,
    scissor: Option<ScissorRect>,
}

impl QualifiedExactDraw {
    fn is_empty(&self) -> bool {
        self.expanded.is_empty()
    }
}

/// The three exact-input states must remain distinct. An exact draw that is
/// not yet supported falls back to its original native geometry, but must not
/// accidentally borrow legacy managed evidence intended for an absent input.
enum PreparedExactDraw {
    Unqualified,
    Qualified(QualifiedExactDraw),
}

impl PreparedExactDraw {
    fn qualified(&self) -> Option<&QualifiedExactDraw> {
        match self {
            Self::Unqualified => None,
            Self::Qualified(exact) => Some(exact),
        }
    }

    fn is_authoritative_empty(&self) -> bool {
        self.qualified().is_some_and(QualifiedExactDraw::is_empty)
    }
}

const DRAW_FRAGMENT_FLAG_RGBA6: u32 = 1;
const DRAW_FRAGMENT_FLAG_FOG: u32 = 2;
const DRAW_FRAGMENT_DEPTH_ENCODING_SHIFT: u32 = 2;
const DRAW_FRAGMENT_FLAG_LATE_Z_TEXTURE: u32 = 1 << 5;
const REQUIRED_WEBGPU_FEATURES: wgpu::Features =
    wgpu::Features::DUAL_SOURCE_BLENDING.union(wgpu::Features::DEPTH_CLIP_CONTROL);

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Pod, Zeroable)]
struct DrawUniform {
    alpha_test: u32,
    destination_alpha: u32,
    fragment_flags: u32,
    z_texture: u32,
    fog_control: [u32; 4],
    fog_range0: [u32; 4],
    fog_range1: [u32; 4],
    fog_parameters0: [u32; 4],
    fog_parameters1: [u32; 4],
    sampler_modes0: [u32; 4],
    sampler_modes1: [u32; 4],
}

const _: () = assert!(std::mem::size_of::<DrawUniform>() == 128);

impl DrawUniform {
    fn from_gx(
        alpha_test: u32,
        destination_alpha: GxDestinationAlphaState,
        z_texture: GxZTextureState,
        depth_encoding: GxEfbDepthEncoding,
        depth_enabled: bool,
        fog: GxFogState,
    ) -> Self {
        let format = match z_texture.format {
            GxZTextureFormat::U8 => 0,
            GxZTextureFormat::U16 => 1,
            GxZTextureFormat::U24 => 2,
        };
        let operation = match z_texture.operation {
            GxZTextureOperation::Disabled => 0,
            GxZTextureOperation::Add => 1,
            GxZTextureOperation::Replace => 2,
        };
        Self {
            alpha_test: alpha_test & 0x00ff_ffff,
            destination_alpha: u32::from(destination_alpha.effective_constant),
            fragment_flags: if destination_alpha.target_has_guest_alpha {
                DRAW_FRAGMENT_FLAG_RGBA6
            } else {
                0
            } | if (fog.parameters[3] >> 21) & 7 != 0 {
                DRAW_FRAGMENT_FLAG_FOG
            } else {
                0
            } | (depth_encoding.shader_code()
                << DRAW_FRAGMENT_DEPTH_ENCODING_SHIFT)
                | if depth_enabled
                    && z_texture.operation != GxZTextureOperation::Disabled
                    && z_texture.depth_compare_location == GxDepthCompareLocation::Late
                {
                    DRAW_FRAGMENT_FLAG_LATE_Z_TEXTURE
                } else {
                    0
                },
            z_texture: (z_texture.bias & GX_DEPTH24_MAX) | (format << 24) | (operation << 26),
            fog_control: [fog.range_base, 0, 0, 0],
            fog_range0: [
                fog.range_coefficients[0],
                fog.range_coefficients[1],
                fog.range_coefficients[2],
                fog.range_coefficients[3],
            ],
            fog_range1: [fog.range_coefficients[4], 0, 0, 0],
            fog_parameters0: [
                fog.parameters[0],
                fog.parameters[1],
                fog.parameters[2],
                fog.parameters[3],
            ],
            fog_parameters1: [fog.parameters[4], 0, 0, 0],
            sampler_modes0: [0; 4],
            sampler_modes1: [0; 4],
        }
    }

    fn with_sampler_modes(mut self, sampler_modes: [u32; MAX_TEV_TEXTURES]) -> Self {
        self.sampler_modes0.copy_from_slice(&sampler_modes[..4]);
        self.sampler_modes1.copy_from_slice(&sampler_modes[4..]);
        self
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct CopyClearUniform {
    color: [f32; 4],
    depth_and_padding: [f32; 4],
}

impl CopyClearUniform {
    fn new(rgba: [u8; 4], depth: u32, depth_encoding: GxEfbDepthEncoding) -> Self {
        Self {
            color: rgba.map(|channel| f32::from(channel) / 255.0),
            depth_and_padding: [depth_encoding.depth32_float(depth), 0.0, 0.0, 0.0],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct XfbPresentUniform {
    geometry: [u32; 4],
    top_scanout: [u32; 4],
    bottom_scanout: [u32; 4],
    options: [u32; 4],
}

impl XfbPresentUniform {
    fn new(
        logical_width: u32,
        logical_height: u32,
        display_width: u32,
        top: XfbScanoutPlan,
        bottom: XfbScanoutPlan,
        interlaced: bool,
    ) -> Self {
        Self {
            geometry: [
                logical_width,
                logical_height,
                display_width,
                top.display_height,
            ],
            top_scanout: [
                top.selected_row,
                top.source_row_step,
                top.field_height,
                top.row_repeat,
            ],
            bottom_scanout: [
                bottom.selected_row,
                bottom.source_row_step,
                bottom.field_height,
                bottom.row_repeat,
            ],
            options: [u32::from(interlaced), 0, 0, 0],
        }
    }
}

struct CopyClearResources {
    uniform: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    pipelines: Vec<wgpu::RenderPipeline>,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct XfbCopyUniform {
    source_rect: [f32; 4],
    filter_coefficients: [u32; 4],
    sampling: [f32; 4],
    options: [u32; 4],
}

impl XfbCopyUniform {
    fn new(
        source_x: u32,
        source_y: u32,
        source_width: u32,
        source_height: u32,
        parameters: GxXfbCopyParameters,
    ) -> Self {
        let top = if parameters.clamp_top { source_y } else { 0 };
        let bottom = if parameters.clamp_bottom {
            source_y + source_height
        } else {
            EFB_HEIGHT
        } - 1;
        Self {
            source_rect: [
                source_x as f32 / EFB_WIDTH as f32,
                source_y as f32,
                source_width as f32 / EFB_WIDTH as f32,
                1.0 / EFB_HEIGHT as f32,
            ],
            filter_coefficients: [
                parameters.filter_coefficients[0],
                parameters.filter_coefficients[1],
                parameters.filter_coefficients[2],
                0,
            ],
            sampling: [
                parameters.gamma.reciprocal(),
                (top as f32 + 0.5) / EFB_HEIGHT as f32,
                (bottom as f32 + 0.5) / EFB_HEIGHT as f32,
                parameters.y_scale_reciprocal(),
            ],
            options: [
                match parameters.source_format {
                    GxEfbFormat::Rgb8Z24 => 0,
                    GxEfbFormat::Rgba6Z24 => 1,
                    GxEfbFormat::Rgb565Z16 => 2,
                    GxEfbFormat::Z24 | GxEfbFormat::OtherNoAlpha => u32::MAX,
                },
                u32::from(parameters.gamma != crate::GxCopyGamma::Gamma1_0),
                0,
                0,
            ],
        }
    }
}

struct XfbCopyResources {
    uniform: wgpu::Buffer,
    nearest_bind_group: wgpu::BindGroup,
    linear_bind_group: wgpu::BindGroup,
    pipeline: wgpu::RenderPipeline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Primitive {
    Triangles,
    Lines,
    Points,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum CullMode {
    None,
    Back,
    Front,
    All,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct DepthPipelineState {
    compare: wgpu::CompareFunction,
    write: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct BlendComponentState {
    source: wgpu::BlendFactor,
    destination: wgpu::BlendFactor,
    operation: wgpu::BlendOperation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct BlendPipelineState {
    enabled: bool,
    color: BlendComponentState,
    alpha: BlendComponentState,
    color_write: bool,
    alpha_write: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct PipelineKey {
    primitive: Primitive,
    cull: CullMode,
    managed_coverage: bool,
    depth: DepthPipelineState,
    blend: BlendPipelineState,
    canonical_fragment_depth: bool,
    unclipped_depth: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct DepthCommitPipelineKey {
    primitive: Primitive,
    cull: CullMode,
    compare: wgpu::CompareFunction,
    depth_encoding: GxEfbDepthEncoding,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ScissorRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DrawCommandState {
    pipeline: Option<PipelineKey>,
    depth_commit: Option<DepthCommitPipelineKey>,
    early_depth: GxEarlyDepthPlan,
    scissor: ScissorRect,
    binding: Option<usize>,
}

struct DrawCommand {
    vertices: Range<u32>,
    state: DrawCommandState,
}

struct TevTextureInput<'a> {
    key: &'a str,
    pixels: &'a [u8],
    address: u32,
    generation: u32,
    width: u32,
    height: u32,
    sampler: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct TevBindingKey {
    textures: [TextureBindingIdentity; MAX_TEV_TEXTURES],
    samplers: [SamplerIdentity; MAX_TEV_TEXTURES],
    state: Vec<u8>,
    draw: DrawUniform,
}

struct CachedTevDrawBinding {
    _draw_uniform: wgpu::Buffer,
    draw_bind_group: wgpu::BindGroup,
    _tev_uniform: wgpu::Buffer,
    tev_bind_group: wgpu::BindGroup,
}

struct CachedTexture {
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
    generation: u32,
    width: u32,
    height: u32,
}

#[derive(Clone)]
struct CachedXfbSurface {
    id: u64,
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
}

struct CachedXfbPresentBinding {
    top_surface_id: u64,
    bottom_surface_id: u64,
    bind_group: wgpu::BindGroup,
}

struct XfbPresentResources {
    uniform: wgpu::Buffer,
    bindings: VecDeque<CachedXfbPresentBinding>,
}

struct CachedXfb {
    surface: CachedXfbSurface,
    spares: Vec<CachedXfbSurface>,
    metadata: XfbCopyMetadata,
    output_width: u32,
    output_height: u32,
}

#[derive(Clone)]
struct PresentedXfbField {
    surface_id: u64,
    texture: wgpu::Texture,
    selected_address: u32,
    generation: u32,
    scanout: XfbScanoutPlan,
    source_width: u32,
    source_height: u32,
    logical_width: u32,
    logical_height: u32,
}

#[derive(Clone)]
struct PresentedFieldProvenance {
    surface_id: u64,
    selected_address: u32,
    generation: u32,
    scanout: XfbScanoutPlan,
    source_width: u32,
    source_height: u32,
    logical_width: u32,
    logical_height: u32,
}

impl PresentedXfbField {
    fn provenance(&self) -> PresentedFieldProvenance {
        PresentedFieldProvenance {
            surface_id: self.surface_id,
            selected_address: self.selected_address,
            generation: self.generation,
            scanout: self.scanout,
            source_width: self.source_width,
            source_height: self.source_height,
            logical_width: self.logical_width,
            logical_height: self.logical_height,
        }
    }
}

#[derive(Clone)]
struct PresentedFrameProvenance {
    pair_epoch: u32,
    mode: ViPresentationMode,
    top: Option<PresentedFieldProvenance>,
    bottom: Option<PresentedFieldProvenance>,
    display_width: u32,
    display_height: u32,
}

#[derive(Clone)]
struct PresentedXfb {
    presentation_serial: u64,
    provenance: PresentedFrameProvenance,
    top: Option<PresentedXfbField>,
    bottom: Option<PresentedXfbField>,
}

#[derive(Clone)]
struct PresentedSurface {
    buffer: wgpu::Buffer,
    layout: XfbReadbackLayout,
    pixel_order: SurfacePixelOrder,
    surface_format: wgpu::TextureFormat,
    presentation_serial: u64,
    provenance: PresentedFrameProvenance,
}

struct Pipelines {
    tev_shader: wgpu::ShaderModule,
    tev_layout: wgpu::PipelineLayout,
    early_depth_layout: wgpu::PipelineLayout,
    tev_geometry: HashMap<PipelineKey, wgpu::RenderPipeline>,
    early_depth_commit: HashMap<DepthCommitPipelineKey, wgpu::RenderPipeline>,
    present: wgpu::RenderPipeline,
}

#[derive(Default)]
struct QueueDrainState {
    complete: bool,
    waker: Option<Waker>,
}

struct QueueDrain {
    state: Arc<Mutex<QueueDrainState>>,
}

#[derive(Default)]
struct BufferMapState {
    result: Option<Result<(), String>>,
    waker: Option<Waker>,
}

struct BufferMap {
    state: Arc<Mutex<BufferMapState>>,
}

impl BufferMap {
    fn new(buffer: &wgpu::Buffer) -> Self {
        let state = Arc::new(Mutex::new(BufferMapState::default()));
        let callback_state = state.clone();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let waker = {
                    let mut state = callback_state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    state.result = Some(result.map_err(|error| error.to_string()));
                    state.waker.take()
                };
                if let Some(waker) = waker {
                    waker.wake();
                }
            });
        Self { state }
    }
}

impl Future for BufferMap {
    type Output = Result<(), String>;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(result) = state.result.take() {
            Poll::Ready(result)
        } else {
            state.waker = Some(context.waker().clone());
            Poll::Pending
        }
    }
}

impl QueueDrain {
    fn new(queue: &wgpu::Queue) -> Self {
        let state = Arc::new(Mutex::new(QueueDrainState::default()));
        let callback_state = state.clone();
        queue.on_submitted_work_done(move || {
            let waker = {
                let mut state = callback_state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                state.complete = true;
                state.waker.take()
            };
            if let Some(waker) = waker {
                waker.wake();
            }
        });
        Self { state }
    }
}

impl Future for QueueDrain {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.complete {
            Poll::Ready(())
        } else {
            state.waker = Some(context.waker().clone());
            Poll::Pending
        }
    }
}

#[wasm_bindgen]
pub struct WebGpuRenderer {
    canvas: HtmlCanvasElement,
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    failure_state: RendererFailureState,
    metrics: Rc<Cell<RendererMetrics>>,
    host_timings: Rc<Cell<RendererHostTimings>>,
    draw_timing_eligible_calls: Cell<u64>,
    surface_config: wgpu::SurfaceConfiguration,
    efb_color: wgpu::Texture,
    efb_color_view: wgpu::TextureView,
    _efb_depth: wgpu::Texture,
    efb_depth_view: wgpu::TextureView,
    copy_clear: CopyClearResources,
    xfb_copy: XfbCopyResources,
    xfb_present: XfbPresentResources,
    tev_draw_layout: wgpu::BindGroupLayout,
    tev_texture_layout: wgpu::BindGroupLayout,
    present_layout: wgpu::BindGroupLayout,
    samplers: HashMap<SamplerIdentity, wgpu::Sampler>,
    white_texture: CachedTexture,
    texture_cache: HashMap<String, CachedTexture>,
    efb_copy_cache: HashMap<u32, CachedTexture>,
    xfb_cache: HashMap<u32, CachedXfb>,
    vi_field_pairs: ViFieldPairState<CachedXfbSurface>,
    last_presented_xfb: Option<PresentedXfb>,
    last_presented_surface: Option<PresentedSurface>,
    presentation_serial: u64,
    next_xfb_surface_id: u64,
    pipelines: Pipelines,
    tev_vertices: Vec<TevVertex>,
    commands: Vec<DrawCommand>,
    tev_draw_binding_indices: HashMap<TevBindingKey, usize>,
    tev_draw_bindings: Vec<CachedTevDrawBinding>,
}

#[derive(Clone, Copy)]
enum RendererHostPhase {
    PacketParse,
    TopologyExpansion,
    ResourcePreparation,
    GxFrameExecution,
}

struct RendererPhaseTimer {
    timings: Rc<Cell<RendererHostTimings>>,
    phase: RendererHostPhase,
    started_at: f64,
}

impl RendererPhaseTimer {
    fn new(timings: Rc<Cell<RendererHostTimings>>, phase: RendererHostPhase) -> Self {
        Self {
            timings,
            phase,
            started_at: host_performance_now(),
        }
    }
}

impl Drop for RendererPhaseTimer {
    fn drop(&mut self) {
        let duration_ms = host_performance_now() - self.started_at;
        let mut timings = self.timings.get();
        match self.phase {
            RendererHostPhase::PacketParse => timings.packet_parse.record(duration_ms),
            RendererHostPhase::TopologyExpansion => {
                timings.topology_expansion.record(duration_ms);
            }
            RendererHostPhase::ResourcePreparation => {
                timings.resource_preparation.record(duration_ms);
            }
            RendererHostPhase::GxFrameExecution => {
                timings.gx_frame_execution.record(duration_ms);
            }
        }
        self.timings.set(timings);
    }
}

fn update_renderer_metrics(
    metrics: &Cell<RendererMetrics>,
    update: impl FnOnce(&mut RendererMetrics),
) {
    let mut current = metrics.get();
    update(&mut current);
    metrics.set(current);
}

fn renderer_phase_timing_object(timing: RendererPhaseTiming) -> Result<Object, JsValue> {
    let result = Object::new();
    for (name, value) in [
        ("samples", timing.samples as f64),
        ("totalMs", timing.total_ms),
        ("maxMs", timing.max_ms),
    ] {
        Reflect::set(&result, &JsValue::from_str(name), &JsValue::from_f64(value))?;
    }
    Ok(result)
}

fn renderer_host_timings_object(
    timings: RendererHostTimings,
    draw_timing_eligible_calls: u64,
) -> Result<Object, JsValue> {
    let result = Object::new();
    for (name, timing) in [
        ("packetParse", timings.packet_parse),
        ("topologyExpansion", timings.topology_expansion),
        ("resourcePreparation", timings.resource_preparation),
        ("gxFrameExecution", timings.gx_frame_execution),
    ] {
        let timing: JsValue = renderer_phase_timing_object(timing)?.into();
        Reflect::set(&result, &JsValue::from_str(name), &timing)?;
    }
    let draw_sampling = Object::new();
    for (name, value) in [
        ("eligibleCalls", draw_timing_eligible_calls),
        ("sampleStride", DRAW_TIMING_SAMPLE_STRIDE),
    ] {
        Reflect::set(
            &draw_sampling,
            &JsValue::from_str(name),
            &JsValue::from_f64(value as f64),
        )?;
    }
    Reflect::set(&result, &JsValue::from_str("drawSampling"), &draw_sampling)?;
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn public_copy_clear_state(
    clear: bool,
    z_mode: u32,
    blend_mode: u32,
    pixel_control: u32,
    copy_command: u32,
    clear_rgba: [u8; 4],
    clear_depth: u32,
) -> Result<Option<GxCopyState>, JsValue> {
    if !clear {
        return Ok(None);
    }
    for (field, value) in [
        ("terminal Z mode", z_mode),
        ("terminal blend mode", blend_mode),
        ("pixel control", pixel_control),
        ("copy command", copy_command),
        ("clear depth", clear_depth),
    ] {
        if value & !0x00ff_ffff != 0 {
            return Err(JsValue::from_str(&format!(
                "GX copy clear {field} has bits outside its raw 24-bit BP value"
            )));
        }
    }
    Ok(Some(GxCopyState {
        z_mode,
        blend_mode,
        pixel_control,
        copy_command,
        clear_rgba,
        clear_depth,
        copy_scale: 0,
        copy_filter: [0; 2],
    }))
}

fn renderer_metrics_object(metrics: RendererMetrics) -> Result<Object, JsValue> {
    let result = Object::new();
    for (name, value) in [
        ("beginSegmentCalls", metrics.begin_segment_calls),
        ("bindGroupsCreated", metrics.bind_groups_created),
        ("buffersCreated", metrics.buffers_created),
        ("checkHealthCalls", metrics.check_health_calls),
        ("clearEfbCalls", metrics.clear_efb_calls),
        ("copyTextureCalls", metrics.copy_texture_calls),
        ("copyXfbCalls", metrics.copy_xfb_calls),
        ("decodedTextureQueries", metrics.decoded_texture_queries),
        ("depthCommitDraws", metrics.depth_commit_draws),
        ("drainCalls", metrics.drain_calls),
        ("earlyDepthOnlyCommands", metrics.early_depth_only_commands),
        ("expandedVertexBytes", metrics.expanded_vertex_bytes),
        ("gxFramePacketBytes", metrics.gx_frame_packet_bytes),
        (
            "gxFramePacketPayloadBytes",
            metrics.gx_frame_packet_payload_bytes,
        ),
        ("managedCoverageDraws", metrics.managed_coverage_draws),
        (
            "managedCoverageTriangles",
            metrics.managed_coverage_triangles,
        ),
        (
            "managedEarlyDepthCommands",
            metrics.managed_early_depth_commands,
        ),
        (
            "managedEarlyDepthPrimitives",
            metrics.managed_early_depth_primitives,
        ),
        ("presentXfbCalls", metrics.present_xfb_calls),
        ("pushTevDrawCalls", metrics.push_tev_draw_calls),
        ("queueSubmissions", metrics.queue_submissions),
        ("renderPipelinesCreated", metrics.render_pipelines_created),
        ("sourceVertexBytes", metrics.source_vertex_bytes),
        ("tevStateBytes", metrics.tev_state_bytes),
        ("textureMetadataBytes", metrics.texture_metadata_bytes),
        ("texturePixelBytes", metrics.texture_pixel_bytes),
        ("textureUploadBytes", metrics.texture_upload_bytes),
        ("textureWrites", metrics.texture_writes),
        ("texturesCreated", metrics.textures_created),
        ("submitGxFrameCalls", metrics.submit_gx_frame_calls),
        ("wasmBridgeCalls", metrics.wasm_bridge_calls),
        (
            "wasmBridgeTypedArrayBytes",
            metrics.wasm_bridge_typed_array_bytes,
        ),
    ] {
        Reflect::set(
            &result,
            &JsValue::from_str(name),
            &JsValue::from_f64(value as f64),
        )?;
    }
    Ok(result)
}

fn surface_pixel_order(format: wgpu::TextureFormat) -> Option<SurfacePixelOrder> {
    match format {
        wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Rgba8UnormSrgb => {
            Some(SurfacePixelOrder::Rgba8)
        }
        wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb => {
            Some(SurfacePixelOrder::Bgra8)
        }
        _ => None,
    }
}

fn surface_format_name(format: wgpu::TextureFormat) -> Option<&'static str> {
    match format {
        wgpu::TextureFormat::Rgba8Unorm => Some("rgba8unorm"),
        wgpu::TextureFormat::Rgba8UnormSrgb => Some("rgba8unorm-srgb"),
        wgpu::TextureFormat::Bgra8Unorm => Some("bgra8unorm"),
        wgpu::TextureFormat::Bgra8UnormSrgb => Some("bgra8unorm-srgb"),
        _ => None,
    }
}

fn surface_readback_error(
    error: SurfaceReadbackRequestError,
    format: wgpu::TextureFormat,
) -> JsValue {
    let detail = match error {
        SurfaceReadbackRequestError::FormatUnsupported => {
            format!("WebGPU surface capture requires RGBA8/BGRA8, got {format:?}")
        }
        SurfaceReadbackRequestError::InvalidDimensions => {
            "WebGPU surface capture dimensions are invalid".to_owned()
        }
    };
    JsValue::from_str(&detail)
}

fn vi_presentation_mode(value: &str) -> Option<ViPresentationMode> {
    match value {
        "progressive" => Some(ViPresentationMode::Progressive),
        "single-field" => Some(ViPresentationMode::SingleField),
        "interlaced" => Some(ViPresentationMode::Interlaced),
        _ => None,
    }
}

fn vi_presentation_mode_name(mode: ViPresentationMode) -> &'static str {
    match mode {
        ViPresentationMode::Progressive => "progressive",
        ViPresentationMode::SingleField => "single-field",
        ViPresentationMode::Interlaced => "interlaced",
    }
}

fn vi_field_parity(value: &str) -> Option<ViFieldParity> {
    match value {
        "top" => Some(ViFieldParity::Top),
        "bottom" => Some(ViFieldParity::Bottom),
        _ => None,
    }
}

fn xfb_presentation_result(
    accepted: bool,
    presented: bool,
    status: &str,
    pair_epoch: u32,
    presentation_serial: Option<u64>,
) -> Result<Object, JsValue> {
    let result = Object::new();
    Reflect::set(
        &result,
        &JsValue::from_str("accepted"),
        &JsValue::from_bool(accepted),
    )?;
    Reflect::set(
        &result,
        &JsValue::from_str("presented"),
        &JsValue::from_bool(presented),
    )?;
    Reflect::set(
        &result,
        &JsValue::from_str("status"),
        &JsValue::from_str(status),
    )?;
    Reflect::set(
        &result,
        &JsValue::from_str("pairEpoch"),
        &JsValue::from_f64(f64::from(pair_epoch)),
    )?;
    Reflect::set(
        &result,
        &JsValue::from_str("presentationSerial"),
        &presentation_serial.map_or(JsValue::NULL, |serial| JsValue::from_f64(serial as f64)),
    )?;
    Ok(result)
}

fn presented_field_object(field: &PresentedFieldProvenance) -> Result<Object, JsValue> {
    let result = Object::new();
    let source_row = u32::try_from(
        u64::from(field.scanout.selected_row)
            .checked_mul(u64::from(field.source_height))
            .ok_or_else(|| JsValue::from_str("presented WebGPU XFB row overflow"))?
            / u64::from(field.logical_height),
    )
    .map_err(|_| JsValue::from_str("presented WebGPU XFB row overflow"))?;
    for (name, value) in [
        ("address", field.selected_address),
        ("generation", field.generation),
        ("row", field.scanout.selected_row),
        ("sourceRow", source_row),
        ("textureWidth", field.source_width),
        ("textureHeight", field.source_height),
        ("logicalWidth", field.logical_width),
        ("logicalHeight", field.logical_height),
        ("displayHeight", field.scanout.display_height),
        ("fieldStrideBytes", field.scanout.field_stride_bytes),
        ("sourceRowStep", field.scanout.source_row_step),
        ("fieldHeight", field.scanout.field_height),
        ("rowRepeat", field.scanout.row_repeat),
    ] {
        Reflect::set(
            &result,
            &JsValue::from_str(name),
            &JsValue::from_f64(f64::from(value)),
        )?;
    }
    Reflect::set(
        &result,
        &JsValue::from_str("surfaceId"),
        &JsValue::from_f64(field.surface_id as f64),
    )?;
    Reflect::set(
        &result,
        &JsValue::from_str("scanoutPolicy"),
        &JsValue::from_str(if field.scanout.row_repeat == 2 {
            "bob"
        } else {
            "direct"
        }),
    )?;
    Ok(result)
}

fn set_presented_frame_provenance(
    result: &Object,
    provenance: &PresentedFrameProvenance,
) -> Result<(), JsValue> {
    Reflect::set(
        result,
        &JsValue::from_str("pairEpoch"),
        &JsValue::from_f64(f64::from(provenance.pair_epoch)),
    )?;
    Reflect::set(
        result,
        &JsValue::from_str("presentationMode"),
        &JsValue::from_str(vi_presentation_mode_name(provenance.mode)),
    )?;
    Reflect::set(
        result,
        &JsValue::from_str("displayWidth"),
        &JsValue::from_f64(f64::from(provenance.display_width)),
    )?;
    Reflect::set(
        result,
        &JsValue::from_str("displayHeight"),
        &JsValue::from_f64(f64::from(provenance.display_height)),
    )?;
    Reflect::set(
        result,
        &JsValue::from_str("scanoutPolicy"),
        &JsValue::from_str(if provenance.mode == ViPresentationMode::Interlaced {
            "weave"
        } else {
            "direct"
        }),
    )?;
    let fields = Object::new();
    if let Some(top) = provenance.top.as_ref() {
        let top: JsValue = presented_field_object(top)?.into();
        Reflect::set(&fields, &JsValue::from_str("top"), &top)?;
    }
    if let Some(bottom) = provenance.bottom.as_ref() {
        let bottom: JsValue = presented_field_object(bottom)?.into();
        Reflect::set(&fields, &JsValue::from_str("bottom"), &bottom)?;
    }
    Reflect::set(result, &JsValue::from_str("fields"), &fields)?;
    Ok(())
}

struct EncodedXfbReadback {
    buffer: wgpu::Buffer,
    layout: XfbReadbackLayout,
    logical_height: u32,
    scanout: XfbScanoutPlan,
}

fn encode_presented_xfb_field_readback(
    device: &wgpu::Device,
    encoder: &mut wgpu::CommandEncoder,
    field: &PresentedXfbField,
) -> Result<EncodedXfbReadback, JsValue> {
    let layout = xfb_readback_layout(
        field.source_width,
        field.source_height,
        field.logical_height,
        0,
    )
    .ok_or_else(|| JsValue::from_str("presented WebGPU XFB has no readable pixels"))?;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("browser presented XFB field readback"),
        size: layout.buffer_bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &field.texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(layout.padded_bytes_per_row),
                rows_per_image: None,
            },
        },
        wgpu::Extent3d {
            width: layout.width,
            height: layout.height,
            depth_or_array_layers: 1,
        },
    );
    Ok(EncodedXfbReadback {
        buffer,
        layout,
        logical_height: field.logical_height,
        scanout: field.scanout,
    })
}

async fn finish_presented_xfb_field_readback(
    readback: EncodedXfbReadback,
) -> Result<Vec<u8>, JsValue> {
    BufferMap::new(&readback.buffer)
        .await
        .map_err(|error| JsValue::from_str(&format!("WebGPU XFB map failed: {error}")))?;
    let pixels = {
        let mapped = readback.buffer.slice(..).get_mapped_range();
        let pixels = compact_xfb_scanout_rows(
            &mapped,
            readback.layout,
            readback.logical_height,
            readback.scanout,
        );
        drop(mapped);
        readback.buffer.unmap();
        pixels.ok_or_else(|| JsValue::from_str("WebGPU XFB map returned truncated rows"))?
    };
    Ok(pixels)
}

fn interleave_presented_xfb_fields(
    top: &[u8],
    bottom: &[u8],
    width: u32,
    height: u32,
) -> Option<Vec<u8>> {
    let row_bytes = usize::try_from(width).ok()?.checked_mul(4)?;
    let expected = row_bytes.checked_mul(usize::try_from(height).ok()?)?;
    if top.len() != expected || bottom.len() != expected {
        return None;
    }
    let mut pixels = Vec::with_capacity(expected);
    for row in 0..usize::try_from(height).ok()? {
        let offset = row.checked_mul(row_bytes)?;
        let source = if row & 1 == 0 { top } else { bottom };
        pixels.extend_from_slice(source.get(offset..offset.checked_add(row_bytes)?)?);
    }
    Some(pixels)
}

fn presented_xfb_field(field: &ViOwnedField<CachedXfbSurface>) -> PresentedXfbField {
    PresentedXfbField {
        surface_id: field.payload.id,
        texture: field.payload.texture.clone(),
        selected_address: field.descriptor.selected_address,
        generation: field.descriptor.selected_generation,
        scanout: field.descriptor.scanout,
        source_width: field.payload.width,
        source_height: field.payload.height,
        logical_width: field.descriptor.source_width,
        logical_height: field.descriptor.source_height,
    }
}

#[wasm_bindgen]
impl WebGpuRenderer {
    pub async fn create(canvas: HtmlCanvasElement) -> Result<WebGpuRenderer, JsValue> {
        Self::create_inner(canvas)
            .await
            .map_err(|error| JsValue::from_str(&error))
    }

    pub fn reset(&mut self) -> Result<(), JsValue> {
        self.record_wasm_bridge_call(0);
        // Pending fields own XFB surfaces. Release them before any fallible
        // health check so reset never strands pair state in a failed renderer.
        self.vi_field_pairs.reset();
        self.xfb_present.bindings.clear();
        // A failed reset must never leave a previously presented frame observable.
        self.last_presented_xfb = None;
        self.last_presented_surface = None;
        self.presentation_serial = 0;
        self.ensure_healthy()?;
        self.clear_segment();
        self.texture_cache.clear();
        self.efb_copy_cache.clear();
        self.xfb_cache.clear();
        self.reset_efb_inner()
    }

    pub fn reset_diagnostics(&self) {
        self.metrics.set(RendererMetrics::default());
        self.host_timings.set(RendererHostTimings::default());
        self.draw_timing_eligible_calls.set(0);
    }

    pub fn diagnostics(&self) -> Result<Object, JsValue> {
        renderer_metrics_object(self.metrics.get())
    }

    pub fn host_diagnostics(&self) -> Result<Object, JsValue> {
        renderer_host_timings_object(
            self.host_timings.get(),
            self.draw_timing_eligible_calls.get(),
        )
    }

    fn host_phase_timer(&self, phase: RendererHostPhase) -> RendererPhaseTimer {
        RendererPhaseTimer::new(Rc::clone(&self.host_timings), phase)
    }

    fn sample_draw_host_timing(&self) -> bool {
        let eligible_call = self.draw_timing_eligible_calls.get();
        self.draw_timing_eligible_calls
            .set(eligible_call.saturating_add(1));
        eligible_call % DRAW_TIMING_SAMPLE_STRIDE == 0
    }

    fn record_wasm_bridge_call(&self, typed_array_bytes: usize) {
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.record_wasm_bridge_call(typed_array_bytes);
        });
    }

    #[allow(clippy::too_many_arguments)]
    pub fn clear_efb_copy(
        &mut self,
        source_x: u32,
        source_y: u32,
        source_width: u32,
        source_height: u32,
        z_mode: u32,
        blend_mode: u32,
        pixel_control: u32,
        clear_red: u8,
        clear_green: u8,
        clear_blue: u8,
        clear_alpha: u8,
        clear_depth: u32,
    ) -> Result<(), JsValue> {
        self.record_wasm_bridge_call(0);
        let state = public_copy_clear_state(
            true,
            z_mode,
            blend_mode,
            pixel_control,
            0x0800,
            [clear_red, clear_green, clear_blue, clear_alpha],
            clear_depth,
        )?
        .expect("requested GX copy clear has state");
        self.clear_copy_region_inner(source_x, source_y, source_width, source_height, state)
    }

    fn reset_efb_inner(&self) -> Result<(), JsValue> {
        self.ensure_healthy()?;
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("browser EFB reset encoder"),
            });
        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("browser EFB reset pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.efb_color_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.0,
                            g: 0.0,
                            b: 0.0,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.efb_depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
        }
        self.queue.submit([encoder.finish()]);
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.queue_submissions = metrics.queue_submissions.saturating_add(1);
        });
        self.ensure_healthy()
    }

    fn clear_copy_region_inner(
        &mut self,
        source_x: u32,
        source_y: u32,
        source_width: u32,
        source_height: u32,
        state: GxCopyState,
    ) -> Result<(), JsValue> {
        self.ensure_healthy()?;
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.clear_efb_calls = metrics.clear_efb_calls.saturating_add(1);
        });
        let mut encoder = self.flush_geometry();
        if let Some((width, height)) =
            clipped_copy_extent(source_x, source_y, source_width, source_height)
        {
            self.encode_copy_clear(
                &mut encoder,
                ScissorRect {
                    x: source_x,
                    y: source_y,
                    width,
                    height,
                },
                state,
            )?;
        }
        self.queue.submit([encoder.finish()]);
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.queue_submissions = metrics.queue_submissions.saturating_add(1);
        });
        self.ensure_healthy()
    }

    fn encode_copy_clear(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        rectangle: ScissorRect,
        state: GxCopyState,
    ) -> Result<(), JsValue> {
        let mask = gx_copy_clear_mask(state.z_mode, state.blend_mode, state.pixel_control);
        if !mask.writes_anything() {
            return Ok(());
        }
        let rgba = gx_copy_clear_rgba(state.pixel_control, state.clear_rgba);
        let depth_encoding = if mask.depth {
            gx_efb_depth_encoding(state.pixel_control)
                .map_err(|error| JsValue::from_str(&error.to_string()))?
        } else {
            GxEfbDepthEncoding::Z24
        };
        let uniform = CopyClearUniform::new(rgba, state.clear_depth, depth_encoding);
        self.queue
            .write_buffer(&self.copy_clear.uniform, 0, bytemuck::bytes_of(&uniform));
        encode_copy_clear_pass(
            encoder,
            &self.efb_color_view,
            &self.efb_depth_view,
            &self.copy_clear.pipelines[mask.index()],
            &self.copy_clear.bind_group,
            rectangle,
            "browser GX post-copy clear pass",
        );
        Ok(())
    }

    pub fn begin_segment(&mut self) -> Result<(), JsValue> {
        self.record_wasm_bridge_call(0);
        self.begin_segment_inner()
    }

    fn begin_segment_inner(&mut self) -> Result<(), JsValue> {
        self.ensure_healthy()?;
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.begin_segment_calls = metrics.begin_segment_calls.saturating_add(1);
        });
        self.clear_segment();
        Ok(())
    }

    pub fn check_health(&self) -> Result<(), JsValue> {
        self.record_wasm_bridge_call(0);
        self.ensure_healthy()?;
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.check_health_calls = metrics.check_health_calls.saturating_add(1);
        });
        Ok(())
    }

    pub fn has_decoded_texture(&self, key: &str, width: u32, height: u32) -> bool {
        self.record_wasm_bridge_call(0);
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.decoded_texture_queries = metrics.decoded_texture_queries.saturating_add(1);
        });
        decoded_texture_cache_hit(
            width,
            height,
            self.texture_cache
                .get(key)
                .map(|texture| (texture.width, texture.height)),
        )
    }

    pub fn drain(&self) -> Promise {
        self.record_wasm_bridge_call(0);
        if let Err(error) = self.ensure_healthy() {
            return Promise::reject(&error);
        }
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.drain_calls = metrics.drain_calls.saturating_add(1);
        });
        let queue = self.queue.clone();
        let failure_state = self.failure_state.clone();
        future_to_promise(async move {
            ensure_renderer_healthy(&failure_state)?;
            QueueDrain::new(&queue).await;
            ensure_renderer_healthy(&failure_state)?;
            Ok(JsValue::UNDEFINED)
        })
    }

    pub fn has_presented_xfb(&self) -> bool {
        self.last_presented_xfb.is_some()
    }

    pub fn read_presented_xfb_rgba(&self) -> Promise {
        let device = self.device.clone();
        let queue = self.queue.clone();
        let failure_state = self.failure_state.clone();
        let presented = self.last_presented_xfb.clone();
        future_to_promise(async move {
            ensure_renderer_healthy(&failure_state)?;
            let presented =
                presented.ok_or_else(|| JsValue::from_str("no WebGPU XFB has been presented"))?;
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("browser presented XFB readback encoder"),
            });
            let top_readback = presented
                .top
                .as_ref()
                .map(|field| encode_presented_xfb_field_readback(&device, &mut encoder, field))
                .transpose()?;
            let bottom_readback = presented
                .bottom
                .as_ref()
                .map(|field| encode_presented_xfb_field_readback(&device, &mut encoder, field))
                .transpose()?;
            queue.submit([encoder.finish()]);
            let top_pixels = match top_readback {
                Some(readback) => Some(finish_presented_xfb_field_readback(readback).await?),
                None => None,
            };
            let bottom_pixels = match bottom_readback {
                Some(readback) => Some(finish_presented_xfb_field_readback(readback).await?),
                None => None,
            };
            let pixels = match presented.provenance.mode {
                ViPresentationMode::Interlaced => {
                    let top = top_pixels.as_deref().ok_or_else(|| {
                        JsValue::from_str("paired WebGPU XFB has no top-field pixels")
                    })?;
                    let bottom = bottom_pixels.as_deref().ok_or_else(|| {
                        JsValue::from_str("paired WebGPU XFB has no bottom-field pixels")
                    })?;
                    interleave_presented_xfb_fields(
                        top,
                        bottom,
                        presented.provenance.display_width,
                        presented.provenance.display_height,
                    )
                    .ok_or_else(|| {
                        JsValue::from_str("paired WebGPU XFB fields have incompatible rows")
                    })?
                }
                ViPresentationMode::Progressive | ViPresentationMode::SingleField => top_pixels
                    .or(bottom_pixels)
                    .ok_or_else(|| JsValue::from_str("presented WebGPU XFB has no field pixels"))?,
            };
            ensure_renderer_healthy(&failure_state)?;

            let result = Object::new();
            Reflect::set(
                &result,
                &JsValue::from_str("format"),
                &JsValue::from_str("rgba8unorm"),
            )?;
            Reflect::set(
                &result,
                &JsValue::from_str("layout"),
                &JsValue::from_str("top-left-row-major-tight"),
            )?;
            for (name, value) in [
                ("width", presented.provenance.display_width),
                ("height", presented.provenance.display_height),
            ] {
                Reflect::set(
                    &result,
                    &JsValue::from_str(name),
                    &JsValue::from_f64(f64::from(value)),
                )?;
            }
            Reflect::set(
                &result,
                &JsValue::from_str("presentationSerial"),
                &JsValue::from_f64(presented.presentation_serial as f64),
            )?;
            set_presented_frame_provenance(&result, &presented.provenance)?;
            Reflect::set(
                &result,
                &JsValue::from_str("rgba"),
                &Uint8Array::from(pixels.as_slice()),
            )?;
            Ok(result.into())
        })
    }

    pub fn has_presented_surface(&self) -> bool {
        self.last_presented_surface.is_some()
    }

    pub fn read_presented_surface_rgba(&self) -> Promise {
        let failure_state = self.failure_state.clone();
        let presented = self.last_presented_surface.clone();
        future_to_promise(async move {
            ensure_renderer_healthy(&failure_state)?;
            let presented = presented.ok_or_else(|| {
                JsValue::from_str("no requested WebGPU surface capture has been presented")
            })?;
            BufferMap::new(&presented.buffer).await.map_err(|error| {
                JsValue::from_str(&format!("WebGPU surface map failed: {error}"))
            })?;
            let pixels = {
                let mapped = presented.buffer.slice(..).get_mapped_range();
                let pixels =
                    compact_surface_readback_rows(&mapped, presented.layout, presented.pixel_order);
                drop(mapped);
                presented.buffer.unmap();
                pixels.ok_or_else(|| {
                    JsValue::from_str("WebGPU surface map returned truncated rows")
                })?
            };
            ensure_renderer_healthy(&failure_state)?;

            let surface_format =
                surface_format_name(presented.surface_format).ok_or_else(|| {
                    JsValue::from_str("captured WebGPU surface format is not RGBA8/BGRA8")
                })?;
            let result = Object::new();
            for (name, value) in [
                ("format", "rgba8unorm"),
                ("surfaceFormat", surface_format),
                ("layout", "top-left-row-major-tight"),
            ] {
                Reflect::set(&result, &JsValue::from_str(name), &JsValue::from_str(value))?;
            }
            for (name, value) in [
                ("width", presented.layout.width),
                ("height", presented.layout.height),
            ] {
                Reflect::set(
                    &result,
                    &JsValue::from_str(name),
                    &JsValue::from_f64(f64::from(value)),
                )?;
            }
            Reflect::set(
                &result,
                &JsValue::from_str("presentationSerial"),
                &JsValue::from_f64(presented.presentation_serial as f64),
            )?;
            set_presented_frame_provenance(&result, &presented.provenance)?;
            Reflect::set(
                &result,
                &JsValue::from_str("rgba"),
                &Uint8Array::from(pixels.as_slice()),
            )?;
            Ok(result.into())
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn push_tev_draw(
        &mut self,
        topology: u8,
        source_vertices: Float32Array,
        source_tev_state: Uint8Array,
        texture_keys: Array,
        texture_metadata: Uint32Array,
        texture_pixels: Array,
        z_mode: u32,
        blend_mode: u32,
        alpha_test: u32,
        cull_mode: u8,
        scissor_x: u32,
        scissor_y: u32,
        scissor_width: u32,
        scissor_height: u32,
    ) -> Result<(), JsValue> {
        self.ensure_healthy()?;
        let source_vertices = source_vertices.to_vec();
        let tev_state = source_tev_state.to_vec();
        let texture_metadata = texture_metadata.to_vec();
        validate_draw_transport(
            source_vertices.len(),
            tev_state.len(),
            texture_keys.length() as usize,
            texture_metadata.len(),
            texture_pixels.length() as usize,
        )
        .map_err(|error| JsValue::from_str(&error))?;
        debug_assert_eq!(tev_state.len(), TEV_DRAW_STATE_BYTES);
        debug_assert_eq!(texture_metadata.len(), TEV_TEXTURE_METADATA_WORDS);

        let mut keys = Vec::with_capacity(MAX_TEV_TEXTURES);
        let mut pixel_storage = Vec::with_capacity(MAX_TEV_TEXTURES);
        for map in 0..MAX_TEV_TEXTURES {
            let key = texture_keys.get(map as u32).as_string().ok_or_else(|| {
                JsValue::from_str(&format!("TEV texture key {map} is not a string"))
            })?;
            let pixels_value = texture_pixels.get(map as u32);
            if !pixels_value.is_instance_of::<Uint8Array>() {
                return Err(JsValue::from_str(&format!(
                    "TEV texture pixels {map} are not a Uint8Array"
                )));
            }
            keys.push(key);
            pixel_storage.push(pixels_value.unchecked_into::<Uint8Array>().to_vec());
        }
        let textures = std::array::from_fn(|map| {
            let metadata = map * 5;
            TevTextureInput {
                key: &keys[map],
                pixels: &pixel_storage[map],
                address: texture_metadata[metadata],
                generation: texture_metadata[metadata + 1],
                width: texture_metadata[metadata + 2],
                height: texture_metadata[metadata + 3],
                sampler: texture_metadata[metadata + 4],
            }
        });
        let texture_pixel_bytes = pixel_storage.iter().map(Vec::len).sum();
        let bridge_typed_array_bytes = source_vertices
            .len()
            .saturating_mul(size_of::<f32>())
            .saturating_add(tev_state.len())
            .saturating_add(texture_metadata.len().saturating_mul(size_of::<u32>()))
            .saturating_add(texture_pixel_bytes);
        self.record_wasm_bridge_call(bridge_typed_array_bytes);
        self.push_tev_draw_inner(
            topology,
            &source_vertices,
            &tev_state,
            &textures,
            None,
            texture_pixel_bytes,
            None,
            None,
            z_mode,
            blend_mode,
            alpha_test,
            0,
            0,
            0,
            0,
            0,
            [0; 5],
            [0; 5],
            0,
            cull_mode,
            scissor_x,
            scissor_y,
            scissor_width,
            scissor_height,
        )
    }

    /// Submit one completely validated GX segment and its terminal EFB copy.
    ///
    /// Bridge telemetry records every call at entry, but parsing and resource
    /// preflight finish before rendering state changes, so a malformed Worker
    /// packet cannot leave a partial WebGPU frame behind.
    pub fn submit_gx_frame(&mut self, source_packet: Uint8Array) -> Result<Array, JsValue> {
        // Keep the existing `packetParse` diagnostic as one inclusive packet-
        // preparation phase: JS-to-Wasm copying, structural parsing, texture
        // preflight, and vertex flattening all happen before renderer mutation.
        let packet_parse_timer = self.host_phase_timer(RendererHostPhase::PacketParse);
        let packet_bytes = source_packet.to_vec();
        self.record_wasm_bridge_call(packet_bytes.len());
        let packet = GxFramePacket::parse(&packet_bytes)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let header = *packet.header();
        let payload_bytes: usize = packet.textures().map(|texture| texture.pixels.len()).sum();
        let packet_texture_keys = packet
            .textures()
            .map(|texture| texture.key)
            .collect::<HashSet<_>>();

        self.ensure_healthy()?;
        let mut source_vertices =
            Vec::with_capacity(header.total_vertex_count as usize * TEV_VERTEX_FLOATS);
        for draw in packet.draws() {
            source_vertices.extend(draw.vertex_floats());
        }
        let prepared_exact_draws = packet
            .draws()
            .map(|draw| {
                let vertex_start = draw.record.vertex_relative_offset as usize / size_of::<f32>();
                let vertex_len = draw.record.vertex_count as usize * TEV_VERTEX_FLOATS;
                prepare_exact_draw(
                    draw,
                    &source_vertices[vertex_start..vertex_start + vertex_len],
                )
            })
            .collect::<Vec<_>>();
        // Resolve every required texture before beginning the segment. Packet
        // syntax is already validated above; this preflight also makes a
        // missing resident payload fail without leaving earlier draws queued.
        for (draw, prepared_exact) in packet.draws().zip(&prepared_exact_draws) {
            if prepared_exact
                .as_ref()
                .is_some_and(PreparedExactDraw::is_authoritative_empty)
            {
                continue;
            }
            if gx_early_depth_plan(
                draw.record.z_mode,
                draw.record.blend_mode,
                draw.record.alpha_test,
                draw.record.fragment_tail.pixel_control,
            ) == GxEarlyDepthPlan::DepthOnly
            {
                continue;
            }
            for (map, slot) in draw.record.textures.iter().enumerate() {
                let Some(index) = slot.texture else {
                    continue;
                };
                let texture = packet
                    .texture(index as usize)
                    .expect("validated GX texture reference");
                let cached_dimensions = self
                    .texture_cache
                    .get(texture.key)
                    .map(|cached| (cached.width, cached.height));
                let decoded_is_valid = decoded_texture_is_available(
                    texture.record.width,
                    texture.record.height,
                    texture.pixels.len(),
                    cached_dimensions,
                )
                .map_err(|error| {
                    JsValue::from_str(&format!(
                        "TEV texture map {map} key {}: {error}",
                        texture.key
                    ))
                })?;
                require_tev_texture(
                    map,
                    true,
                    select_texture(
                        texture.record.generation,
                        self.efb_copy_cache
                            .get(&texture.record.address)
                            .map(|cached| cached.generation),
                        decoded_is_valid,
                    ),
                )
                .map_err(|error| JsValue::from_str(&error))?;
            }
        }
        drop(packet_parse_timer);
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.submit_gx_frame_calls = metrics.submit_gx_frame_calls.saturating_add(1);
            metrics.gx_frame_packet_bytes = metrics
                .gx_frame_packet_bytes
                .saturating_add(packet_bytes.len() as u64);
            metrics.gx_frame_packet_payload_bytes = metrics
                .gx_frame_packet_payload_bytes
                .saturating_add(payload_bytes as u64);
            metrics.texture_pixel_bytes = metrics
                .texture_pixel_bytes
                .saturating_add(payload_bytes as u64);
        });
        // This inclusive frame-level phase contains the draw loop, terminal
        // copy encoding, and synchronous queue submission.
        let gx_frame_execution_timer = self.host_phase_timer(RendererHostPhase::GxFrameExecution);
        let render = (|| {
            self.begin_segment_inner()?;
            for (draw, prepared_exact) in packet.draws().zip(&prepared_exact_draws) {
                let vertex_start = draw.record.vertex_relative_offset as usize / size_of::<f32>();
                let vertex_len = draw.record.vertex_count as usize * TEV_VERTEX_FLOATS;
                let draw_vertices = &source_vertices[vertex_start..vertex_start + vertex_len];
                let textures = std::array::from_fn(|map| {
                    let slot = draw.record.textures[map];
                    match slot.texture {
                        Some(index) => {
                            let texture = packet
                                .texture(index as usize)
                                .expect("validated GX texture reference");
                            TevTextureInput {
                                key: texture.key,
                                pixels: texture.pixels,
                                address: texture.record.address,
                                generation: texture.record.generation,
                                width: texture.record.width,
                                height: texture.record.height,
                                sampler: slot.sampler_bits,
                            }
                        }
                        None => TevTextureInput {
                            key: "",
                            pixels: &[],
                            address: 0,
                            generation: 0,
                            width: 0,
                            height: 0,
                            sampler: 0,
                        },
                    }
                });
                self.push_tev_draw_inner(
                    draw.record.topology,
                    draw_vertices,
                    draw.tev_state,
                    &textures,
                    Some(&packet_texture_keys),
                    0,
                    draw.record.post_cull_actions.as_deref(),
                    prepared_exact.as_ref(),
                    draw.record.z_mode,
                    draw.record.blend_mode,
                    draw.record.alpha_test,
                    draw.record.fragment_tail.pixel_control,
                    draw.record.fragment_tail.constant_alpha,
                    draw.record.fragment_tail.z_texture_bias,
                    draw.record.fragment_tail.z_texture_mode,
                    draw.record.fragment_tail.fog_range_base,
                    draw.record.fragment_tail.fog_range_k,
                    draw.record.fragment_tail.fog_words,
                    draw.record.fragment_tail.viewport_half_width_bits,
                    draw.record.cull_mode,
                    draw.record.scissor_x,
                    draw.record.scissor_y,
                    draw.record.scissor_width,
                    draw.record.scissor_height,
                )?;
            }

            match header.copy_kind {
                GxCopyKind::Texture => self.copy_texture_inner(
                    header.source_x,
                    header.source_y,
                    header.source_width,
                    header.source_height,
                    header.destination,
                    header.generation,
                    header.clear.then_some(header.copy_state),
                ),
                GxCopyKind::Xfb => self.copy_xfb_inner(
                    header.source_x,
                    header.source_y,
                    header.source_width,
                    header.source_height,
                    header.output_width,
                    header.output_height,
                    header.destination,
                    header.stride,
                    header.generation,
                    header.copy_state,
                    header.clear,
                ),
            }
        })();
        drop(gx_frame_execution_timer);
        if render.is_err() {
            self.clear_segment();
        }
        render?;
        while self.texture_cache.len() > DECODED_TEXTURE_CACHE_CAPACITY {
            let Some(key) = self.texture_cache.keys().min().cloned() else {
                break;
            };
            self.texture_cache.remove(&key);
        }
        let mut resident_keys = self.texture_cache.keys().collect::<Vec<_>>();
        resident_keys.sort_unstable();
        let resident = Array::new();
        for key in resident_keys {
            resident.push(&JsValue::from_str(key));
        }
        Ok(resident)
    }

    #[allow(clippy::too_many_arguments)]
    fn push_tev_draw_inner(
        &mut self,
        topology: u8,
        source_vertices: &[f32],
        tev_state: &[u8],
        textures: &[TevTextureInput<'_>; MAX_TEV_TEXTURES],
        packet_protected_keys: Option<&HashSet<&str>>,
        transport_texture_pixel_bytes: usize,
        managed_coverage_actions: Option<&[GxTriangleAction]>,
        prepared_exact: Option<&PreparedExactDraw>,
        z_mode: u32,
        blend_mode: u32,
        alpha_test: u32,
        pixel_control: u32,
        constant_alpha: u32,
        z_texture_bias: u32,
        z_texture_mode: u32,
        fog_range_base: u32,
        fog_range_coefficients: [u32; 5],
        fog_parameters: [u32; 5],
        viewport_half_width_bits: u32,
        cull_mode: u8,
        scissor_x: u32,
        scissor_y: u32,
        scissor_width: u32,
        scissor_height: u32,
    ) -> Result<(), JsValue> {
        // Super Monkey Ball emits millions of draws. Sample one deterministic
        // draw ordinal per stride so host clock imports cannot dominate GX.
        let sample_draw_timing = self.sample_draw_host_timing();
        let topology_expansion_timer =
            sample_draw_timing.then(|| self.host_phase_timer(RendererHostPhase::TopologyExpansion));
        let vertex_count = validate_draw_transport(
            source_vertices.len(),
            tev_state.len(),
            MAX_TEV_TEXTURES,
            TEV_TEXTURE_METADATA_WORDS,
            MAX_TEV_TEXTURES,
        )
        .map_err(|error| JsValue::from_str(&error))?;
        let expanded = expanded_indices(topology, vertex_count)
            .ok_or_else(|| JsValue::from_str("unsupported GX primitive topology"))?;
        let expanded_vertex_bytes = expanded
            .len()
            .saturating_mul(std::mem::size_of::<TevVertex>());
        drop(topology_expansion_timer);
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.record_draw_transport(
                source_vertices
                    .len()
                    .saturating_mul(std::mem::size_of::<f32>()),
                tev_state.len(),
                TEV_TEXTURE_METADATA_WORDS.saturating_mul(std::mem::size_of::<u32>()),
                transport_texture_pixel_bytes,
                expanded_vertex_bytes,
            );
        });

        let resource_preparation_timer = sample_draw_timing
            .then(|| self.host_phase_timer(RendererHostPhase::ResourcePreparation));
        if expanded.is_empty() {
            return Ok(());
        }
        let primitive = match topology {
            5 | 6 => Primitive::Lines,
            7 => Primitive::Points,
            _ => Primitive::Triangles,
        };
        let raster_position_correction = browser_raster_position_correction(pixel_control);
        let qualified_exact = prepared_exact.and_then(PreparedExactDraw::qualified);
        if qualified_exact.is_some_and(QualifiedExactDraw::is_empty) {
            // Exact clipping/culling and raw scissor qualification prove that
            // this draw contributes no fragments. Do not let legacy projected
            // geometry or scissor state resurrect it.
            return Ok(());
        }
        let early_depth = gx_early_depth_plan(z_mode, blend_mode, alpha_test, pixel_control);
        let depth_encoding = draw_depth_encoding(z_mode, pixel_control)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        if early_depth == GxEarlyDepthPlan::DepthOnly {
            let Some(scissor) =
                clipped_scissor(scissor_x, scissor_y, scissor_width, scissor_height)
            else {
                return Ok(());
            };
            if primitive_cull_mode(primitive, cull_mode) == CullMode::All {
                return Ok(());
            }
            let Some(state) =
                depth_only_command_state(primitive, z_mode, cull_mode, depth_encoding, scissor)
            else {
                // A failed fixed-function depth compare has no observable
                // fragment or depth effect, so do not enqueue a GPU no-op.
                return Ok(());
            };
            drop(resource_preparation_timer);
            return self.push_expanded_draw(
                source_vertices,
                &expanded,
                raster_position_correction,
                ManagedCoverageEvidence::None,
                None,
                state,
            );
        }

        let required_maps =
            required_texture_maps(tev_state).map_err(|error| JsValue::from_str(&error))?;
        let required_coords =
            required_texture_coords(tev_state).map_err(|error| JsValue::from_str(&error))?;
        let sampler_modes = std::array::from_fn(|map| textures[map].sampler);
        let sampler_identities = sampler_modes.map(gx_sampler_identity);
        let z_texture = gx_z_texture_state(z_texture_bias, z_texture_mode, pixel_control)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let fog = gx_fog_state(
            fog_range_base,
            fog_range_coefficients,
            fog_parameters,
            viewport_half_width_bits,
        )
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let destination_alpha =
            gx_destination_alpha_state(blend_mode, constant_alpha, pixel_control);
        let mut pipeline = PipelineKey::from_gx(
            primitive,
            z_mode,
            blend_mode,
            destination_alpha,
            z_texture,
            cull_mode,
        )
        .color_pipeline_for_early_depth(early_depth);
        let source_cull = pipeline.cull;
        let native_scissor = clipped_scissor(scissor_x, scissor_y, scissor_width, scissor_height);
        let raster_center = gx_raster_center_evidence(pixel_control);
        let exact_managed = qualified_exact.filter(|exact| {
            let Some(scissor) = exact.scissor else {
                return false;
            };
            source_cull != CullMode::All
                && managed_coverage_draw_is_safe(
                    ManagedCoverageEvidence::TrustedExactClip,
                    primitive,
                    raster_center,
                    early_depth,
                    required_maps,
                    required_coords,
                    sampler_modes,
                    sampler_identities,
                    fog,
                    z_texture,
                    &exact.vertices,
                    &exact.expanded,
                    scissor,
                )
        });
        let managed_expanded = prepared_exact
            .is_none()
            .then(|| {
                let scissor = native_scissor?;
                let post_cull = (source_cull != CullMode::All
                    && managed_coverage_actions.is_some()
                    && primitive == Primitive::Triangles
                    && raster_center == GxRasterCenterEvidence::KnownNonAntialiased
                    && early_depth == GxEarlyDepthPlan::FixedFunction
                    && fog == GxFogState::default()
                    && z_texture.operation == GxZTextureOperation::Disabled)
                    .then(|| managed_post_cull_indices(&expanded, managed_coverage_actions))
                    .flatten()?;
                managed_coverage_draw_is_safe(
                    ManagedCoverageEvidence::TrustedPostCull,
                    primitive,
                    raster_center,
                    early_depth,
                    required_maps,
                    required_coords,
                    sampler_modes,
                    sampler_identities,
                    fog,
                    z_texture,
                    source_vertices,
                    &post_cull,
                    scissor,
                )
                .then_some(post_cull)
            })
            .flatten();
        let managed_evidence = if exact_managed.is_some() {
            ManagedCoverageEvidence::TrustedExactClip
        } else if managed_expanded.is_some() {
            ManagedCoverageEvidence::TrustedPostCull
        } else {
            ManagedCoverageEvidence::None
        };
        let managed_coverage = managed_evidence != ManagedCoverageEvidence::None;
        let scissor = if let Some(exact) = exact_managed {
            exact
                .scissor
                .expect("nonempty exact geometry has a raw-derived scissor")
        } else {
            let Some(scissor) = native_scissor else {
                return Ok(());
            };
            scissor
        };
        if managed_coverage {
            pipeline = pipeline.with_managed_coverage();
        }
        let fog = if pipeline.blend.color_write {
            fog
        } else {
            GxFogState::default()
        };
        let draw_uniform = DrawUniform::from_gx(
            alpha_test,
            destination_alpha,
            z_texture,
            depth_encoding,
            pipeline.canonical_fragment_depth,
            fog,
        )
        .with_sampler_modes(sampler_modes);
        if pipeline.cull == CullMode::All {
            return Ok(());
        }

        let mut selected = [SelectedTexture::White; MAX_TEV_TEXTURES];
        for map in 0..MAX_TEV_TEXTURES {
            if !required_maps[map] {
                continue;
            }
            let input = &textures[map];
            let cached_dimensions = self
                .texture_cache
                .get(input.key)
                .map(|texture| (texture.width, texture.height));
            let decoded_is_valid = decoded_texture_is_available(
                input.width,
                input.height,
                input.pixels.len(),
                cached_dimensions,
            )
            .map_err(|error| {
                JsValue::from_str(&format!("TEV texture map {map} key {}: {error}", input.key))
            })?;
            selected[map] = require_tev_texture(
                map,
                true,
                select_texture(
                    input.generation,
                    self.efb_copy_cache
                        .get(&input.address)
                        .map(|texture| texture.generation),
                    decoded_is_valid,
                ),
            )
            .map_err(|error| JsValue::from_str(&error))?;
        }

        let protected_keys = selected
            .iter()
            .enumerate()
            .filter(|(_, selected)| **selected == SelectedTexture::Decoded)
            .map(|(map, _)| textures[map].key)
            .collect::<HashSet<_>>();
        for map in 0..MAX_TEV_TEXTURES {
            if selected[map] != SelectedTexture::Decoded
                || self.texture_cache.contains_key(textures[map].key)
            {
                continue;
            }
            let input = &textures[map];
            let texture = self.upload_texture(
                &format!("GX TEV texture {}", input.key),
                input.width,
                input.height,
                input.pixels,
                0,
            )?;
            if self.texture_cache.len() >= DECODED_TEXTURE_CACHE_CAPACITY
                && let Some(key) = self
                    .texture_cache
                    .keys()
                    .filter(|key| {
                        !protected_keys.contains(key.as_str())
                            && packet_protected_keys
                                .is_none_or(|packet| !packet.contains(key.as_str()))
                    })
                    .min()
                    .cloned()
            {
                self.texture_cache.remove(&key);
            }
            self.texture_cache.insert(input.key.to_owned(), texture);
        }

        let texture_identities = std::array::from_fn(|map| {
            let input = &textures[map];
            match selected[map] {
                SelectedTexture::EfbCopy => TextureBindingIdentity::EfbCopy {
                    address: input.address,
                    generation: input.generation,
                },
                SelectedTexture::Decoded => TextureBindingIdentity::Decoded(input.key.to_owned()),
                SelectedTexture::White => TextureBindingIdentity::White,
            }
        });
        let binding_key = TevBindingKey {
            textures: texture_identities,
            samplers: sampler_identities,
            state: tev_state.to_vec(),
            draw: draw_uniform,
        };
        let binding = if let Some(binding) = self.tev_draw_binding_indices.get(&binding_key) {
            *binding
        } else {
            let draw_uniform = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("browser GX TEV draw state"),
                    contents: bytemuck::bytes_of(&binding_key.draw),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
            let draw_bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("browser GX TEV draw-state bind group"),
                layout: &self.tev_draw_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 2,
                    resource: draw_uniform.as_entire_binding(),
                }],
            });
            let tev_uniform = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("browser GX per-fragment TEV state"),
                    contents: tev_state,
                    usage: wgpu::BufferUsages::UNIFORM,
                });
            let texture_views = (0..MAX_TEV_TEXTURES)
                .map(|map| match selected[map] {
                    SelectedTexture::EfbCopy => &self.efb_copy_cache[&textures[map].address].view,
                    SelectedTexture::Decoded => &self.texture_cache[textures[map].key].view,
                    SelectedTexture::White => &self.white_texture.view,
                })
                .collect::<Vec<_>>();
            let samplers = sampler_identities.map(|identity| &self.samplers[&identity]);
            let mut entries = Vec::with_capacity(1 + MAX_TEV_TEXTURES * 2);
            entries.push(wgpu::BindGroupEntry {
                binding: 0,
                resource: tev_uniform.as_entire_binding(),
            });
            for (map, view) in texture_views.into_iter().enumerate() {
                entries.push(wgpu::BindGroupEntry {
                    binding: map as u32 + 1,
                    resource: wgpu::BindingResource::TextureView(view),
                });
            }
            for (map, sampler) in samplers.into_iter().enumerate() {
                entries.push(wgpu::BindGroupEntry {
                    binding: map as u32 + 9,
                    resource: wgpu::BindingResource::Sampler(sampler),
                });
            }
            let tev_bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("browser GX per-fragment TEV bind group"),
                layout: &self.tev_texture_layout,
                entries: &entries,
            });
            update_renderer_metrics(&self.metrics, |metrics| {
                metrics.buffers_created = metrics.buffers_created.saturating_add(2);
                metrics.bind_groups_created = metrics.bind_groups_created.saturating_add(2);
            });
            let binding = self.tev_draw_bindings.len();
            self.tev_draw_bindings.push(CachedTevDrawBinding {
                _draw_uniform: draw_uniform,
                draw_bind_group,
                _tev_uniform: tev_uniform,
                tev_bind_group,
            });
            self.tev_draw_binding_indices.insert(binding_key, binding);
            binding
        };
        let depth_commit = (early_depth == GxEarlyDepthPlan::PrimitiveOrdered).then_some(
            DepthCommitPipelineKey::from_pipeline(pipeline, depth_encoding),
        );
        let pipeline = Some(pipeline);
        let binding = Some(binding);
        let state = DrawCommandState {
            pipeline,
            depth_commit,
            early_depth,
            scissor,
            binding,
        };
        drop(resource_preparation_timer);
        let (draw_vertices, draw_expanded, raster_position_correction) =
            if let Some(exact) = exact_managed {
                (exact.vertices.as_slice(), exact.expanded.as_slice(), 0.0)
            } else if let Some(post_cull) = managed_expanded.as_deref() {
                (source_vertices, post_cull, 0.0)
            } else {
                (
                    source_vertices,
                    expanded.as_slice(),
                    raster_position_correction,
                )
            };
        self.push_expanded_draw(
            draw_vertices,
            draw_expanded,
            raster_position_correction,
            managed_evidence,
            managed_coverage_texture_coord(required_coords).flatten(),
            state,
        )
    }

    fn push_expanded_draw(
        &mut self,
        source_vertices: &[f32],
        expanded: &[usize],
        raster_position_correction: f32,
        managed_coverage_evidence: ManagedCoverageEvidence,
        managed_texture_coord: Option<usize>,
        state: DrawCommandState,
    ) -> Result<(), JsValue> {
        let start = self.tev_vertices.len() as u32;
        let mut managed_triangles = 0_u64;
        if managed_coverage_evidence != ManagedCoverageEvidence::None {
            for triangle in expanded.chunks_exact(3) {
                let vertices = managed_coverage_triangle_vertices(
                    source_vertices,
                    [triangle[0], triangle[1], triangle[2]],
                    managed_texture_coord,
                    state.scissor,
                )
                .map_err(|error| JsValue::from_str(&error.to_string()))?;
                if let Some(vertices) = vertices {
                    self.tev_vertices.extend(vertices);
                    managed_triangles = managed_triangles.saturating_add(1);
                }
            }
        } else {
            for index in expanded {
                self.tev_vertices.push(tev_vertex_from_source(
                    source_vertices,
                    *index,
                    raster_position_correction,
                ));
            }
        }
        let end = self.tev_vertices.len() as u32;
        if start == end {
            return Ok(());
        }
        if managed_coverage_evidence != ManagedCoverageEvidence::None {
            update_renderer_metrics(&self.metrics, |metrics| {
                metrics.managed_coverage_draws = metrics.managed_coverage_draws.saturating_add(1);
                metrics.managed_coverage_triangles = metrics
                    .managed_coverage_triangles
                    .saturating_add(managed_triangles);
            });
        }
        let vertices = start..end;
        if let Some(previous) = self.commands.last_mut()
            && merge_contiguous_draw_range(
                &mut previous.vertices,
                &previous.state,
                vertices.clone(),
                &state,
            )
        {
            return Ok(());
        }
        self.commands.push(DrawCommand { vertices, state });
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn copy_texture(
        &mut self,
        source_x: u32,
        source_y: u32,
        width: u32,
        height: u32,
        destination: u32,
        generation: u32,
        clear: bool,
        z_mode: u32,
        blend_mode: u32,
        pixel_control: u32,
        clear_red: u8,
        clear_green: u8,
        clear_blue: u8,
        clear_alpha: u8,
        clear_depth: u32,
    ) -> Result<(), JsValue> {
        self.record_wasm_bridge_call(0);
        let copy_clear = public_copy_clear_state(
            clear,
            z_mode,
            blend_mode,
            pixel_control,
            if clear { 0x0800 } else { 0 },
            [clear_red, clear_green, clear_blue, clear_alpha],
            clear_depth,
        )?;
        self.copy_texture_inner(
            source_x,
            source_y,
            width,
            height,
            destination,
            generation,
            copy_clear,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn copy_texture_inner(
        &mut self,
        source_x: u32,
        source_y: u32,
        width: u32,
        height: u32,
        destination: u32,
        generation: u32,
        copy_clear: Option<GxCopyState>,
    ) -> Result<(), JsValue> {
        self.ensure_healthy()?;
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.copy_texture_calls = metrics.copy_texture_calls.saturating_add(1);
        });
        let mut encoder = self.flush_geometry();
        let Some((width, height)) = clipped_copy_extent(source_x, source_y, width, height) else {
            self.queue.submit([encoder.finish()]);
            update_renderer_metrics(&self.metrics, |metrics| {
                metrics.queue_submissions = metrics.queue_submissions.saturating_add(1);
            });
            return self.ensure_healthy();
        };
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("browser EFB texture copy"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.textures_created = metrics.textures_created.saturating_add(1);
        });
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.efb_color,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: source_x,
                    y: source_y,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        if let Some(state) = copy_clear {
            update_renderer_metrics(&self.metrics, |metrics| {
                metrics.clear_efb_calls = metrics.clear_efb_calls.saturating_add(1);
            });
            self.encode_copy_clear(
                &mut encoder,
                ScissorRect {
                    x: source_x,
                    y: source_y,
                    width,
                    height,
                },
                state,
            )?;
        }
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.queue.submit([encoder.finish()]);
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.queue_submissions = metrics.queue_submissions.saturating_add(1);
        });
        self.efb_copy_cache.insert(
            destination,
            CachedTexture {
                _texture: texture,
                view,
                generation,
                width,
                height,
            },
        );
        while self.efb_copy_cache.len() > 64 {
            let Some(address) = self
                .efb_copy_cache
                .iter()
                .filter(|(address, _)| **address != destination)
                .min_by_key(|(address, texture)| (texture.generation, **address))
                .map(|(address, _)| *address)
            else {
                break;
            };
            self.efb_copy_cache.remove(&address);
        }
        self.ensure_healthy()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn copy_xfb(
        &mut self,
        source_x: u32,
        source_y: u32,
        width: u32,
        source_height: u32,
        xfb_width: u32,
        xfb_height: u32,
        destination: u32,
        stride: u32,
        generation: u32,
        clear: bool,
        z_mode: u32,
        blend_mode: u32,
        pixel_control: u32,
        clear_red: u8,
        clear_green: u8,
        clear_blue: u8,
        clear_alpha: u8,
        clear_depth: u32,
    ) -> Result<(), JsValue> {
        self.record_wasm_bridge_call(0);
        let copy_command = if clear { 0x4800 } else { 0x4000 };
        let mut copy_state = public_copy_clear_state(
            clear,
            z_mode,
            blend_mode,
            pixel_control,
            copy_command,
            [clear_red, clear_green, clear_blue, clear_alpha],
            clear_depth,
        )?
        .unwrap_or(GxCopyState {
            z_mode,
            blend_mode,
            pixel_control,
            copy_command,
            clear_rgba: [clear_red, clear_green, clear_blue, clear_alpha],
            clear_depth,
            copy_scale: 256,
            copy_filter: GX_IDENTITY_COPY_FILTER,
        });
        copy_state.copy_scale = 256;
        copy_state.copy_filter = GX_IDENTITY_COPY_FILTER;
        self.copy_xfb_inner(
            source_x,
            source_y,
            width,
            source_height,
            xfb_width,
            xfb_height,
            destination,
            stride,
            generation,
            copy_state,
            clear,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn copy_xfb_inner(
        &mut self,
        source_x: u32,
        source_y: u32,
        width: u32,
        source_height: u32,
        xfb_width: u32,
        xfb_height: u32,
        destination: u32,
        stride: u32,
        generation: u32,
        copy_state: GxCopyState,
        clear: bool,
    ) -> Result<(), JsValue> {
        self.ensure_healthy()?;
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.copy_xfb_calls = metrics.copy_xfb_calls.saturating_add(1);
        });
        if xfb_width == 0
            || xfb_height == 0
            || xfb_width > GX_MAX_COPY_DIMENSION
            || xfb_height > GX_MAX_COPY_DIMENSION
        {
            return Err(JsValue::from_str(&format!(
                "GX XFB output {xfb_width}x{xfb_height} exceeds the nonempty {GX_MAX_COPY_DIMENSION}x{GX_MAX_COPY_DIMENSION} GX limit"
            )));
        }
        let maximum_texture_dimension = self.device.limits().max_texture_dimension_2d;
        if xfb_width > maximum_texture_dimension || xfb_height > maximum_texture_dimension {
            return Err(JsValue::from_str(&format!(
                "GX XFB output {xfb_width}x{xfb_height} exceeds WebGPU's {maximum_texture_dimension}px texture limit"
            )));
        }
        let expected_height = gx_xfb_output_height(
            source_height,
            copy_state.copy_command,
            copy_state.copy_scale,
        )
        .ok_or_else(|| JsValue::from_str("GX XFB copy scale does not produce a valid height"))?;
        if xfb_height != expected_height {
            return Err(JsValue::from_str(&format!(
                "GX XFB copy height {xfb_height} does not match copy-scale materialization {expected_height}"
            )));
        }
        let parameters = gx_xfb_copy_parameters(copy_state);
        match parameters.source_format {
            GxEfbFormat::Rgb8Z24 | GxEfbFormat::Rgba6Z24 | GxEfbFormat::Rgb565Z16 => {}
            GxEfbFormat::Z24 => {
                return Err(JsValue::from_str(
                    "GX Z24 EFB-to-XFB copies require the WebGPU depth-copy pipeline",
                ));
            }
            GxEfbFormat::OtherNoAlpha => {
                return Err(JsValue::from_str(
                    "GX component/YUV EFB-to-XFB copies require untransported PE CMode1 state",
                ));
            }
        }
        let mut encoder = self.flush_geometry();
        let Some((width, source_height)) =
            clipped_copy_extent(source_x, source_y, width, source_height)
        else {
            self.queue.submit([encoder.finish()]);
            update_renderer_metrics(&self.metrics, |metrics| {
                metrics.queue_submissions = metrics.queue_submissions.saturating_add(1);
            });
            return self.ensure_healthy();
        };
        let mut protected_surfaces = HashSet::with_capacity(3);
        if let Some(pending) = self.vi_field_pairs.pending() {
            protected_surfaces.insert(pending.payload.id);
        }
        if let Some(presented) = self.last_presented_xfb.as_ref() {
            protected_surfaces.extend(
                presented
                    .top
                    .iter()
                    .chain(presented.bottom.iter())
                    .map(|field| field.surface_id),
            );
        }
        let mut surfaces = Vec::with_capacity(XFB_SURFACES_PER_DESTINATION);
        if let Some(cached) = self.xfb_cache.remove(&destination) {
            surfaces.push(cached.surface);
            surfaces.extend(cached.spares);
        }
        let surface_descriptors = surfaces
            .iter()
            .map(|surface| (surface.id, surface.width, surface.height))
            .collect::<Vec<_>>();
        let protected_surface_ids = protected_surfaces.into_iter().collect::<Vec<_>>();
        let reusable = reusable_xfb_surface_index(
            &surface_descriptors,
            &protected_surface_ids,
            xfb_width,
            xfb_height,
        );
        let surface = reusable.map_or_else(
            || self.create_xfb_surface(xfb_width, xfb_height),
            |index| surfaces.remove(index),
        );
        let spares = surfaces
            .into_iter()
            .filter(|candidate| {
                xfb_surface_extent_matches(candidate.width, candidate.height, xfb_width, xfb_height)
            })
            .take(XFB_SURFACES_PER_DESTINATION - 1)
            .collect();
        let linear_filter = parameters.uses_linear_filter();
        let uniform = XfbCopyUniform::new(source_x, source_y, width, source_height, parameters);
        self.queue
            .write_buffer(&self.xfb_copy.uniform, 0, bytemuck::bytes_of(&uniform));
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("browser GX EFB-to-XFB materialization pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &surface.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.xfb_copy.pipeline);
            pass.set_bind_group(
                0,
                if linear_filter {
                    &self.xfb_copy.linear_bind_group
                } else {
                    &self.xfb_copy.nearest_bind_group
                },
                &[],
            );
            pass.draw(0..3, 0..1);
        }
        if clear {
            update_renderer_metrics(&self.metrics, |metrics| {
                metrics.clear_efb_calls = metrics.clear_efb_calls.saturating_add(1);
            });
            self.encode_copy_clear(
                &mut encoder,
                ScissorRect {
                    x: source_x,
                    y: source_y,
                    width,
                    height: source_height,
                },
                copy_state,
            )?;
        }
        self.queue.submit([encoder.finish()]);
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.queue_submissions = metrics.queue_submissions.saturating_add(1);
        });
        self.xfb_cache.insert(
            destination,
            CachedXfb {
                surface,
                spares,
                metadata: XfbCopyMetadata {
                    destination,
                    stride,
                    height: xfb_height,
                    generation,
                },
                output_width: xfb_width,
                output_height: xfb_height,
            },
        );
        if self.xfb_cache.len() > 16
            && let Some(address) = self
                .xfb_cache
                .iter()
                .min_by_key(|(address, copy)| (copy.metadata.generation, **address))
                .map(|(address, _)| *address)
        {
            self.xfb_cache.remove(&address);
        }
        self.ensure_healthy()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn present_xfb(
        &mut self,
        selected_address: u32,
        expected_generation: u32,
        selected_row: u32,
        presentation_mode: &str,
        field_parity: &str,
        pair_epoch: u32,
        output_width: u32,
        output_height: u32,
        field_stride_bytes: u32,
        field_height: u32,
        row_repeat: u32,
        capture_surface: bool,
    ) -> Result<Object, JsValue> {
        self.record_wasm_bridge_call(0);
        self.ensure_healthy()?;
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.present_xfb_calls = metrics.present_xfb_calls.saturating_add(1);
        });
        if pair_epoch == 0 {
            return xfb_presentation_result(
                false,
                false,
                "vi-field-invalid-epoch",
                pair_epoch,
                None,
            );
        }
        let Some(mode) = vi_presentation_mode(presentation_mode) else {
            return xfb_presentation_result(
                false,
                false,
                "vi-field-invalid-mode",
                pair_epoch,
                None,
            );
        };
        let Some(parity) = vi_field_parity(field_parity) else {
            return xfb_presentation_result(
                false,
                false,
                "vi-field-invalid-parity",
                pair_epoch,
                None,
            );
        };
        if selected_address == 0 || expected_generation == 0 {
            return xfb_presentation_result(
                false,
                false,
                "vi-field-xfb-unavailable",
                pair_epoch,
                None,
            );
        }
        let Some((surface, metadata, cached_width, cached_height)) = self
            .xfb_cache
            .values()
            .find(|copy| {
                xfb_copy_matches_selection(
                    copy.metadata,
                    selected_address,
                    expected_generation,
                    selected_row,
                )
            })
            .map(|copy| {
                (
                    copy.surface.clone(),
                    copy.metadata,
                    copy.output_width,
                    copy.output_height,
                )
            })
        else {
            return xfb_presentation_result(
                false,
                false,
                "vi-field-xfb-unavailable",
                pair_epoch,
                None,
            );
        };
        if output_width == 0
            || output_width > GX_MAX_COPY_DIMENSION
            || output_height == 0
            || output_height > GX_MAX_COPY_DIMENSION
            || output_width != cached_width
        {
            return xfb_presentation_result(
                false,
                false,
                "vi-field-invalid-geometry",
                pair_epoch,
                None,
            );
        }
        let Some(scanout) = xfb_scanout_plan(
            metadata,
            selected_row,
            field_stride_bytes,
            field_height,
            row_repeat,
            output_height,
        ) else {
            return xfb_presentation_result(
                false,
                false,
                "vi-field-invalid-geometry",
                pair_epoch,
                None,
            );
        };
        let descriptor = ViFieldDescriptor {
            mode,
            pair_epoch,
            parity,
            copy: metadata,
            selected_address,
            selected_generation: expected_generation,
            selected_row,
            source_width: cached_width,
            source_height: cached_height,
            display_width: output_width,
            scanout,
        };
        let outcome = self.vi_field_pairs.submit(descriptor, surface);
        let status = outcome.telemetry_code();
        match outcome {
            ViFieldPairOutcome::Awaiting(_) => {
                xfb_presentation_result(true, false, status, pair_epoch, None)
            }
            ViFieldPairOutcome::Rejected(_) => {
                xfb_presentation_result(false, false, status, pair_epoch, None)
            }
            ViFieldPairOutcome::Ready(frame) => {
                let ready_epoch = frame.pair_epoch();
                let presentation_serial = self.present_host_xfb_frame(frame, capture_surface)?;
                xfb_presentation_result(true, true, status, ready_epoch, Some(presentation_serial))
            }
        }
    }
}

impl WebGpuRenderer {
    fn present_host_xfb_frame(
        &mut self,
        frame: ViHostFrame<CachedXfbSurface>,
        capture_surface: bool,
    ) -> Result<u64, JsValue> {
        let pair_epoch = frame.pair_epoch();
        let (mode, top, bottom) = match frame {
            ViHostFrame::Immediate(field) => {
                let mode = field.descriptor.mode;
                match field.descriptor.parity {
                    ViFieldParity::Top => (mode, Some(field), None),
                    ViFieldParity::Bottom => (mode, None, Some(field)),
                }
            }
            ViHostFrame::Interlaced { top, bottom, .. } => {
                (ViPresentationMode::Interlaced, Some(top), Some(bottom))
            }
        };
        let primary = top
            .as_ref()
            .or(bottom.as_ref())
            .ok_or_else(|| JsValue::from_str("ready WebGPU VI frame has no source field"))?;
        let shader_top = if mode == ViPresentationMode::Interlaced {
            top.as_ref()
                .ok_or_else(|| JsValue::from_str("paired WebGPU VI frame has no top field"))?
        } else {
            primary
        };
        let shader_bottom = if mode == ViPresentationMode::Interlaced {
            bottom
                .as_ref()
                .ok_or_else(|| JsValue::from_str("paired WebGPU VI frame has no bottom field"))?
        } else {
            primary
        };
        let output_width = primary.descriptor.display_width;
        let output_height = primary.descriptor.scanout.display_height;
        let uniform = XfbPresentUniform::new(
            primary.descriptor.source_width,
            primary.descriptor.source_height,
            output_width,
            shader_top.descriptor.scanout,
            shader_bottom.descriptor.scanout,
            mode == ViPresentationMode::Interlaced,
        );
        let present_bind_group =
            self.xfb_present_bind_group(&shader_top.payload, &shader_bottom.payload);
        self.resize_surface(output_width, output_height);
        let capture_plan = requested_surface_readback_layout(
            capture_surface,
            surface_pixel_order(self.surface_config.format),
            output_width,
            output_height,
        )
        .map_err(|error| surface_readback_error(error, self.surface_config.format))?;
        let next_presentation_serial = self
            .presentation_serial
            .checked_add(1)
            .filter(|serial| *serial <= 9_007_199_254_740_991)
            .ok_or_else(|| JsValue::from_str("WebGPU presentation serial exhausted"))?;
        let output = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(output)
            | wgpu::CurrentSurfaceTexture::Suboptimal(output) => output,
            wgpu::CurrentSurfaceTexture::Timeout => {
                return Err(JsValue::from_str("WebGPU surface acquisition timed out"));
            }
            wgpu::CurrentSurfaceTexture::Occluded => {
                return Err(JsValue::from_str("WebGPU surface is occluded"));
            }
            wgpu::CurrentSurfaceTexture::Outdated => {
                return Err(JsValue::from_str("WebGPU surface is outdated"));
            }
            wgpu::CurrentSurfaceTexture::Lost => {
                return Err(JsValue::from_str("WebGPU surface was lost"));
            }
            wgpu::CurrentSurfaceTexture::Validation => {
                return Err(JsValue::from_str("WebGPU surface validation failed"));
            }
        };
        let output_view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        self.queue
            .write_buffer(&self.xfb_present.uniform, 0, bytemuck::bytes_of(&uniform));
        let presented_top = top.as_ref().map(presented_xfb_field);
        let presented_bottom = bottom.as_ref().map(presented_xfb_field);
        let provenance = PresentedFrameProvenance {
            pair_epoch,
            mode,
            top: presented_top.as_ref().map(PresentedXfbField::provenance),
            bottom: presented_bottom.as_ref().map(PresentedXfbField::provenance),
            display_width: output_width,
            display_height: output_height,
        };
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("browser XFB paired presentation encoder"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("browser XFB paired presentation pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &output_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipelines.present);
            pass.set_bind_group(0, &present_bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        let surface_capture = capture_plan.map(|(layout, pixel_order)| {
            let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("browser presented surface readback"),
                size: layout.buffer_bytes,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            encoder.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo {
                    texture: &output.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyBufferInfo {
                    buffer: &buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(layout.padded_bytes_per_row),
                        rows_per_image: None,
                    },
                },
                wgpu::Extent3d {
                    width: layout.width,
                    height: layout.height,
                    depth_or_array_layers: 1,
                },
            );
            PresentedSurface {
                buffer,
                layout,
                pixel_order,
                surface_format: self.surface_config.format,
                presentation_serial: next_presentation_serial,
                provenance: provenance.clone(),
            }
        });
        self.queue.submit([encoder.finish()]);
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.queue_submissions = metrics.queue_submissions.saturating_add(1);
        });
        output.present();
        self.ensure_healthy()?;
        self.presentation_serial = next_presentation_serial;
        self.last_presented_surface = surface_capture;
        self.last_presented_xfb = Some(PresentedXfb {
            presentation_serial: next_presentation_serial,
            provenance,
            top: presented_top,
            bottom: presented_bottom,
        });
        Ok(next_presentation_serial)
    }

    fn xfb_present_bind_group(
        &mut self,
        top: &CachedXfbSurface,
        bottom: &CachedXfbSurface,
    ) -> wgpu::BindGroup {
        if let Some(index) = self.xfb_present.bindings.iter().position(|binding| {
            binding.top_surface_id == top.id && binding.bottom_surface_id == bottom.id
        }) {
            let binding = self
                .xfb_present
                .bindings
                .remove(index)
                .expect("located WebGPU XFB presentation binding disappeared");
            let result = binding.bind_group.clone();
            self.xfb_present.bindings.push_back(binding);
            return result;
        }
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("browser XFB paired presentation bind group"),
            layout: &self.present_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&top.view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&bottom.view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: self.xfb_present.uniform.as_entire_binding(),
                },
            ],
        });
        if self.xfb_present.bindings.len() == XFB_PRESENT_BIND_GROUP_CACHE_CAPACITY {
            self.xfb_present.bindings.pop_front();
        }
        self.xfb_present
            .bindings
            .push_back(CachedXfbPresentBinding {
                top_surface_id: top.id,
                bottom_surface_id: bottom.id,
                bind_group: bind_group.clone(),
            });
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.bind_groups_created = metrics.bind_groups_created.saturating_add(1);
        });
        bind_group
    }

    async fn create_inner(canvas: HtmlCanvasElement) -> Result<Self, String> {
        let descriptor = wgpu::InstanceDescriptor {
            backends: wgpu::Backends::BROWSER_WEBGPU,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        };
        let instance = wgpu::Instance::new(descriptor);
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
            .map_err(|error| format!("failed to create WebGPU canvas surface: {error}"))?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: Some(&surface),
            })
            .await
            .map_err(|error| format!("WebGPU is required: {error}"))?;
        let required_features = REQUIRED_WEBGPU_FEATURES;
        if !adapter.features().contains(required_features) {
            return Err(
                "WebGPU dual-source blending and depth clip control are required for exact GX destination alpha and Z-texture depth; this adapter exposes no compatible feature set and Lazuli has no rendering fallback"
                    .to_owned(),
            );
        }
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("Lazuli browser WebGPU device"),
                required_features,
                required_limits: wgpu::Limits::defaults().using_resolution(adapter.limits()),
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            })
            .await
            .map_err(|error| {
                format!(
                    "failed to create the required dual-source-blending and depth-clip-control WebGPU device; exact GX destination alpha and Z-texture depth have no fallback: {error}"
                )
            })?;
        let failure_state = RendererFailureState::default();
        let uncaptured_failure_state = failure_state.clone();
        device.on_uncaptured_error(Arc::new(move |error| {
            uncaptured_failure_state.record(format!("uncaptured WebGPU error: {error}"));
        }));
        let lost_failure_state = failure_state.clone();
        device.set_device_lost_callback(move |reason, message| {
            let message = message.trim();
            let detail = if message.is_empty() {
                format!("WebGPU device lost ({reason:?})")
            } else {
                format!("WebGPU device lost ({reason:?}): {message}")
            };
            lost_failure_state.record(detail);
        });
        let capabilities = surface.get_capabilities(&adapter);
        let surface_format = capabilities
            .formats
            .iter()
            .copied()
            .find(wgpu::TextureFormat::is_srgb)
            .or_else(|| capabilities.formats.first().copied())
            .ok_or_else(|| "WebGPU canvas surface exposes no texture formats".to_owned())?;
        let present_mode = capabilities
            .present_modes
            .iter()
            .copied()
            .find(|mode| *mode == wgpu::PresentMode::Fifo)
            .ok_or_else(|| "WebGPU canvas surface does not support FIFO presentation".to_owned())?;
        let alpha_mode = capabilities
            .alpha_modes
            .iter()
            .copied()
            .find(|mode| *mode == wgpu::CompositeAlphaMode::Opaque)
            .or_else(|| capabilities.alpha_modes.first().copied())
            .ok_or_else(|| "WebGPU canvas surface exposes no alpha modes".to_owned())?;
        let surface_config = wgpu::SurfaceConfiguration {
            // wgpu 29's WebSurface advertises only RENDER_ATTACHMENT even
            // though its browser configure path forwards these usage bits to
            // GPUCanvasContext. COPY_SRC is a mandatory WebGPU contract for
            // Lazuli's presented-surface oracle; initialization fails rather
            // than falling back if the browser rejects it.
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            format: surface_format,
            width: canvas.width().max(1),
            height: canvas.height().max(1),
            present_mode,
            desired_maximum_frame_latency: 2,
            alpha_mode,
            view_formats: vec![],
        };
        surface.configure(&device, &surface_config);

        let efb_color = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("browser EFB color"),
            size: wgpu::Extent3d {
                width: EFB_WIDTH,
                height: EFB_HEIGHT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let efb_color_view = efb_color.create_view(&wgpu::TextureViewDescriptor::default());
        let efb_depth = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("browser EFB depth"),
            size: wgpu::Extent3d {
                width: EFB_WIDTH,
                height: EFB_HEIGHT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth32Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let efb_depth_view = efb_depth.create_view(&wgpu::TextureViewDescriptor::default());

        let tev_draw_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("browser GX per-fragment TEV draw layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let mut tev_texture_layout_entries = Vec::with_capacity(1 + MAX_TEV_TEXTURES * 2);
        tev_texture_layout_entries.push(wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        });
        for map in 0..MAX_TEV_TEXTURES {
            tev_texture_layout_entries.push(wgpu::BindGroupLayoutEntry {
                binding: map as u32 + 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            });
        }
        for map in 0..MAX_TEV_TEXTURES {
            tev_texture_layout_entries.push(wgpu::BindGroupLayoutEntry {
                binding: map as u32 + 9,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            });
        }
        let tev_texture_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("browser GX per-fragment TEV layout"),
                entries: &tev_texture_layout_entries,
            });
        let present_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("browser XFB presentation layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let samplers = create_samplers(&device);
        let copy_clear = create_copy_clear_resources(&device);
        let xfb_copy = create_xfb_copy_resources(&device, &efb_color_view, &samplers);
        let xfb_present = create_xfb_present_resources(&device);
        let pipelines = create_pipelines(
            &device,
            &tev_draw_layout,
            &tev_texture_layout,
            &present_layout,
            surface_format,
        );

        let white_texture = upload_texture(
            &device,
            &queue,
            "browser solid white texture",
            1,
            1,
            &[255, 255, 255, 255],
            0,
        )?;
        let renderer = Self {
            canvas,
            surface,
            device,
            queue,
            failure_state,
            metrics: Rc::new(Cell::new(RendererMetrics::default())),
            host_timings: Rc::new(Cell::new(RendererHostTimings::default())),
            draw_timing_eligible_calls: Cell::new(0),
            surface_config,
            efb_color,
            efb_color_view,
            _efb_depth: efb_depth,
            efb_depth_view,
            copy_clear,
            xfb_copy,
            xfb_present,
            tev_draw_layout,
            tev_texture_layout,
            present_layout,
            samplers,
            white_texture,
            texture_cache: HashMap::new(),
            efb_copy_cache: HashMap::new(),
            xfb_cache: HashMap::new(),
            vi_field_pairs: ViFieldPairState::default(),
            last_presented_xfb: None,
            last_presented_surface: None,
            presentation_serial: 0,
            next_xfb_surface_id: 1,
            pipelines,
            tev_vertices: Vec::new(),
            commands: Vec::new(),
            tev_draw_binding_indices: HashMap::new(),
            tev_draw_bindings: Vec::new(),
        };
        renderer
            .reset_efb_inner()
            .map_err(|error| error.as_string().unwrap_or_else(|| format!("{error:?}")))?;
        Ok(renderer)
    }

    fn upload_texture(
        &self,
        label: &str,
        width: u32,
        height: u32,
        pixels: &[u8],
        generation: u32,
    ) -> Result<CachedTexture, JsValue> {
        let texture = upload_texture(
            &self.device,
            &self.queue,
            label,
            width,
            height,
            pixels,
            generation,
        )
        .map_err(|error| JsValue::from_str(&error))?;
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.textures_created = metrics.textures_created.saturating_add(1);
            metrics.texture_writes = metrics.texture_writes.saturating_add(1);
            metrics.texture_upload_bytes = metrics
                .texture_upload_bytes
                .saturating_add(pixels.len() as u64);
        });
        Ok(texture)
    }

    fn create_xfb_surface(&mut self, width: u32, height: u32) -> CachedXfbSurface {
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("browser XFB copy"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.textures_created = metrics.textures_created.saturating_add(1);
        });
        let id = self.next_xfb_surface_id;
        self.next_xfb_surface_id = self.next_xfb_surface_id.wrapping_add(1).max(1);
        CachedXfbSurface {
            id,
            texture,
            view,
            width,
            height,
        }
    }

    fn ensure_healthy(&self) -> Result<(), JsValue> {
        ensure_renderer_healthy(&self.failure_state)
    }

    fn flush_geometry(&mut self) -> wgpu::CommandEncoder {
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("browser GX geometry encoder"),
            });
        if self.commands.is_empty() {
            self.clear_segment();
            return encoder;
        }
        let tev_vertex_buffer = (!self.tev_vertices.is_empty()).then(|| {
            update_renderer_metrics(&self.metrics, |metrics| {
                metrics.buffers_created = metrics.buffers_created.saturating_add(1);
            });
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("browser GX per-fragment TEV vertices"),
                    contents: bytemuck::cast_slice(&self.tev_vertices),
                    usage: wgpu::BufferUsages::VERTEX,
                })
        });
        let tev_pipeline_keys = self
            .commands
            .iter()
            .filter_map(|command| command.state.pipeline)
            .collect::<HashSet<_>>();
        for key in tev_pipeline_keys {
            if self.pipelines.prepare_tev_geometry(&self.device, key) {
                update_renderer_metrics(&self.metrics, |metrics| {
                    metrics.render_pipelines_created =
                        metrics.render_pipelines_created.saturating_add(1);
                });
            }
        }
        let depth_commit_keys = self
            .commands
            .iter()
            .filter_map(|command| command.state.depth_commit)
            .collect::<HashSet<_>>();
        for key in depth_commit_keys {
            if self.pipelines.prepare_early_depth_commit(&self.device, key) {
                update_renderer_metrics(&self.metrics, |metrics| {
                    metrics.render_pipelines_created =
                        metrics.render_pipelines_created.saturating_add(1);
                });
            }
        }
        let mut managed_early_depth_commands = 0_u64;
        let mut managed_early_depth_primitives = 0_u64;
        let mut early_depth_only_commands = 0_u64;
        let mut depth_commit_draws = 0_u64;
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("browser GX geometry pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.efb_color_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.efb_depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            for command in &self.commands {
                let vertex_buffer = tev_vertex_buffer
                    .as_ref()
                    .expect("TEV draw has a TEV vertex buffer");
                pass.set_vertex_buffer(0, vertex_buffer.slice(..));
                pass.set_scissor_rect(
                    command.state.scissor.x,
                    command.state.scissor.y,
                    command.state.scissor.width,
                    command.state.scissor.height,
                );
                match command.state.early_depth {
                    GxEarlyDepthPlan::FixedFunction => {
                        let pipeline = command.state.pipeline.expect("TEV pipeline");
                        let binding =
                            &self.tev_draw_bindings[command.state.binding.expect("TEV binding")];
                        pass.set_pipeline(&self.pipelines.tev_geometry[&pipeline]);
                        pass.set_bind_group(0, &binding.draw_bind_group, &[]);
                        pass.set_bind_group(1, &binding.tev_bind_group, &[]);
                        pass.draw(command.vertices.clone(), 0..1);
                    }
                    GxEarlyDepthPlan::DepthOnly => {
                        let commit = command.state.depth_commit.expect("depth-only pipeline");
                        pass.set_pipeline(&self.pipelines.early_depth_commit[&commit]);
                        pass.draw(command.vertices.clone(), 0..1);
                        early_depth_only_commands = early_depth_only_commands.saturating_add(1);
                        depth_commit_draws = depth_commit_draws.saturating_add(1);
                    }
                    GxEarlyDepthPlan::PrimitiveOrdered => {
                        let color_key = command.state.pipeline.expect("TEV pipeline");
                        let commit_key = command
                            .state
                            .depth_commit
                            .expect("early depth commit pipeline");
                        let binding =
                            &self.tev_draw_bindings[command.state.binding.expect("TEV binding")];
                        let primitive = color_key.primitive;
                        let color = &self.pipelines.tev_geometry[&color_key];
                        let commit = &self.pipelines.early_depth_commit[&commit_key];
                        pass.set_bind_group(0, &binding.draw_bind_group, &[]);
                        pass.set_bind_group(1, &binding.tev_bind_group, &[]);
                        managed_early_depth_commands =
                            managed_early_depth_commands.saturating_add(1);
                        for vertices in
                            expanded_primitive_ranges(command.vertices.clone(), primitive)
                        {
                            pass.set_pipeline(color);
                            pass.draw(vertices.clone(), 0..1);
                            pass.set_pipeline(commit);
                            pass.draw(vertices, 0..1);
                            managed_early_depth_primitives =
                                managed_early_depth_primitives.saturating_add(1);
                            depth_commit_draws = depth_commit_draws.saturating_add(1);
                        }
                    }
                }
            }
        }
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.managed_early_depth_commands = metrics
                .managed_early_depth_commands
                .saturating_add(managed_early_depth_commands);
            metrics.managed_early_depth_primitives = metrics
                .managed_early_depth_primitives
                .saturating_add(managed_early_depth_primitives);
            metrics.early_depth_only_commands = metrics
                .early_depth_only_commands
                .saturating_add(early_depth_only_commands);
            metrics.depth_commit_draws = metrics
                .depth_commit_draws
                .saturating_add(depth_commit_draws);
        });
        self.tev_vertices.clear();
        self.commands.clear();
        self.tev_draw_binding_indices.clear();
        self.tev_draw_bindings.clear();
        encoder
    }

    fn clear_segment(&mut self) {
        self.tev_vertices.clear();
        self.commands.clear();
        self.tev_draw_binding_indices.clear();
        self.tev_draw_bindings.clear();
    }

    fn resize_surface(&mut self, width: u32, height: u32) {
        if self.surface_config.width == width && self.surface_config.height == height {
            return;
        }
        self.canvas.set_width(width);
        self.canvas.set_height(height);
        self.surface_config.width = width;
        self.surface_config.height = height;
        self.surface.configure(&self.device, &self.surface_config);
    }
}

impl PipelineKey {
    fn from_gx(
        primitive: Primitive,
        z_mode: u32,
        blend_mode: u32,
        destination_alpha: GxDestinationAlphaState,
        z_texture: GxZTextureState,
        cull_mode: u8,
    ) -> Self {
        let depth_enabled = z_mode & 1 != 0;
        let depth = depth_pipeline_state(z_mode);

        let blend = gx_blend_state(blend_mode);
        let color_blend = color_blend_component(blend, destination_alpha.target_has_guest_alpha);
        let alpha_blend = if destination_alpha.replacement_enabled() {
            BlendComponentState {
                source: wgpu::BlendFactor::One,
                destination: wgpu::BlendFactor::Zero,
                operation: wgpu::BlendOperation::Add,
            }
        } else {
            alpha_blend_component(blend, destination_alpha.target_has_guest_alpha)
        };
        Self {
            primitive,
            cull: primitive_cull_mode(primitive, cull_mode),
            managed_coverage: false,
            depth,
            blend: BlendPipelineState {
                enabled: blend.enabled,
                color: color_blend,
                alpha: alpha_blend,
                color_write: blend.color_write,
                alpha_write: blend.alpha_write && destination_alpha.target_has_guest_alpha,
            },
            canonical_fragment_depth: depth_enabled,
            unclipped_depth: depth_enabled
                && z_texture.operation != GxZTextureOperation::Disabled
                && z_texture.depth_compare_location == GxDepthCompareLocation::Late,
        }
    }

    fn color_pipeline_for_early_depth(mut self, plan: GxEarlyDepthPlan) -> Self {
        if plan == GxEarlyDepthPlan::PrimitiveOrdered {
            self.depth.write = false;
        }
        self
    }

    fn with_managed_coverage(mut self) -> Self {
        debug_assert_eq!(self.primitive, Primitive::Triangles);
        self.managed_coverage = true;
        self.cull = CullMode::None;
        self
    }
}

impl DepthCommitPipelineKey {
    fn from_gx(
        primitive: Primitive,
        z_mode: u32,
        cull_mode: u8,
        depth_encoding: GxEfbDepthEncoding,
    ) -> Self {
        Self {
            primitive,
            cull: primitive_cull_mode(primitive, cull_mode),
            compare: depth_pipeline_state(z_mode).compare,
            depth_encoding,
        }
    }

    fn from_pipeline(pipeline: PipelineKey, depth_encoding: GxEfbDepthEncoding) -> Self {
        Self {
            primitive: pipeline.primitive,
            cull: pipeline.cull,
            compare: pipeline.depth.compare,
            depth_encoding,
        }
    }
}

fn depth_only_command_state(
    primitive: Primitive,
    z_mode: u32,
    cull_mode: u8,
    depth_encoding: GxEfbDepthEncoding,
    scissor: ScissorRect,
) -> Option<DrawCommandState> {
    let depth_commit =
        DepthCommitPipelineKey::from_gx(primitive, z_mode, cull_mode, depth_encoding);
    let early_depth = GxEarlyDepthPlan::DepthOnly;
    let binding = None;
    (depth_commit.compare != wgpu::CompareFunction::Never).then_some(DrawCommandState {
        pipeline: None,
        depth_commit: Some(depth_commit),
        early_depth,
        scissor,
        binding,
    })
}

fn depth_pipeline_state(z_mode: u32) -> DepthPipelineState {
    let enabled = z_mode & 1 != 0;
    DepthPipelineState {
        compare: if enabled {
            compare_function(((z_mode >> 1) & 7) as u8)
        } else {
            wgpu::CompareFunction::Always
        },
        write: enabled && z_mode & (1 << 4) != 0,
    }
}

fn draw_depth_encoding(
    z_mode: u32,
    pixel_control: u32,
) -> Result<GxEfbDepthEncoding, crate::GxEfbDepthDecodeError> {
    if z_mode & 1 == 0 {
        return Ok(GxEfbDepthEncoding::Z24);
    }
    gx_efb_depth_encoding(pixel_control)
}

fn browser_raster_position_correction(pixel_control: u32) -> f32 {
    match gx_raster_center_evidence(pixel_control) {
        GxRasterCenterEvidence::KnownNonAntialiased => GX_NON_AA_TO_WEBGPU_POSITION_CORRECTION_EFB,
        GxRasterCenterEvidence::AmbiguousRgb565Z16 => {
            // LZGX does not transport BP0's AA enable or BP1..4's sample
            // pattern. Preserve the already-deployed strict-WebGPU Z16 path
            // unshifted until a later managed three-sample-AA layer can
            // reproduce those samples exactly. This is not a backend or
            // rendering fallback.
            0.0
        }
    }
}

fn tev_vertex_from_source(
    source_vertices: &[f32],
    index: usize,
    raster_position_correction: f32,
) -> TevVertex {
    let offset = index * TEV_VERTEX_FLOATS;
    let mut position: [f32; 4] = source_vertices[offset..offset + 4]
        .try_into()
        .expect("validated TEV position");
    if raster_position_correction != 0.0 {
        position[0] += raster_position_correction;
        position[1] += raster_position_correction;
    }
    TevVertex {
        position,
        raster0: source_vertices[offset + 4..offset + 8]
            .try_into()
            .expect("validated TEV raster channel zero"),
        raster1: source_vertices[offset + 8..offset + 12]
            .try_into()
            .expect("validated TEV raster channel one"),
        tex_coords: std::array::from_fn(|coord| {
            let start = offset + 12 + coord * 3;
            source_vertices[start..start + 3]
                .try_into()
                .expect("validated TEV texture coordinate")
        }),
    }
}

fn source_triangle_depth_and_rasters_are_bitwise_flat(
    source_vertices: &[f32],
    indices: [usize; 3],
) -> bool {
    source_triangle_depth_is_bitwise_flat(source_vertices, indices)
        && source_triangle_rasters_are_bitwise_flat(source_vertices, indices)
}

fn source_triangle_depth_is_bitwise_flat(source_vertices: &[f32], indices: [usize; 3]) -> bool {
    source_triangle_components_are_bitwise_flat(source_vertices, indices, [2])
}

fn source_triangle_rasters_are_bitwise_flat(source_vertices: &[f32], indices: [usize; 3]) -> bool {
    source_triangle_components_are_bitwise_flat(source_vertices, indices, 4..12)
}

fn source_triangle_components_are_bitwise_flat(
    source_vertices: &[f32],
    indices: [usize; 3],
    components: impl IntoIterator<Item = usize>,
) -> bool {
    let reference = indices[0] * TEV_VERTEX_FLOATS;
    components.into_iter().all(|component| {
        let expected = source_vertices[reference + component].to_bits();
        indices[1..].iter().all(|index| {
            source_vertices[index * TEV_VERTEX_FLOATS + component].to_bits() == expected
        })
    })
}

fn managed_coverage_texture_coord(
    required_coords: [bool; MAX_TEV_TEXTURES],
) -> Option<Option<usize>> {
    let mut live = required_coords
        .into_iter()
        .enumerate()
        .filter_map(|(coord, required)| required.then_some(coord));
    let selected = live.next();
    live.next().is_none().then_some(selected)
}

fn managed_coverage_samplers_are_safe(
    required_maps: [bool; MAX_TEV_TEXTURES],
    sampler_modes: [u32; MAX_TEV_TEXTURES],
    sampler_identities: [SamplerIdentity; MAX_TEV_TEXTURES],
) -> bool {
    // LZGX v4 transports mode0's wrap/filter byte plus max-anisotropy bits.
    required_maps
        .into_iter()
        .zip(sampler_modes)
        .zip(sampler_identities)
        .all(|((required, mode), identity)| {
            !required
                || ((mode & 0x60) == 0
                    && (mode & (3 << 19)) == 0
                    && identity.mag_filter == identity.min_filter)
        })
}

const MANAGED_COVERAGE_DUMMY_ATTRIBUTE_PAYLOAD: [[f32; 3]; 6] = [
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
    [1.0, 1.0, 1.0],
    [0.0, 0.0, 0.0],
    [0.0, 0.0, 0.0],
    [1.0, 1.0, 1.0],
];
const GX_MANAGED_S17_7_RAW_LIMIT: f32 = 8_388_608.0;

fn managed_coverage_texel_uv_is_safe(uv: [f32; 2]) -> bool {
    uv.into_iter().all(|component| {
        let raw_s17_7 = component * 128.0;
        // This is the exact f32 expression converted to i32 by managed WGSL.
        // Restricting it to signed S17.7 also leaves ample headroom for the
        // bilinear half-texel subtraction, arithmetic shifts, and base + 1.
        raw_s17_7.is_finite()
            && (-GX_MANAGED_S17_7_RAW_LIMIT..GX_MANAGED_S17_7_RAW_LIMIT).contains(&raw_s17_7)
    })
}

fn managed_coverage_attribute_payload(
    source_vertices: &[f32],
    indices: [usize; 3],
    texture_coord: Option<usize>,
) -> Option<[[f32; 3]; 6]> {
    managed_coverage_attribute_payload_for_depth(source_vertices, indices, texture_coord, false)
}

fn managed_coverage_attribute_payload_for_depth(
    source_vertices: &[f32],
    indices: [usize; 3],
    texture_coord: Option<usize>,
    varying_depth: bool,
) -> Option<[[f32; 3]; 6]> {
    let vertex_count = source_vertices.len() / TEV_VERTEX_FLOATS;
    if indices.into_iter().any(|index| index >= vertex_count) {
        return None;
    }
    if texture_coord.is_none() && !varying_depth {
        return Some(MANAGED_COVERAGE_DUMMY_ATTRIBUTE_PAYLOAD);
    }
    if texture_coord.is_some_and(|coord| coord >= MAX_TEV_TEXTURES) {
        return None;
    }

    let mut payload = if texture_coord.is_some() {
        [[0.0; 3]; 6]
    } else {
        MANAGED_COVERAGE_DUMMY_ATTRIBUTE_PAYLOAD
    };
    for (payload_vertex, index) in indices.into_iter().enumerate() {
        let offset = index * TEV_VERTEX_FLOATS;
        payload[0][payload_vertex] = source_vertices[offset];
        payload[1][payload_vertex] = source_vertices[offset + 1];
        let Some(texture_coord) = texture_coord else {
            continue;
        };
        let w = source_vertices[offset + 3];
        let inv_w = 1.0 / w;
        let stq_offset = offset + 12 + texture_coord * 3;
        // Dolphin's software rasterizer computes one rounded reciprocal and
        // then multiplies each projective component by that exact f32.
        let s_over_w = source_vertices[stq_offset] * inv_w;
        let t_over_w = source_vertices[stq_offset + 1] * inv_w;
        let q_over_w = source_vertices[stq_offset + 2] * inv_w;
        let values = [
            source_vertices[offset],
            source_vertices[offset + 1],
            inv_w,
            s_over_w,
            t_over_w,
            q_over_w,
        ];
        if values.into_iter().any(|value| !value.is_finite()) {
            return None;
        }
        for (field, value) in values.into_iter().enumerate() {
            payload[field][payload_vertex] = value;
        }
    }
    Some(payload)
}

fn managed_coverage_payload_is_safe(
    payload: [[f32; 3]; 6],
    depths: [f32; 3],
    points: [GxRasterPoint28_4; 3],
    raster_scissor: GxRasterScissor,
    textured: bool,
) -> bool {
    if !managed_coverage_depth_plane_is_safe(payload, depths, points, raster_scissor) {
        return false;
    }
    if !textured {
        // Flat depth retains the complete dummy payload so source-space
        // collinearity remains irrelevant. Varying depth replaces only the
        // source X/Y rows needed by its exact screen-linear plane.
        return payload[2..] == MANAGED_COVERAGE_DUMMY_ATTRIBUTE_PAYLOAD[2..];
    }

    let positions = std::array::from_fn(|vertex| [payload[0][vertex], payload[1][vertex]]);
    let planes = [
        GxRasterAttributePlaneF32::from_screen_triangle(positions, payload[2]),
        GxRasterAttributePlaneF32::from_screen_triangle(positions, payload[3]),
        GxRasterAttributePlaneF32::from_screen_triangle(positions, payload[4]),
        GxRasterAttributePlaneF32::from_screen_triangle(positions, payload[5]),
    ];
    let [
        Ok(inv_w_plane),
        Ok(s_over_w_plane),
        Ok(t_over_w_plane),
        Ok(q_over_w_plane),
    ] = planes
    else {
        return false;
    };
    let GxRasterSetup::Triangle(triangle) =
        GxRasterTriangle28_4::setup_post_cull(points, GxRasterWinding::Negative, raster_scissor)
    else {
        return true;
    };
    let bounds = triangle.bounds();
    if bounds.left >= bounds.right || bounds.top >= bounds.bottom {
        return true;
    }

    let corners = [
        [bounds.left, bounds.top],
        [bounds.right - 1, bounds.top],
        [bounds.left, bounds.bottom - 1],
        [bounds.right - 1, bounds.bottom - 1],
    ];
    let mut q_is_positive = None;
    for [pixel_x, pixel_y] in corners {
        let samples = [
            inv_w_plane.sample_non_aa(pixel_x, pixel_y),
            s_over_w_plane.sample_non_aa(pixel_x, pixel_y),
            t_over_w_plane.sample_non_aa(pixel_x, pixel_y),
            q_over_w_plane.sample_non_aa(pixel_x, pixel_y),
        ];
        let [Ok(inv_w), Ok(s_over_w), Ok(t_over_w), Ok(q_over_w)] = samples else {
            return false;
        };
        if inv_w < f32::EPSILON {
            return false;
        }

        // Mirror the managed WGSL and Dolphin BuildBlock sequence exactly.
        // Algebraically collapsing these operations changes rounded f32 bits.
        let w = 1.0 / inv_w;
        if !w.is_finite() || w < f32::EPSILON {
            return false;
        }
        let q = q_over_w * w;
        if !q.is_finite() || q.abs() < f32::EPSILON {
            return false;
        }
        let positive = q.is_sign_positive();
        if q_is_positive.is_some_and(|expected| expected != positive) {
            return false;
        }
        q_is_positive = Some(positive);
        let projection = w / q;
        if !projection.is_finite() || projection.abs() < f32::EPSILON {
            return false;
        }
        let uv = [s_over_w * projection, t_over_w * projection];
        if !managed_coverage_texel_uv_is_safe(uv) {
            return false;
        }
    }
    true
}

fn managed_coverage_depth_plane_is_safe(
    payload: [[f32; 3]; 6],
    depths: [f32; 3],
    points: [GxRasterPoint28_4; 3],
    raster_scissor: GxRasterScissor,
) -> bool {
    let positions = std::array::from_fn(|vertex| [payload[0][vertex], payload[1][vertex]]);
    let Ok(depth_plane) = GxRasterAttributePlaneF32::from_screen_triangle(positions, depths) else {
        return false;
    };
    let GxRasterSetup::Triangle(triangle) =
        GxRasterTriangle28_4::setup_post_cull(points, GxRasterWinding::Negative, raster_scissor)
    else {
        return true;
    };
    let bounds = triangle.bounds();
    if bounds.left >= bounds.right || bounds.top >= bounds.bottom {
        return true;
    }
    [
        [bounds.left, bounds.top],
        [bounds.right - 1, bounds.top],
        [bounds.left, bounds.bottom - 1],
        [bounds.right - 1, bounds.bottom - 1],
    ]
    .into_iter()
    .all(|[pixel_x, pixel_y]| depth_plane.sample_non_aa(pixel_x, pixel_y).is_ok())
}

fn managed_post_cull_indices(
    expanded: &[usize],
    actions: Option<&[GxTriangleAction]>,
) -> Option<Vec<usize>> {
    let actions = actions?;
    let triangles = expanded.chunks_exact(3);
    if expanded.is_empty() || !triangles.remainder().is_empty() || triangles.len() != actions.len()
    {
        return None;
    }

    let mut post_cull =
        Vec::with_capacity(actions.iter().filter(|action| action.is_kept()).count() * 3);
    for (triangle, action) in triangles.zip(actions.iter().copied()) {
        if !action.is_kept() {
            continue;
        }
        if action.uses_021_order() {
            post_cull.extend_from_slice(&[triangle[0], triangle[2], triangle[1]]);
        } else {
            post_cull.extend_from_slice(triangle);
        }
    }
    Some(post_cull)
}

#[allow(clippy::too_many_arguments)]
fn managed_coverage_draw_is_safe(
    evidence: ManagedCoverageEvidence,
    primitive: Primitive,
    raster_center: GxRasterCenterEvidence,
    early_depth: GxEarlyDepthPlan,
    required_maps: [bool; MAX_TEV_TEXTURES],
    required_coords: [bool; MAX_TEV_TEXTURES],
    sampler_modes: [u32; MAX_TEV_TEXTURES],
    sampler_identities: [SamplerIdentity; MAX_TEV_TEXTURES],
    fog: GxFogState,
    z_texture: GxZTextureState,
    source_vertices: &[f32],
    expanded: &[usize],
    scissor: ScissorRect,
) -> bool {
    let Some(texture_coord) = managed_coverage_texture_coord(required_coords) else {
        return false;
    };
    if evidence == ManagedCoverageEvidence::None
        || primitive != Primitive::Triangles
        || raster_center != GxRasterCenterEvidence::KnownNonAntialiased
        || early_depth != GxEarlyDepthPlan::FixedFunction
        || !managed_coverage_samplers_are_safe(required_maps, sampler_modes, sampler_identities)
        || fog != GxFogState::default()
        || z_texture.operation != GxZTextureOperation::Disabled
        || !expanded.len().is_multiple_of(3)
        || !source_vertices.len().is_multiple_of(TEV_VERTEX_FLOATS)
    {
        return false;
    }

    for vertex in source_vertices.chunks_exact(TEV_VERTEX_FLOATS) {
        if vertex.iter().any(|component| !component.is_finite())
            || !(0.0..=EFB_WIDTH as f32).contains(&vertex[0])
            || !(0.0..=EFB_HEIGHT as f32).contains(&vertex[1])
            || !(0.0..=GX_DEPTH24_MAX as f32).contains(&vertex[2])
            || vertex[3] <= 0.0
        {
            return false;
        }
    }

    let Ok(raster_scissor) = GxRasterScissor::new(
        scissor.x as u16,
        scissor.y as u16,
        (scissor.x + scissor.width) as u16,
        (scissor.y + scissor.height) as u16,
        0,
        0,
    ) else {
        return false;
    };
    let textured = texture_coord.is_some();
    let vertex_count = source_vertices.len() / TEV_VERTEX_FLOATS;
    expanded.chunks_exact(3).all(|triangle| {
        let indices = [triangle[0], triangle[1], triangle[2]];
        if indices.into_iter().any(|index| index >= vertex_count) {
            return false;
        }
        let depth_is_flat = source_triangle_depth_is_bitwise_flat(source_vertices, indices);
        if !source_triangle_rasters_are_bitwise_flat(source_vertices, indices)
            || (evidence == ManagedCoverageEvidence::TrustedPostCull && !depth_is_flat)
        {
            return false;
        }
        let Some(payload) = managed_coverage_attribute_payload_for_depth(
            source_vertices,
            indices,
            texture_coord,
            !depth_is_flat,
        ) else {
            return false;
        };
        let depths = indices.map(|index| source_vertices[index * TEV_VERTEX_FLOATS + 2]);
        let mut points = [GxRasterPoint28_4::from_raw(0, 0); 3];
        for (point, vertex) in points.iter_mut().zip(indices) {
            let offset = vertex * TEV_VERTEX_FLOATS;
            let Ok(source_point) = GxRasterPoint28_4::from_efb(
                source_vertices[offset],
                source_vertices[offset + 1],
                0,
                0,
            ) else {
                return false;
            };
            *point = source_point;
        }
        managed_coverage_payload_is_safe(payload, depths, points, raster_scissor, textured)
    })
}

fn managed_coverage_pack_point(point: GxRasterPoint28_4) -> Option<u32> {
    let [x, y] = point.raw();
    let x = u16::try_from(x).ok()?;
    let y = u16::try_from(y).ok()?;
    Some(u32::from(x) | (u32::from(y) << 16))
}

fn managed_coverage_triangle_vertices(
    source_vertices: &[f32],
    indices: [usize; 3],
    texture_coord: Option<usize>,
    scissor: ScissorRect,
) -> Result<Option<[TevVertex; 3]>, crate::GxRasterError> {
    let raster_scissor = GxRasterScissor::new(
        scissor.x as u16,
        scissor.y as u16,
        (scissor.x + scissor.width) as u16,
        (scissor.y + scissor.height) as u16,
        0,
        0,
    )?;
    let mut points = [GxRasterPoint28_4::from_raw(0, 0); 3];
    for (point, index) in points.iter_mut().zip(indices) {
        let offset = index * TEV_VERTEX_FLOATS;
        *point = GxRasterPoint28_4::from_efb(
            source_vertices[offset],
            source_vertices[offset + 1],
            0,
            0,
        )?;
    }
    let GxRasterSetup::Triangle(triangle) =
        GxRasterTriangle28_4::setup_post_cull(points, GxRasterWinding::Negative, raster_scissor)
    else {
        return Ok(None);
    };
    let bounds = triangle.bounds();
    if bounds.left >= bounds.right || bounds.top >= bounds.bottom {
        return Ok(None);
    }

    let left = bounds.left as f32 - 1.0;
    let top = bounds.top as f32 - 1.0;
    let width = (bounds.right - bounds.left) as f32 + 2.0;
    let height = (bounds.bottom - bounds.top) as f32 + 2.0;
    let cover = [
        [left, top],
        [left + width * 2.0, top],
        [left, top + height * 2.0],
    ];
    let depths = indices.map(|index| source_vertices[index * TEV_VERTEX_FLOATS + 2]);
    let varying_depth = depths[1..]
        .iter()
        .any(|depth| depth.to_bits() != depths[0].to_bits());
    let mut flat = tev_vertex_from_source(source_vertices, indices[0], 0.0);
    if let Some(payload) = managed_coverage_attribute_payload_for_depth(
        source_vertices,
        indices,
        texture_coord,
        varying_depth,
    ) {
        flat.tex_coords[..6].copy_from_slice(&payload);
    } else {
        return Ok(None);
    }
    // The managed layout reads STQ6/STQ7 as Sint32x4/Sint32x2. The first
    // three words pack exact XY28.4 pairs; the final three preserve the raw
    // projected-depth f32 bits for explicit GX-sample plane reconstruction.
    let packed_points = points.map(managed_coverage_pack_point);
    let [Some(point0), Some(point1), Some(point2)] = packed_points else {
        return Ok(None);
    };
    flat.tex_coords[6] = [point0, point1, point2].map(f32::from_bits);
    flat.tex_coords[7] = depths;
    Ok(Some(cover.map(|[x, y]| {
        let mut vertex = flat;
        vertex.position = [x, y, flat.position[2], 1.0];
        vertex
    })))
}

fn primitive_cull_mode(primitive: Primitive, cull_mode: u8) -> CullMode {
    if primitive != Primitive::Triangles {
        return CullMode::None;
    }
    match cull_mode & 3 {
        1 => CullMode::Back,
        2 => CullMode::Front,
        3 => CullMode::All,
        _ => CullMode::None,
    }
}

fn primitive_vertex_width(primitive: Primitive) -> u32 {
    match primitive {
        Primitive::Triangles => 3,
        Primitive::Lines => 2,
        Primitive::Points => 1,
    }
}

fn expanded_primitive_ranges(
    vertices: Range<u32>,
    primitive: Primitive,
) -> impl Iterator<Item = Range<u32>> {
    let width = primitive_vertex_width(primitive);
    assert_eq!(
        (vertices.end - vertices.start) % width,
        0,
        "expanded GX draw is not primitive aligned"
    );
    (vertices.start..vertices.end)
        .step_by(width as usize)
        .map(move |start| start..start + width)
}

fn color_blend_component(
    blend: crate::GxBlendState,
    target_has_guest_alpha: bool,
) -> BlendComponentState {
    BlendComponentState {
        source: color_blend_factor(blend.source, target_has_guest_alpha),
        destination: color_blend_factor(blend.destination, target_has_guest_alpha),
        operation: blend_operation(blend.operation),
    }
}

fn alpha_blend_component(
    blend: crate::GxBlendState,
    target_has_guest_alpha: bool,
) -> BlendComponentState {
    BlendComponentState {
        source: alpha_blend_factor(blend.source, target_has_guest_alpha),
        destination: alpha_blend_factor(blend.destination, target_has_guest_alpha),
        operation: blend_operation(blend.operation),
    }
}

fn compare_function(value: u8) -> wgpu::CompareFunction {
    match value & 7 {
        0 => wgpu::CompareFunction::Never,
        1 => wgpu::CompareFunction::Less,
        2 => wgpu::CompareFunction::Equal,
        3 => wgpu::CompareFunction::LessEqual,
        4 => wgpu::CompareFunction::Greater,
        5 => wgpu::CompareFunction::NotEqual,
        6 => wgpu::CompareFunction::GreaterEqual,
        _ => wgpu::CompareFunction::Always,
    }
}

fn color_blend_factor(factor: GxBlendFactor, target_has_guest_alpha: bool) -> wgpu::BlendFactor {
    blend_factor(gx_blend_factor_for_component(
        factor,
        false,
        target_has_guest_alpha,
    ))
}

fn alpha_blend_factor(factor: GxBlendFactor, target_has_guest_alpha: bool) -> wgpu::BlendFactor {
    blend_factor(gx_blend_factor_for_component(
        factor,
        true,
        target_has_guest_alpha,
    ))
}

fn blend_factor(factor: GxBlendFactor) -> wgpu::BlendFactor {
    match factor {
        GxBlendFactor::Zero => wgpu::BlendFactor::Zero,
        GxBlendFactor::One => wgpu::BlendFactor::One,
        GxBlendFactor::Source => wgpu::BlendFactor::Src1,
        GxBlendFactor::OneMinusSource => wgpu::BlendFactor::OneMinusSrc1,
        GxBlendFactor::SourceAlpha => wgpu::BlendFactor::Src1Alpha,
        GxBlendFactor::OneMinusSourceAlpha => wgpu::BlendFactor::OneMinusSrc1Alpha,
        GxBlendFactor::Destination => wgpu::BlendFactor::Dst,
        GxBlendFactor::OneMinusDestination => wgpu::BlendFactor::OneMinusDst,
        GxBlendFactor::DestinationAlpha => wgpu::BlendFactor::DstAlpha,
        GxBlendFactor::OneMinusDestinationAlpha => wgpu::BlendFactor::OneMinusDstAlpha,
    }
}

fn blend_operation(operation: GxBlendOperation) -> wgpu::BlendOperation {
    match operation {
        GxBlendOperation::Add => wgpu::BlendOperation::Add,
        GxBlendOperation::ReverseSubtract => wgpu::BlendOperation::ReverseSubtract,
    }
}

fn blend_write_mask(blend: BlendPipelineState) -> wgpu::ColorWrites {
    let mut write_mask = wgpu::ColorWrites::empty();
    if blend.color_write {
        write_mask |= wgpu::ColorWrites::COLOR;
    }
    if blend.alpha_write {
        write_mask |= wgpu::ColorWrites::ALPHA;
    }
    write_mask
}

fn clipped_scissor(x: u32, y: u32, width: u32, height: u32) -> Option<ScissorRect> {
    let x = x.min(EFB_WIDTH);
    let y = y.min(EFB_HEIGHT);
    let width = width.min(EFB_WIDTH - x);
    let height = height.min(EFB_HEIGHT - y);
    (width != 0 && height != 0).then_some(ScissorRect {
        x,
        y,
        width,
        height,
    })
}

fn prepare_exact_draw(
    draw: crate::packet::GxDraw<'_>,
    source_vertices: &[f32],
) -> Option<PreparedExactDraw> {
    draw.exact_clip_input?;
    let Ok(geometry) = gx_exact_draw_raster_geometry(draw, source_vertices) else {
        return Some(PreparedExactDraw::Unqualified);
    };
    debug_assert_eq!(geometry.triangle_count(), geometry.source_indices().len());
    let expanded = (0..geometry.triangle_count() * 3).collect::<Vec<_>>();
    let [left, top, right, bottom] = geometry.scissor_rect().map(u32::from);
    let scissor = (left < right && top < bottom).then_some(ScissorRect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    });
    if !expanded.is_empty() && scissor.is_none() {
        return Some(PreparedExactDraw::Unqualified);
    }
    Some(PreparedExactDraw::Qualified(QualifiedExactDraw {
        vertices: geometry.into_vertices(),
        expanded,
        scissor,
    }))
}

fn expanded_indices(topology: u8, count: usize) -> Option<Vec<usize>> {
    let mut indices = Vec::new();
    match topology {
        0 | 1 => {
            for base in (0..count.saturating_sub(3)).step_by(4) {
                indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
            }
            if count % 4 == 3 {
                indices.extend_from_slice(&[count - 3, count - 2, count - 1]);
            }
        }
        2 => indices.extend(0..count - count % 3),
        3 => {
            for index in 2..count {
                if index & 1 == 0 {
                    indices.extend_from_slice(&[index - 2, index - 1, index]);
                } else {
                    indices.extend_from_slice(&[index - 2, index, index - 1]);
                }
            }
        }
        4 => {
            for index in 2..count {
                indices.extend_from_slice(&[0, index - 1, index]);
            }
        }
        5 => indices.extend(0..count - count % 2),
        6 => {
            for index in 1..count {
                indices.extend_from_slice(&[index - 1, index]);
            }
        }
        7 => indices.extend(0..count),
        _ => return None,
    }
    Some(indices)
}

fn ensure_renderer_healthy(failure_state: &RendererFailureState) -> Result<(), JsValue> {
    match failure_state.failure() {
        Some(failure) => Err(JsValue::from_str(&failure)),
        None => Ok(()),
    }
}

fn filter_mode(linear: bool) -> wgpu::FilterMode {
    if linear {
        wgpu::FilterMode::Linear
    } else {
        wgpu::FilterMode::Nearest
    }
}

fn sampler(device: &wgpu::Device, identity: SamplerIdentity) -> wgpu::Sampler {
    device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("browser GX sampler"),
        address_mode_u: address_mode(identity.address_u),
        address_mode_v: address_mode(identity.address_v),
        address_mode_w: wgpu::AddressMode::ClampToEdge,
        mag_filter: filter_mode(identity.mag_filter),
        min_filter: filter_mode(identity.min_filter),
        mipmap_filter: wgpu::MipmapFilterMode::Nearest,
        ..Default::default()
    })
}

fn address_mode(mode: TextureAddressMode) -> wgpu::AddressMode {
    match mode {
        TextureAddressMode::ClampToEdge => wgpu::AddressMode::ClampToEdge,
        TextureAddressMode::Repeat => wgpu::AddressMode::Repeat,
        TextureAddressMode::MirrorRepeat => wgpu::AddressMode::MirrorRepeat,
    }
}

fn create_samplers(device: &wgpu::Device) -> HashMap<SamplerIdentity, wgpu::Sampler> {
    let mut samplers = HashMap::new();
    let address_modes = [
        TextureAddressMode::ClampToEdge,
        TextureAddressMode::Repeat,
        TextureAddressMode::MirrorRepeat,
    ];
    for mag_filter in [false, true] {
        for min_filter in [false, true] {
            for address_u in address_modes {
                for address_v in address_modes {
                    let identity = SamplerIdentity {
                        mag_filter,
                        min_filter,
                        address_u,
                        address_v,
                    };
                    samplers.insert(identity, sampler(device, identity));
                }
            }
        }
    }
    samplers
}

fn upload_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    width: u32,
    height: u32,
    pixels: &[u8],
    generation: u32,
) -> Result<CachedTexture, String> {
    let expected = rgba8_texture_byte_len(width, height);
    if width == 0 || height == 0 || expected != Some(pixels.len()) {
        let expected = expected.map_or_else(
            || "an unrepresentable number of".to_owned(),
            |len| len.to_string(),
        );
        return Err(format!(
            "invalid RGBA8 texture {width}x{height}: expected {expected} bytes, got {}",
            pixels.len()
        ));
    }
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        pixels,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 4),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
    );
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    Ok(CachedTexture {
        _texture: texture,
        view,
        generation,
        width,
        height,
    })
}

impl Pipelines {
    fn prepare_tev_geometry(&mut self, device: &wgpu::Device, key: PipelineKey) -> bool {
        if self.tev_geometry.contains_key(&key) {
            return false;
        }
        let pipeline =
            create_tev_geometry_pipeline(device, &self.tev_shader, &self.tev_layout, key);
        self.tev_geometry.insert(key, pipeline);
        true
    }

    fn prepare_early_depth_commit(
        &mut self,
        device: &wgpu::Device,
        key: DepthCommitPipelineKey,
    ) -> bool {
        if self.early_depth_commit.contains_key(&key) {
            return false;
        }
        let pipeline = create_early_depth_commit_pipeline(
            device,
            &self.tev_shader,
            &self.early_depth_layout,
            key,
        );
        self.early_depth_commit.insert(key, pipeline);
        true
    }
}

fn create_tev_geometry_pipeline(
    device: &wgpu::Device,
    shader: &wgpu::ShaderModule,
    layout: &wgpu::PipelineLayout,
    key: PipelineKey,
) -> wgpu::RenderPipeline {
    let blend = key.blend.enabled.then_some(wgpu::BlendState {
        color: wgpu::BlendComponent {
            src_factor: key.blend.color.source,
            dst_factor: key.blend.color.destination,
            operation: key.blend.color.operation,
        },
        alpha: wgpu::BlendComponent {
            src_factor: key.blend.alpha.source,
            dst_factor: key.blend.alpha.destination,
            operation: key.blend.alpha.operation,
        },
    });
    let write_mask = blend_write_mask(key.blend);
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("browser GX per-fragment TEV state pipeline"),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some(if key.managed_coverage {
                "vs_managed_coverage"
            } else {
                "vs_main"
            }),
            compilation_options: Default::default(),
            buffers: &[if key.managed_coverage {
                managed_coverage_vertex_layout()
            } else {
                tev_vertex_layout()
            }],
        },
        primitive: wgpu::PrimitiveState {
            topology: primitive_topology(key.primitive),
            strip_index_format: None,
            front_face: wgpu::FrontFace::Cw,
            cull_mode: webgpu_cull_mode(key.cull),
            unclipped_depth: key.unclipped_depth,
            polygon_mode: wgpu::PolygonMode::Fill,
            conservative: false,
        },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: Some(key.depth.write),
            depth_compare: Some(key.depth.compare),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: Default::default(),
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some(match (key.managed_coverage, key.canonical_fragment_depth) {
                (true, true) => "fs_managed_coverage_depth_main",
                (true, false) => "fs_managed_coverage_main",
                (false, true) => "fs_depth_main",
                (false, false) => "fs_main",
            }),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
                blend,
                write_mask,
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

fn create_early_depth_commit_pipeline(
    device: &wgpu::Device,
    shader: &wgpu::ShaderModule,
    layout: &wgpu::PipelineLayout,
    key: DepthCommitPipelineKey,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("browser GX early depth commit pipeline"),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_main"),
            compilation_options: Default::default(),
            buffers: &[tev_vertex_layout()],
        },
        primitive: wgpu::PrimitiveState {
            topology: primitive_topology(key.primitive),
            strip_index_format: None,
            front_face: wgpu::FrontFace::Cw,
            cull_mode: webgpu_cull_mode(key.cull),
            unclipped_depth: false,
            polygon_mode: wgpu::PolygonMode::Fill,
            conservative: false,
        },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: Some(true),
            depth_compare: Some(key.compare),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: Default::default(),
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some(match key.depth_encoding {
                GxEfbDepthEncoding::Z24 => "fs_early_depth_commit_z24",
                GxEfbDepthEncoding::Z16(crate::GxDepthCompression::Linear) => {
                    "fs_early_depth_commit_z16_linear"
                }
                GxEfbDepthEncoding::Z16(crate::GxDepthCompression::Near) => {
                    "fs_early_depth_commit_z16_near"
                }
                GxEfbDepthEncoding::Z16(crate::GxDepthCompression::Mid) => {
                    "fs_early_depth_commit_z16_mid"
                }
                GxEfbDepthEncoding::Z16(crate::GxDepthCompression::Far) => {
                    "fs_early_depth_commit_z16_far"
                }
            }),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
                blend: None,
                write_mask: wgpu::ColorWrites::empty(),
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

fn tev_vertex_layout() -> wgpu::VertexBufferLayout<'static> {
    wgpu::VertexBufferLayout {
        array_stride: std::mem::size_of::<TevVertex>() as u64,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &TEV_VERTEX_ATTRIBUTES,
    }
}

fn managed_coverage_vertex_layout() -> wgpu::VertexBufferLayout<'static> {
    wgpu::VertexBufferLayout {
        array_stride: std::mem::size_of::<TevVertex>() as u64,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &MANAGED_COVERAGE_VERTEX_ATTRIBUTES,
    }
}

fn primitive_topology(primitive: Primitive) -> wgpu::PrimitiveTopology {
    match primitive {
        Primitive::Triangles => wgpu::PrimitiveTopology::TriangleList,
        Primitive::Lines => wgpu::PrimitiveTopology::LineList,
        Primitive::Points => wgpu::PrimitiveTopology::PointList,
    }
}

fn webgpu_cull_mode(cull: CullMode) -> Option<wgpu::Face> {
    match cull {
        CullMode::None => None,
        CullMode::Back | CullMode::All => Some(wgpu::Face::Back),
        CullMode::Front => Some(wgpu::Face::Front),
    }
}

fn create_xfb_copy_resources(
    device: &wgpu::Device,
    efb_color_view: &wgpu::TextureView,
    samplers: &HashMap<SamplerIdentity, wgpu::Sampler>,
) -> XfbCopyResources {
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("browser GX EFB-to-XFB copy layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 2,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    });
    let uniform = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("browser GX EFB-to-XFB copy uniform"),
        size: size_of::<XfbCopyUniform>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let bind_group = |label, linear| {
        let sampler = &samplers[&SamplerIdentity {
            mag_filter: linear,
            min_filter: linear,
            address_u: TextureAddressMode::ClampToEdge,
            address_v: TextureAddressMode::ClampToEdge,
        }];
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(efb_color_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: uniform.as_entire_binding(),
                },
            ],
        })
    };
    let nearest_bind_group = bind_group("browser GX nearest EFB-to-XFB copy bind group", false);
    let linear_bind_group = bind_group("browser GX linear EFB-to-XFB copy bind group", true);
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("browser GX EFB-to-XFB copy shader"),
        source: wgpu::ShaderSource::Wgsl(XFB_COPY_SHADER.into()),
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("browser GX EFB-to-XFB copy pipeline layout"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("browser GX EFB-to-XFB copy pipeline"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            ..Default::default()
        },
        depth_stencil: None,
        multisample: Default::default(),
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    });
    XfbCopyResources {
        uniform,
        nearest_bind_group,
        linear_bind_group,
        pipeline,
    }
}

fn create_xfb_present_resources(device: &wgpu::Device) -> XfbPresentResources {
    let initial_uniform = XfbPresentUniform {
        geometry: [0; 4],
        top_scanout: [0; 4],
        bottom_scanout: [0; 4],
        options: [0; 4],
    };
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("browser XFB paired scanout plan"),
        contents: bytemuck::bytes_of(&initial_uniform),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    XfbPresentResources {
        uniform,
        bindings: VecDeque::with_capacity(XFB_PRESENT_BIND_GROUP_CACHE_CAPACITY),
    }
}

fn create_copy_clear_resources(device: &wgpu::Device) -> CopyClearResources {
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("browser GX copy-clear layout"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        }],
    });
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("browser GX copy-clear uniform"),
        contents: bytemuck::bytes_of(&CopyClearUniform::new(
            [0; 4],
            GX_DEPTH24_MAX,
            GxEfbDepthEncoding::Z24,
        )),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("browser GX copy-clear bind group"),
        layout: &layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: uniform.as_entire_binding(),
        }],
    });
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("browser GX copy-clear shader"),
        source: wgpu::ShaderSource::Wgsl(COPY_CLEAR_SHADER.into()),
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("browser GX copy-clear pipeline layout"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipelines = (0..8)
        .map(|index| {
            let mask = GxCopyClearMask::from_index(index);
            let mut write_mask = wgpu::ColorWrites::empty();
            if mask.color {
                write_mask |= wgpu::ColorWrites::COLOR;
            }
            if mask.alpha {
                write_mask |= wgpu::ColorWrites::ALPHA;
            }
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("browser GX copy-clear pipeline"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    ..Default::default()
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth32Float,
                    depth_write_enabled: Some(mask.depth),
                    depth_compare: Some(wgpu::CompareFunction::Always),
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: Default::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: None,
                        write_mask,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            })
        })
        .collect();
    CopyClearResources {
        uniform,
        bind_group,
        pipelines,
    }
}

#[allow(clippy::too_many_arguments)]
fn encode_copy_clear_pass(
    encoder: &mut wgpu::CommandEncoder,
    color_view: &wgpu::TextureView,
    depth_view: &wgpu::TextureView,
    pipeline: &wgpu::RenderPipeline,
    bind_group: &wgpu::BindGroup,
    rectangle: ScissorRect,
    label: &'static str,
) {
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some(label),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: color_view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            view: depth_view,
            depth_ops: Some(wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Store,
            }),
            stencil_ops: None,
        }),
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, bind_group, &[]);
    pass.set_scissor_rect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    pass.draw(0..3, 0..1);
}

fn create_pipelines(
    device: &wgpu::Device,
    tev_draw_layout: &wgpu::BindGroupLayout,
    tev_texture_layout: &wgpu::BindGroupLayout,
    present_layout: &wgpu::BindGroupLayout,
    surface_format: wgpu::TextureFormat,
) -> Pipelines {
    let tev_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("browser GX per-fragment TEV shader"),
        source: wgpu::ShaderSource::Wgsl(tev_shader_source().into()),
    });
    let tev_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("browser GX per-fragment TEV pipeline layout"),
        bind_group_layouts: &[Some(tev_draw_layout), Some(tev_texture_layout)],
        immediate_size: 0,
    });
    let early_depth_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("browser GX binding-free early depth pipeline layout"),
        bind_group_layouts: &[],
        immediate_size: 0,
    });

    let present_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("browser XFB presentation shader"),
        source: wgpu::ShaderSource::Wgsl(PRESENT_SHADER.into()),
    });
    let present_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("browser XFB presentation pipeline layout"),
        bind_group_layouts: &[Some(present_layout)],
        immediate_size: 0,
    });
    let present = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("browser XFB presentation pipeline"),
        layout: Some(&present_pipeline_layout),
        vertex: wgpu::VertexState {
            module: &present_shader,
            entry_point: Some("vs_main"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            ..Default::default()
        },
        depth_stencil: None,
        multisample: Default::default(),
        fragment: Some(wgpu::FragmentState {
            module: &present_shader,
            entry_point: Some("fs_main"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: surface_format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    });
    Pipelines {
        tev_shader,
        tev_layout,
        early_depth_layout,
        tev_geometry: HashMap::new(),
        early_depth_commit: HashMap::new(),
        present,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BlendComponentState, CopyClearUniform, CullMode, DRAW_FRAGMENT_DEPTH_ENCODING_SHIFT,
        DRAW_FRAGMENT_FLAG_FOG, DRAW_FRAGMENT_FLAG_LATE_Z_TEXTURE, DRAW_FRAGMENT_FLAG_RGBA6,
        DepthCommitPipelineKey, DrawUniform, GX_MANAGED_S17_7_RAW_LIMIT,
        GX_NON_AA_TO_WEBGPU_POSITION_CORRECTION_EFB, GxRasterPoint28_4, GxRasterScissor,
        GxRasterSetup, GxRasterTriangle28_4, GxRasterWinding,
        MANAGED_COVERAGE_DUMMY_ATTRIBUTE_PAYLOAD, MANAGED_COVERAGE_VERTEX_ATTRIBUTES,
        ManagedCoverageEvidence, PipelineKey, Primitive, REQUIRED_WEBGPU_FEATURES, ScissorRect,
        TEV_VERTEX_ATTRIBUTES, TevBindingKey, TevVertex, alpha_blend_factor, blend_write_mask,
        browser_raster_position_correction, color_blend_factor, depth_only_command_state,
        draw_depth_encoding, expanded_indices, expanded_primitive_ranges,
        managed_coverage_attribute_payload, managed_coverage_draw_is_safe,
        managed_coverage_pack_point, managed_coverage_samplers_are_safe,
        managed_coverage_texel_uv_is_safe, managed_coverage_texture_coord,
        managed_coverage_triangle_vertices, managed_post_cull_indices, merge_contiguous_draw_range,
        source_triangle_depth_and_rasters_are_bitwise_flat, tev_vertex_from_source,
    };
    use crate::packet::GxTriangleAction;
    use crate::tev::{MAX_TEV_TEXTURES, TEV_VERTEX_FLOATS};
    use crate::{
        GxBlendFactor, GxDepthCompression, GxEarlyDepthPlan, GxEfbDepthEncoding, GxFogState,
        GxRasterCenterEvidence, GxZTextureOperation, SamplerIdentity, TextureAddressMode,
        TextureBindingIdentity, gx_destination_alpha_state, gx_sampler_identity,
        gx_z_texture_state,
    };

    fn encoded_blend_mode(
        source: u32,
        destination: u32,
        color_write: bool,
        alpha_write: bool,
    ) -> u32 {
        1 | (u32::from(color_write) << 3)
            | (u32::from(alpha_write) << 4)
            | ((destination & 7) << 5)
            | ((source & 7) << 8)
    }

    fn pipeline_key(blend_mode: u32, constant_alpha: u32, pixel_control: u32) -> PipelineKey {
        PipelineKey::from_gx(
            Primitive::Triangles,
            0,
            blend_mode,
            gx_destination_alpha_state(blend_mode, constant_alpha, pixel_control),
            gx_z_texture_state(0, 0, pixel_control).unwrap(),
            0,
        )
    }

    fn binding_key(draw: DrawUniform) -> TevBindingKey {
        let sampler = SamplerIdentity {
            mag_filter: false,
            min_filter: false,
            address_u: TextureAddressMode::ClampToEdge,
            address_v: TextureAddressMode::ClampToEdge,
        };
        TevBindingKey {
            textures: std::array::from_fn(|_| TextureBindingIdentity::White),
            samplers: [sampler; MAX_TEV_TEXTURES],
            state: vec![0; 464],
            draw,
        }
    }

    fn flat_triangle_source(points: [[f32; 2]; 3]) -> Vec<f32> {
        let mut source = vec![0.0; TEV_VERTEX_FLOATS * 3];
        for (index, [x, y]) in points.into_iter().enumerate() {
            let offset = index * TEV_VERTEX_FLOATS;
            source[offset] = x;
            source[offset + 1] = y;
            source[offset + 2] = 1234.0;
            source[offset + 3] = 1.0;
            source[offset + 4..offset + 8].copy_from_slice(&[0.25, 0.5, 0.75, 1.0]);
            source[offset + 8..offset + 12].copy_from_slice(&[1.0, 0.75, 0.5, 0.25]);
            for coordinate in 0..MAX_TEV_TEXTURES {
                let start = offset + 12 + coordinate * 3;
                source[start..start + 3].copy_from_slice(&[
                    coordinate as f32,
                    coordinate as f32 + 0.25,
                    1.0,
                ]);
            }
        }
        source
    }

    fn qualifying_managed_draw_with_textures(
        source: &[f32],
        required_maps: [bool; MAX_TEV_TEXTURES],
        required_coords: [bool; MAX_TEV_TEXTURES],
        sampler_modes: [u32; MAX_TEV_TEXTURES],
    ) -> bool {
        managed_coverage_draw_is_safe(
            ManagedCoverageEvidence::TrustedPostCull,
            Primitive::Triangles,
            GxRasterCenterEvidence::KnownNonAntialiased,
            GxEarlyDepthPlan::FixedFunction,
            required_maps,
            required_coords,
            sampler_modes,
            sampler_modes.map(gx_sampler_identity),
            GxFogState::default(),
            gx_z_texture_state(0, 0, 0).unwrap(),
            source,
            &[0, 1, 2],
            ScissorRect {
                x: 0,
                y: 0,
                width: 640,
                height: 528,
            },
        )
    }

    fn qualifying_managed_draw(source: &[f32]) -> bool {
        qualifying_managed_draw_with_textures(
            source,
            [false; MAX_TEV_TEXTURES],
            [false; MAX_TEV_TEXTURES],
            [0; MAX_TEV_TEXTURES],
        )
    }

    fn qualifying_exact_managed_draw(source: &[f32]) -> bool {
        managed_coverage_draw_is_safe(
            ManagedCoverageEvidence::TrustedExactClip,
            Primitive::Triangles,
            GxRasterCenterEvidence::KnownNonAntialiased,
            GxEarlyDepthPlan::FixedFunction,
            [false; MAX_TEV_TEXTURES],
            [false; MAX_TEV_TEXTURES],
            [0; MAX_TEV_TEXTURES],
            [gx_sampler_identity(0); MAX_TEV_TEXTURES],
            GxFogState::default(),
            gx_z_texture_state(0, 0, 0).unwrap(),
            source,
            &[0, 1, 2],
            ScissorRect {
                x: 0,
                y: 0,
                width: 640,
                height: 528,
            },
        )
    }

    fn managed_coverage_payload(vertex: TevVertex) -> [i32; 6] {
        [
            vertex.tex_coords[6][0].to_bits() as i32,
            vertex.tex_coords[6][1].to_bits() as i32,
            vertex.tex_coords[6][2].to_bits() as i32,
            vertex.tex_coords[7][0].to_bits() as i32,
            vertex.tex_coords[7][1].to_bits() as i32,
            vertex.tex_coords[7][2].to_bits() as i32,
        ]
    }

    #[test]
    fn expands_gamecube_topologies_for_webgpu() {
        assert_eq!(expanded_indices(0, 4).unwrap(), [0, 1, 2, 0, 2, 3]);
        assert_eq!(expanded_indices(2, 3).unwrap(), [0, 1, 2]);
        assert_eq!(expanded_indices(3, 4).unwrap(), [0, 1, 2, 1, 3, 2]);
        assert_eq!(expanded_indices(4, 4).unwrap(), [0, 1, 2, 0, 2, 3]);
        assert_eq!(expanded_indices(6, 3).unwrap(), [0, 1, 1, 2]);
    }

    #[test]
    fn managed_post_cull_actions_omit_rejects_and_preserve_the_encoded_keep_order() {
        let expanded = (0..12).collect::<Vec<_>>();
        let actions = [
            GxTriangleAction::Reject012,
            GxTriangleAction::Reject021,
            GxTriangleAction::Keep012,
            GxTriangleAction::Keep021,
        ];
        assert_eq!(
            managed_post_cull_indices(&expanded, Some(&actions)),
            Some(vec![6, 7, 8, 9, 11, 10]),
        );

        let rejected = [
            GxTriangleAction::Reject012,
            GxTriangleAction::Reject021,
            GxTriangleAction::Reject012,
            GxTriangleAction::Reject021,
        ];
        assert_eq!(
            managed_post_cull_indices(&expanded, Some(&rejected)),
            Some(Vec::new()),
        );
    }

    #[test]
    fn managed_post_cull_quad_packed_0x0f_uses_021_for_both_expanded_triangles() {
        let expanded = expanded_indices(0, 4).unwrap();
        assert_eq!(expanded, [0, 1, 2, 0, 2, 3]);
        let packed_0x0f = [GxTriangleAction::Keep021; 2];
        assert_eq!(
            managed_post_cull_indices(&expanded, Some(&packed_0x0f)),
            Some(vec![0, 2, 1, 0, 3, 2]),
        );
    }

    #[test]
    fn absent_post_cull_evidence_preserves_the_raw_native_expansion() {
        let expanded = expanded_indices(0, 4).unwrap();
        let managed = managed_post_cull_indices(&expanded, None);
        assert_eq!(managed, None);
        assert_eq!(managed.as_deref().unwrap_or(&expanded), [0, 1, 2, 0, 2, 3],);

        let native = PipelineKey::from_gx(
            Primitive::Triangles,
            0,
            1 << 3,
            gx_destination_alpha_state(1 << 3, 0, 0),
            gx_z_texture_state(0, 0, 0).unwrap(),
            1,
        );
        assert!(!native.managed_coverage);
        assert_eq!(native.cull, CullMode::Back);
    }

    #[test]
    fn post_cull_action_count_must_exactly_match_complete_triangle_chunks() {
        let expanded = expanded_indices(0, 4).unwrap();
        assert_eq!(managed_post_cull_indices(&expanded, Some(&[])), None);
        assert_eq!(
            managed_post_cull_indices(&expanded, Some(&[GxTriangleAction::Keep012])),
            None,
        );
        assert_eq!(
            managed_post_cull_indices(
                &expanded,
                Some(&[
                    GxTriangleAction::Keep012,
                    GxTriangleAction::Keep012,
                    GxTriangleAction::Keep012,
                ]),
            ),
            None,
        );
        assert_eq!(
            managed_post_cull_indices(&[0, 1, 2, 3], Some(&[GxTriangleAction::Keep012]),),
            None,
        );
        assert_eq!(managed_post_cull_indices(&[], Some(&[])), None);
    }

    #[test]
    fn browser_raster_correction_is_exact_for_known_non_aa_and_preserves_ambiguous_z16() {
        assert_eq!(
            browser_raster_position_correction(0),
            GX_NON_AA_TO_WEBGPU_POSITION_CORRECTION_EFB
        );
        assert_eq!(
            browser_raster_position_correction(1 | (3 << 3) | (1 << 6)),
            GX_NON_AA_TO_WEBGPU_POSITION_CORRECTION_EFB,
            "RGBA6 and unrelated depth state remain single-sample",
        );
        for compression in 0..8 {
            assert_eq!(
                browser_raster_position_correction(2 | (compression << 3)),
                0.0,
                "RGB565_Z16 compression {compression} must retain the deployed unshifted path",
            );
        }
    }

    #[test]
    fn corrected_vertex_upload_preserves_quad_split_order_and_every_non_xy_component() {
        let mut source = vec![0.0; TEV_VERTEX_FLOATS * 4];
        for index in 0..4 {
            let offset = index * TEV_VERTEX_FLOATS;
            source[offset] = index as f32 * 10.0 + 0.25;
            source[offset + 1] = index as f32 * -7.0 - 0.5;
            source[offset + 2] = f32::from_bits(0x4b00_0100 + index as u32);
            source[offset + 3] = f32::from_bits(0x3f80_0000 + index as u32);
            for component in 4..TEV_VERTEX_FLOATS {
                source[offset + component] = (index * 100 + component) as f32;
            }
        }

        let correction = browser_raster_position_correction(0);
        let expanded = expanded_indices(0, 4).unwrap();
        let uploaded = expanded
            .iter()
            .map(|index| tev_vertex_from_source(&source, *index, correction))
            .collect::<Vec<_>>();
        assert_eq!(expanded, [0, 1, 2, 0, 2, 3]);
        for (uploaded, index) in uploaded.iter().zip(expanded) {
            let offset = index * TEV_VERTEX_FLOATS;
            assert_eq!(uploaded.position[0], source[offset] + correction);
            assert_eq!(uploaded.position[1], source[offset + 1] + correction);
            assert_eq!(uploaded.position[2].to_bits(), source[offset + 2].to_bits());
            assert_eq!(uploaded.position[3].to_bits(), source[offset + 3].to_bits());
            assert_eq!(
                uploaded.raster0,
                source[offset + 4..offset + 8],
                "raster channel zero changed for source vertex {index}",
            );
            assert_eq!(
                uploaded.raster1,
                source[offset + 8..offset + 12],
                "raster channel one changed for source vertex {index}",
            );
            for coordinate in 0..MAX_TEV_TEXTURES {
                let start = offset + 12 + coordinate * 3;
                assert_eq!(
                    uploaded.tex_coords[coordinate],
                    source[start..start + 3],
                    "texture coordinate {coordinate} changed for source vertex {index}",
                );
            }
        }

        source[0] = -0.0;
        source[1] = f32::from_bits(0x7fc0_0000);
        let unshifted = tev_vertex_from_source(&source, 0, browser_raster_position_correction(2));
        assert_eq!(unshifted.position[0].to_bits(), source[0].to_bits());
        assert_eq!(unshifted.position[1].to_bits(), source[1].to_bits());
    }

    #[test]
    fn managed_coverage_requires_flat_z_and_rasters_and_certifiable_draw_state() {
        let source = flat_triangle_source([[0.590, 0.0], [4.0, 0.0], [4.0, 4.0]]);
        assert!(qualifying_managed_draw(&source));
        assert!(source_triangle_depth_and_rasters_are_bitwise_flat(
            &source,
            [0, 1, 2]
        ));

        let z_texture = gx_z_texture_state(0, 0, 0).unwrap();
        let scissor = ScissorRect {
            x: 0,
            y: 0,
            width: 640,
            height: 528,
        };
        let eligible = |primitive, raster_center, early_depth, fog, z_texture, source: &[f32]| {
            managed_coverage_draw_is_safe(
                ManagedCoverageEvidence::TrustedPostCull,
                primitive,
                raster_center,
                early_depth,
                [false; MAX_TEV_TEXTURES],
                [false; MAX_TEV_TEXTURES],
                [0; MAX_TEV_TEXTURES],
                [gx_sampler_identity(0); MAX_TEV_TEXTURES],
                fog,
                z_texture,
                source,
                &[0, 1, 2],
                scissor,
            )
        };
        assert!(!managed_coverage_draw_is_safe(
            ManagedCoverageEvidence::None,
            Primitive::Triangles,
            GxRasterCenterEvidence::KnownNonAntialiased,
            GxEarlyDepthPlan::FixedFunction,
            [false; MAX_TEV_TEXTURES],
            [false; MAX_TEV_TEXTURES],
            [0; MAX_TEV_TEXTURES],
            [gx_sampler_identity(0); MAX_TEV_TEXTURES],
            GxFogState::default(),
            z_texture,
            &source,
            &[0, 1, 2],
            scissor,
        ));
        assert!(!eligible(
            Primitive::Lines,
            GxRasterCenterEvidence::KnownNonAntialiased,
            GxEarlyDepthPlan::FixedFunction,
            GxFogState::default(),
            z_texture,
            &source,
        ));
        assert!(!eligible(
            Primitive::Triangles,
            GxRasterCenterEvidence::AmbiguousRgb565Z16,
            GxEarlyDepthPlan::FixedFunction,
            GxFogState::default(),
            z_texture,
            &source,
        ));
        assert!(!eligible(
            Primitive::Triangles,
            GxRasterCenterEvidence::KnownNonAntialiased,
            GxEarlyDepthPlan::PrimitiveOrdered,
            GxFogState::default(),
            z_texture,
            &source,
        ));
        let mut fog = GxFogState::default();
        fog.parameters[3] = 2 << 21;
        assert!(!eligible(
            Primitive::Triangles,
            GxRasterCenterEvidence::KnownNonAntialiased,
            GxEarlyDepthPlan::FixedFunction,
            fog,
            z_texture,
            &source,
        ));
        let active_z_texture = gx_z_texture_state(0, 1 << 2, 0).unwrap();
        assert_eq!(
            active_z_texture.operation,
            GxZTextureOperation::Add,
            "test must exercise an active Z-texture operation",
        );
        assert!(!eligible(
            Primitive::Triangles,
            GxRasterCenterEvidence::KnownNonAntialiased,
            GxEarlyDepthPlan::FixedFunction,
            GxFogState::default(),
            active_z_texture,
            &source,
        ));

        for (component, invalid) in [(0, -0.01), (1, 529.0), (2, 16_777_216.0), (3, 0.0)] {
            let mut invalid_source = source.clone();
            invalid_source[component] = invalid;
            assert!(
                !qualifying_managed_draw(&invalid_source),
                "source component {component}={invalid} was accepted",
            );
        }

        for component in [2, 4, 11] {
            let mut non_flat = source.clone();
            let offset = TEV_VERTEX_FLOATS + component;
            non_flat[offset] = f32::from_bits(non_flat[offset].to_bits() ^ 1);
            assert!(
                !qualifying_managed_draw(&non_flat),
                "non-flat component {component} was accepted",
            );
        }
        for component in [3, 12, TEV_VERTEX_FLOATS - 1] {
            let mut varying = source.clone();
            let offset = TEV_VERTEX_FLOATS + component;
            varying[offset] += 0.125;
            assert!(
                qualifying_managed_draw(&varying),
                "varying W or unused STQ component {component} was rejected",
            );
        }
        let mut extrapolating_w = source.clone();
        for (vertex, w) in [1_000.0, 1.0, 1_000.0].into_iter().enumerate() {
            extrapolating_w[vertex * TEV_VERTEX_FLOATS + 3] = w;
        }
        assert!(
            qualifying_managed_draw(&extrapolating_w),
            "unused projective reconstruction must not reject an untextured variable-W draw",
        );
        let mut required_maps = [false; MAX_TEV_TEXTURES];
        required_maps[0] = true;
        let mut required_coords = [false; MAX_TEV_TEXTURES];
        required_coords[0] = true;
        assert!(
            !qualifying_managed_draw_with_textures(
                &extrapolating_w,
                required_maps,
                required_coords,
                [0; MAX_TEV_TEXTURES],
            ),
            "textured coverage must reject nonpositive reciprocal-W extrapolation",
        );
        let narrow = flat_triangle_source([[0.0, 0.0], [0.5, 0.0], [0.0, 1.0]]);
        assert!(
            qualifying_managed_draw(&narrow),
            "rounded screen area is not a cull certificate or an activation gate",
        );
    }

    #[test]
    fn exact_clip_evidence_admits_varying_depth_without_weakening_legacy_evidence() {
        let mut source = flat_triangle_source([[0.590, 0.0], [4.0, 0.0], [4.0, 4.0]]);
        for (vertex, depth) in [16.25, 48.25, 80.25].into_iter().enumerate() {
            source[vertex * TEV_VERTEX_FLOATS + 2] = depth;
        }
        assert!(
            qualifying_exact_managed_draw(&source),
            "exact post-clip vertices authorize explicit depth-plane reconstruction",
        );
        assert!(
            !qualifying_managed_draw(&source),
            "legacy post-cull evidence must retain its flat-depth requirement",
        );

        let mut varying_raster = source.clone();
        varying_raster[TEV_VERTEX_FLOATS + 4] =
            f32::from_bits(varying_raster[TEV_VERTEX_FLOATS + 4].to_bits() ^ 1);
        assert!(
            !qualifying_exact_managed_draw(&varying_raster),
            "varying raster channels remain outside the exact managed subset",
        );

        let mut collinear = flat_triangle_source([[0.0, 0.0], [1.0, 0.03125], [22.0, 0.6875]]);
        assert!(qualifying_managed_draw(&collinear));
        collinear[TEV_VERTEX_FLOATS + 2] = 48.25;
        collinear[TEV_VERTEX_FLOATS * 2 + 2] = 80.25;
        assert!(
            !qualifying_exact_managed_draw(&collinear),
            "varying depth needs a finite unsnapped source-space plane",
        );
    }

    #[test]
    fn exact_depth_tail_packs_dense_point_order_and_raw_f32_words() {
        let mut source = flat_triangle_source([[0.590, 0.0], [4.0, 0.0], [4.0, 4.0]]);
        for (vertex, depth) in [16.25, 48.25, 80.25].into_iter().enumerate() {
            source[vertex * TEV_VERTEX_FLOATS + 2] = depth;
        }
        let vertices = managed_coverage_triangle_vertices(
            &source,
            [0, 2, 1],
            None,
            ScissorRect {
                x: 0,
                y: 0,
                width: 8,
                height: 8,
            },
        )
        .unwrap()
        .expect("the trusted exact triangle survives managed setup");
        let expected_words = [
            0x0000_0009,
            0x0040_0040,
            0x0000_0040,
            0x4182_0000,
            0x42a0_8000,
            0x4241_0000,
        ];
        for vertex in vertices {
            assert_eq!(
                managed_coverage_payload(vertex).map(|word| word as u32),
                expected_words,
            );
            assert_eq!(vertex.tex_coords[0], [0.590, 4.0, 4.0]);
            assert_eq!(vertex.tex_coords[1], [0.0, 4.0, 0.0]);
        }

        assert_eq!(
            managed_coverage_pack_point(GxRasterPoint28_4::from_raw(10_240, 8_448)),
            Some(10_240 | (8_448 << 16)),
        );
        assert_eq!(
            managed_coverage_pack_point(GxRasterPoint28_4::from_raw(-1, 0)),
            None,
        );
        assert_eq!(
            managed_coverage_pack_point(GxRasterPoint28_4::from_raw(65_536, 0)),
            None,
        );
    }

    #[test]
    fn managed_untextured_coverage_uses_a_dummy_plane_for_source_collinear_snap_geometry() {
        let source = flat_triangle_source([[0.0, 0.0], [1.0, 0.03125], [22.0, 0.6875]]);
        let points = [
            GxRasterPoint28_4::from_efb(0.0, 0.0, 0, 0).unwrap(),
            GxRasterPoint28_4::from_efb(1.0, 0.03125, 0, 0).unwrap(),
            GxRasterPoint28_4::from_efb(22.0, 0.6875, 0, 0).unwrap(),
        ];
        assert_eq!(
            points.map(GxRasterPoint28_4::raw),
            [[0, 0], [16, 1], [352, 11]]
        );
        let snapped_area = i128::from(16) * i128::from(11) - i128::from(1) * i128::from(352);
        assert_eq!(snapped_area, -176);
        let raster_scissor = GxRasterScissor::new(0, 0, 32, 8, 0, 0).unwrap();
        let GxRasterSetup::Triangle(triangle) = GxRasterTriangle28_4::setup_post_cull(
            points,
            GxRasterWinding::Negative,
            raster_scissor,
        ) else {
            panic!("the snapped regression vector must remain nondegenerate");
        };
        assert!(triangle.covers_pixel(18, 0));
        assert!(
            qualifying_managed_draw(&source),
            "source-space collinearity must not reject snapped nondegenerate coverage",
        );
        assert_eq!(
            managed_coverage_texture_coord([false; MAX_TEV_TEXTURES]),
            Some(None),
        );
        assert_eq!(
            managed_coverage_attribute_payload(&source, [0, 1, 2], None),
            Some(MANAGED_COVERAGE_DUMMY_ATTRIBUTE_PAYLOAD),
        );

        let vertices = managed_coverage_triangle_vertices(
            &source,
            [0, 1, 2],
            None,
            ScissorRect {
                x: 0,
                y: 0,
                width: 32,
                height: 8,
            },
        )
        .unwrap()
        .expect("the negative snapped triangle must survive managed setup");
        for vertex in vertices {
            assert_eq!(
                vertex.tex_coords[..6],
                MANAGED_COVERAGE_DUMMY_ATTRIBUTE_PAYLOAD
            );
        }
    }

    #[test]
    fn managed_textured_coverage_accepts_one_live_coord_and_packs_projective_planes() {
        let mut source = flat_triangle_source([[0.590, 0.0], [4.0, 0.0], [4.0, 4.0]]);
        let widths = [1.0, 2.0, 4.0];
        let selected_stq = [[0.25, 0.5, 1.0], [2.0, 1.0, 2.0], [8.0, 4.0, 4.0]];
        for vertex in 0..3 {
            let offset = vertex * TEV_VERTEX_FLOATS;
            source[offset + 3] = widths[vertex];
            source[offset + 12 + 7 * 3..offset + 12 + 8 * 3].copy_from_slice(&selected_stq[vertex]);
            source[offset + 12 + 2 * 3] += vertex as f32 * 17.0;
        }

        let mut required_maps = [false; MAX_TEV_TEXTURES];
        required_maps[3] = true;
        required_maps[5] = true;
        let mut required_coords = [false; MAX_TEV_TEXTURES];
        required_coords[7] = true;
        let mut sampler_modes = [0; MAX_TEV_TEXTURES];
        sampler_modes[3] = 0x90;
        sampler_modes[5] = 0;
        assert!(
            qualifying_managed_draw_with_textures(
                &source,
                required_maps,
                required_coords,
                sampler_modes,
            ),
            "multiple maps may share one live projective coordinate",
        );
        assert_eq!(
            managed_coverage_texture_coord(required_coords),
            Some(Some(7))
        );

        let vertices = managed_coverage_triangle_vertices(
            &source,
            [0, 1, 2],
            Some(7),
            ScissorRect {
                x: 0,
                y: 0,
                width: 8,
                height: 8,
            },
        )
        .unwrap()
        .expect("eligible textured face survives managed setup");
        let expected_payload = [
            [0.590, 4.0, 4.0],
            [0.0, 0.0, 4.0],
            [1.0, 0.5, 0.25],
            [0.25, 1.0, 2.0],
            [0.5, 0.5, 1.0],
            [1.0, 1.0, 1.0],
        ];
        let depth = 1234.0_f32.to_bits() as i32;
        for vertex in vertices {
            assert_eq!(vertex.tex_coords[..6], expected_payload);
            assert_eq!(
                managed_coverage_payload(vertex),
                [9, 64, 0x0040_0040, depth, depth, depth],
            );
        }

        let mut awkward = source.clone();
        let awkward_w = f32::from_bits(0x3f00_26f6);
        let awkward_s = f32::from_bits(0x3e80_b99b);
        awkward[3] = awkward_w;
        awkward[12 + 7 * 3] = awkward_s;
        let awkward_payload =
            managed_coverage_attribute_payload(&awkward, [0, 1, 2], Some(7)).unwrap();
        assert_eq!(awkward_payload[2][0].to_bits(), 0x3fff_b22c);
        assert_eq!(
            awkward_payload[3][0].to_bits(),
            0x3f00_9279,
            "S/W must multiply by the once-rounded reciprocal like Dolphin",
        );
        assert_eq!((awkward_s / awkward_w).to_bits(), 0x3f00_9278);

        required_coords[6] = true;
        assert_eq!(managed_coverage_texture_coord(required_coords), None);
        assert!(
            !qualifying_managed_draw_with_textures(
                &source,
                required_maps,
                required_coords,
                sampler_modes,
            ),
            "two live texture coordinates must stay on the native path",
        );
    }

    #[test]
    fn managed_textured_sampler_gate_accepts_only_matching_non_mip_filters() {
        let mut required_maps = [false; MAX_TEV_TEXTURES];
        required_maps[0] = true;

        for mode in [0, 0x0f, 0x90, 0x9f] {
            let mut modes = [0; MAX_TEV_TEXTURES];
            modes[0] = mode;
            let identities = modes.map(gx_sampler_identity);
            assert!(managed_coverage_samplers_are_safe(
                required_maps,
                modes,
                identities,
            ));
        }

        for mode in [0x10, 0x20, 0x40, 0xb0, 0xd0, 1 << 19, 3 << 19] {
            let mut modes = [0; MAX_TEV_TEXTURES];
            modes[0] = mode;
            let identities = modes.map(gx_sampler_identity);
            assert!(
                !managed_coverage_samplers_are_safe(required_maps, modes, identities),
                "sampler mode {mode:#x} was admitted",
            );
        }
    }

    #[test]
    fn managed_projective_payload_rejects_invalid_planes_and_sampled_coordinates() {
        let mut required_maps = [false; MAX_TEV_TEXTURES];
        required_maps[0] = true;
        let mut required_coords = [false; MAX_TEV_TEXTURES];
        required_coords[0] = true;
        let sampler_modes = [0; MAX_TEV_TEXTURES];
        let eligible = |source: &[f32]| {
            qualifying_managed_draw_with_textures(
                source,
                required_maps,
                required_coords,
                sampler_modes,
            )
        };

        let base = flat_triangle_source([[0.590, 0.0], [4.0, 0.0], [4.0, 4.0]]);

        let degenerate = flat_triangle_source([[1.0, 1.0], [2.0, 2.0], [3.0, 3.0]]);
        assert!(
            !eligible(&degenerate),
            "degenerate source plane was admitted"
        );

        let mut inverse_w_overflow = base.clone();
        inverse_w_overflow[3] = f32::from_bits(1);
        assert!(
            !eligible(&inverse_w_overflow),
            "overflowing reciprocal W was admitted",
        );

        let mut vanishing_inverse_w = base.clone();
        for vertex in 0..3 {
            vanishing_inverse_w[vertex * TEV_VERTEX_FLOATS + 3] = 2.0 / f32::EPSILON;
        }
        assert!(
            !eligible(&vanishing_inverse_w),
            "reciprocal W below the conservative denominator margin was admitted",
        );

        let mut vanishing_recovered_w = base.clone();
        for vertex in 0..3 {
            vanishing_recovered_w[vertex * TEV_VERTEX_FLOATS + 3] = f32::EPSILON / 2.0;
        }
        assert!(
            !eligible(&vanishing_recovered_w),
            "recovered W below the shader-normal margin was admitted",
        );

        let mut attribute_overflow = base.clone();
        attribute_overflow[TEV_VERTEX_FLOATS + 12] = f32::MAX;
        assert!(
            !eligible(&attribute_overflow),
            "overflowing attribute-plane arithmetic was admitted",
        );

        let mut zero_q = base.clone();
        for vertex in 0..3 {
            zero_q[vertex * TEV_VERTEX_FLOATS + 14] = 0.0;
        }
        assert!(!eligible(&zero_q), "zero projective Q was admitted");

        let mut vanishing_q = base.clone();
        for vertex in 0..3 {
            vanishing_q[vertex * TEV_VERTEX_FLOATS + 14] = f32::EPSILON / 2.0;
        }
        assert!(
            !eligible(&vanishing_q),
            "projective Q below the conservative denominator margin was admitted",
        );

        let mut vanishing_recovered_q = base.clone();
        for vertex in 0..3 {
            let offset = vertex * TEV_VERTEX_FLOATS;
            vanishing_recovered_q[offset + 3] = f32::EPSILON;
            vanishing_recovered_q[offset + 14] = f32::EPSILON * f32::EPSILON;
        }
        assert!(
            !eligible(&vanishing_recovered_q),
            "recovered Q below the shader-normal margin was admitted",
        );

        let mut changing_q_sign = base.clone();
        changing_q_sign[14] = 1.0;
        changing_q_sign[TEV_VERTEX_FLOATS + 14] = -1.0;
        changing_q_sign[TEV_VERTEX_FLOATS * 2 + 14] = 1.0;
        assert!(
            !eligible(&changing_q_sign),
            "a Q plane crossing zero in the raster bounds was admitted",
        );

        let mut overflowing_uv = base;
        for vertex in 0..3 {
            let offset = vertex * TEV_VERTEX_FLOATS;
            overflowing_uv[offset + 12] = f32::MAX;
            overflowing_uv[offset + 14] = f32::MIN_POSITIVE;
        }
        assert!(
            !eligible(&overflowing_uv),
            "a finite STQ payload with overflowing sampled UV was admitted",
        );

        let positive_s17_7_max =
            f32::from_bits(GX_MANAGED_S17_7_RAW_LIMIT.to_bits().saturating_sub(1)) / 128.0;
        assert!(managed_coverage_texel_uv_is_safe([
            -GX_MANAGED_S17_7_RAW_LIMIT / 128.0,
            positive_s17_7_max,
        ]));
        assert!(!managed_coverage_texel_uv_is_safe([
            GX_MANAGED_S17_7_RAW_LIMIT / 128.0,
            0.0,
        ]));
        assert!(!managed_coverage_texel_uv_is_safe([
            f32::from_bits((-GX_MANAGED_S17_7_RAW_LIMIT).to_bits().saturating_add(1)) / 128.0,
            0.0,
        ]));
        assert!(!managed_coverage_texel_uv_is_safe([f32::NAN, 0.0]));
    }

    #[test]
    fn managed_cover_vertices_preserve_trusted_order_and_pack_the_snap_bucket() {
        let source = flat_triangle_source([[0.590, 0.0], [4.0, 0.0], [4.0, 4.0]]);
        let vertices = managed_coverage_triangle_vertices(
            &source,
            [0, 2, 1],
            None,
            ScissorRect {
                x: 0,
                y: 0,
                width: 8,
                height: 8,
            },
        )
        .unwrap()
        .expect("trusted post-cull face must survive managed setup");
        let depth = 1234.0_f32.to_bits() as i32;
        for vertex in vertices {
            assert_eq!(vertex.position[2].to_bits(), 1234.0_f32.to_bits());
            assert_eq!(vertex.position[3], 1.0);
            assert_eq!(vertex.raster0, [0.25, 0.5, 0.75, 1.0]);
            assert_eq!(
                managed_coverage_payload(vertex),
                [9, 0x0040_0040, 64, depth, depth, depth],
            );
        }

        let same_bucket = flat_triangle_source([[0.575, 0.0], [4.0, 0.0], [4.0, 4.0]]);
        let same_bucket_vertices = managed_coverage_triangle_vertices(
            &same_bucket,
            [0, 2, 1],
            None,
            ScissorRect {
                x: 0,
                y: 0,
                width: 8,
                height: 8,
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            managed_coverage_payload(same_bucket_vertices[0]),
            managed_coverage_payload(vertices[0]),
        );

        let source_order = managed_coverage_triangle_vertices(
            &source,
            [0, 1, 2],
            None,
            ScissorRect {
                x: 0,
                y: 0,
                width: 8,
                height: 8,
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            managed_coverage_payload(source_order[0]),
            [9, 64, 0x0040_0040, depth, depth, depth],
            "managed setup must not classify, cull, or reorder trusted input",
        );
    }

    #[test]
    fn managed_vertex_layout_reuses_dead_stq_bytes_without_inflating_native_vertices() {
        assert_eq!(std::mem::size_of::<TevVertex>(), TEV_VERTEX_FLOATS * 4);
        assert_eq!(std::mem::size_of::<TevVertex>(), 144);
        assert_eq!(TEV_VERTEX_ATTRIBUTES.len(), 11);
        assert_eq!(TEV_VERTEX_ATTRIBUTES[10].shader_location, 10);
        assert_eq!(TEV_VERTEX_ATTRIBUTES[10].offset, 132);
        assert_eq!(MANAGED_COVERAGE_VERTEX_ATTRIBUTES.len(), 11);
        assert_eq!(MANAGED_COVERAGE_VERTEX_ATTRIBUTES[9].shader_location, 11);
        assert_eq!(MANAGED_COVERAGE_VERTEX_ATTRIBUTES[9].offset, 120);
        assert_eq!(MANAGED_COVERAGE_VERTEX_ATTRIBUTES[10].shader_location, 12);
        assert_eq!(MANAGED_COVERAGE_VERTEX_ATTRIBUTES[10].offset, 136);
    }

    #[test]
    fn managed_pipeline_is_a_distinct_host_cull_free_cache_key() {
        let native = pipeline_key(1 << 3, 0, 0);
        assert_eq!(native.cull, CullMode::None);
        assert!(!native.managed_coverage);

        let back_culled_native = PipelineKey::from_gx(
            Primitive::Triangles,
            0,
            1 << 3,
            gx_destination_alpha_state(1 << 3, 0, 0),
            gx_z_texture_state(0, 0, 0).unwrap(),
            1,
        );
        assert_eq!(back_culled_native.cull, CullMode::Back);
        let managed = back_culled_native.with_managed_coverage();
        assert!(managed.managed_coverage);
        assert_eq!(managed.cull, CullMode::None);
        assert_ne!(managed, back_culled_native);
    }

    #[test]
    fn managed_early_depth_pairs_each_expanded_primitive_in_order() {
        assert_eq!(
            expanded_primitive_ranges(12..24, Primitive::Triangles).collect::<Vec<_>>(),
            [12..15, 15..18, 18..21, 21..24],
        );
        assert_eq!(
            expanded_primitive_ranges(7..13, Primitive::Lines).collect::<Vec<_>>(),
            [7..9, 9..11, 11..13],
        );
        assert_eq!(
            expanded_primitive_ranges(2..5, Primitive::Points).collect::<Vec<_>>(),
            [2..3, 3..4, 4..5],
        );
    }

    #[test]
    fn depth_only_commands_are_binding_free_and_merge_only_fixed_function_state() {
        let scissor = ScissorRect {
            x: 1,
            y: 2,
            width: 3,
            height: 4,
        };
        let less_update = 1 | (1 << 1) | (1 << 4);
        let first = depth_only_command_state(
            Primitive::Triangles,
            less_update,
            1,
            GxEfbDepthEncoding::Z24,
            scissor,
        )
        .unwrap();
        let second = depth_only_command_state(
            Primitive::Triangles,
            less_update,
            1,
            GxEfbDepthEncoding::Z24,
            scissor,
        )
        .unwrap();
        assert!(first.pipeline.is_none());
        assert!(first.binding.is_none());
        assert!(first.depth_commit.is_some());

        let mut vertices = 0..3;
        assert!(merge_contiguous_draw_range(
            &mut vertices,
            &first,
            3..6,
            &second,
        ));
        assert_eq!(vertices, 0..6);

        let greater_update = 1 | (4 << 1) | (1 << 4);
        let different_compare = depth_only_command_state(
            Primitive::Triangles,
            greater_update,
            1,
            GxEfbDepthEncoding::Z24,
            scissor,
        )
        .unwrap();
        assert!(!merge_contiguous_draw_range(
            &mut vertices,
            &first,
            6..9,
            &different_compare,
        ));
        let different_scissor = depth_only_command_state(
            Primitive::Triangles,
            less_update,
            1,
            GxEfbDepthEncoding::Z24,
            ScissorRect {
                width: 4,
                ..scissor
            },
        )
        .unwrap();
        assert!(!merge_contiguous_draw_range(
            &mut vertices,
            &first,
            6..9,
            &different_scissor,
        ));
    }

    #[test]
    fn depth_only_never_compare_is_dropped_before_command_encoding() {
        let scissor = ScissorRect {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        };
        let never_update = 1 | (1 << 4);
        assert!(
            depth_only_command_state(
                Primitive::Triangles,
                never_update,
                0,
                GxEfbDepthEncoding::Z24,
                scissor,
            )
            .is_none()
        );
    }

    #[test]
    fn depth_disabled_draws_canonicalize_unused_inverse_compression_to_z24() {
        let inverse_z16 = 2 | (4 << 3);
        assert_eq!(
            draw_depth_encoding(0, inverse_z16),
            Ok(GxEfbDepthEncoding::Z24)
        );
        assert!(draw_depth_encoding(1, inverse_z16).is_err());
        assert_eq!(
            draw_depth_encoding(1, 2 | (3 << 3)),
            Ok(GxEfbDepthEncoding::Z16(GxDepthCompression::Far))
        );
    }

    #[test]
    fn managed_early_depth_disables_only_the_color_pass_depth_write() {
        let z_mode = 1 | (1 << 1) | (1 << 4);
        let pipeline = PipelineKey::from_gx(
            Primitive::Triangles,
            z_mode,
            1 << 3,
            gx_destination_alpha_state(1 << 3, 0, 1 << 6),
            gx_z_texture_state(0, 0, 1 << 6).unwrap(),
            0,
        );
        assert!(pipeline.depth.write);
        assert!(
            pipeline
                .color_pipeline_for_early_depth(GxEarlyDepthPlan::FixedFunction)
                .depth
                .write
        );
        assert!(
            !pipeline
                .color_pipeline_for_early_depth(GxEarlyDepthPlan::PrimitiveOrdered)
                .depth
                .write
        );
        let commit = DepthCommitPipelineKey::from_pipeline(pipeline, GxEfbDepthEncoding::Z24);
        assert_eq!(commit.compare, pipeline.depth.compare);
    }

    #[test]
    fn early_depth_commit_pipeline_key_ignores_fragment_only_state() {
        let first = pipeline_key(encoded_blend_mode(1, 0, true, false), 0, 0);
        let second = pipeline_key(encoded_blend_mode(7, 6, false, true), 0x1ff, 1);
        assert_ne!(first, second);
        assert_eq!(
            DepthCommitPipelineKey::from_pipeline(first, GxEfbDepthEncoding::Z24),
            DepthCommitPipelineKey::from_pipeline(second, GxEfbDepthEncoding::Z24),
        );
        assert_ne!(
            DepthCommitPipelineKey::from_pipeline(first, GxEfbDepthEncoding::Z24),
            DepthCommitPipelineKey::from_pipeline(
                first,
                GxEfbDepthEncoding::Z16(GxDepthCompression::Linear),
            ),
        );
    }

    #[test]
    fn dual_source_factors_keep_color_and_alpha_semantics_independent() {
        use GxBlendFactor as Gx;
        use wgpu::BlendFactor as Web;

        let cases = [
            (Gx::Zero, Web::Zero, Web::Zero),
            (Gx::One, Web::One, Web::One),
            (Gx::Source, Web::Src1, Web::Src1Alpha),
            (
                Gx::OneMinusSource,
                Web::OneMinusSrc1,
                Web::OneMinusSrc1Alpha,
            ),
            (Gx::SourceAlpha, Web::Src1Alpha, Web::Src1Alpha),
            (
                Gx::OneMinusSourceAlpha,
                Web::OneMinusSrc1Alpha,
                Web::OneMinusSrc1Alpha,
            ),
            (Gx::Destination, Web::Dst, Web::DstAlpha),
            (
                Gx::OneMinusDestination,
                Web::OneMinusDst,
                Web::OneMinusDstAlpha,
            ),
            (Gx::DestinationAlpha, Web::DstAlpha, Web::DstAlpha),
            (
                Gx::OneMinusDestinationAlpha,
                Web::OneMinusDstAlpha,
                Web::OneMinusDstAlpha,
            ),
        ];
        for (gx, color, alpha) in cases {
            assert_eq!(color_blend_factor(gx, true), color);
            assert_eq!(alpha_blend_factor(gx, true), alpha);
        }
        assert!(REQUIRED_WEBGPU_FEATURES.contains(wgpu::Features::DUAL_SOURCE_BLENDING));
        assert!(REQUIRED_WEBGPU_FEATURES.contains(wgpu::Features::DEPTH_CLIP_CONTROL));
    }

    #[test]
    fn no_alpha_efb_removes_only_destination_alpha_dependencies() {
        use GxBlendFactor as Gx;
        use wgpu::BlendFactor as Web;

        assert_eq!(color_blend_factor(Gx::Destination, false), Web::Dst);
        assert_eq!(
            color_blend_factor(Gx::OneMinusDestination, false),
            Web::OneMinusDst
        );
        assert_eq!(color_blend_factor(Gx::DestinationAlpha, false), Web::One);
        assert_eq!(
            color_blend_factor(Gx::OneMinusDestinationAlpha, false),
            Web::Zero
        );
        for factor in [Gx::Destination, Gx::DestinationAlpha] {
            assert_eq!(alpha_blend_factor(factor, false), Web::One);
        }
        for factor in [Gx::OneMinusDestination, Gx::OneMinusDestinationAlpha] {
            assert_eq!(alpha_blend_factor(factor, false), Web::Zero);
        }
    }

    #[test]
    fn destination_alpha_replacement_changes_only_alpha_blending_behavior() {
        // Source factor 2 is destination color; destination factor 2 is source
        // color. Their alpha counterparts must be DstAlpha and Src1Alpha.
        let blend_mode = encoded_blend_mode(2, 2, true, true);
        let ordinary = pipeline_key(blend_mode, 0, 1);
        assert_eq!(ordinary.blend.color.source, wgpu::BlendFactor::Dst);
        assert_eq!(ordinary.blend.color.destination, wgpu::BlendFactor::Src1);
        assert_eq!(ordinary.blend.alpha.source, wgpu::BlendFactor::DstAlpha);
        assert_eq!(
            ordinary.blend.alpha.destination,
            wgpu::BlendFactor::Src1Alpha
        );

        let replaced_zero = pipeline_key(blend_mode, 0x100, 1);
        let replaced_full = pipeline_key(blend_mode, 0x1ff, 1);
        assert_eq!(replaced_zero, replaced_full);
        assert_eq!(replaced_zero.blend.color, ordinary.blend.color);
        assert_eq!(
            replaced_zero.blend.alpha,
            BlendComponentState {
                source: wgpu::BlendFactor::One,
                destination: wgpu::BlendFactor::Zero,
                operation: wgpu::BlendOperation::Add,
            }
        );
        assert_ne!(replaced_zero, ordinary);
    }

    #[test]
    fn destination_alpha_replacement_preserves_subtractive_rgb_blending() {
        let subtract_mode = 1 | (1 << 3) | (1 << 4) | (1 << 11);
        let ordinary = pipeline_key(subtract_mode, 0, 1);
        let replaced = pipeline_key(subtract_mode, 0x180, 1);
        assert_eq!(
            ordinary.blend.color.operation,
            wgpu::BlendOperation::ReverseSubtract
        );
        assert_eq!(replaced.blend.color, ordinary.blend.color);
        assert_eq!(
            replaced.blend.alpha,
            BlendComponentState {
                source: wgpu::BlendFactor::One,
                destination: wgpu::BlendFactor::Zero,
                operation: wgpu::BlendOperation::Add,
            }
        );
    }

    #[test]
    fn write_masks_keep_color_and_guest_alpha_updates_independent() {
        let neither = pipeline_key(encoded_blend_mode(1, 0, false, false), 0, 1);
        let color = pipeline_key(encoded_blend_mode(1, 0, true, false), 0, 1);
        let alpha = pipeline_key(encoded_blend_mode(1, 0, false, true), 0, 1);
        let both = pipeline_key(encoded_blend_mode(1, 0, true, true), 0, 1);
        assert_eq!(blend_write_mask(neither.blend), wgpu::ColorWrites::empty());
        assert_eq!(blend_write_mask(color.blend), wgpu::ColorWrites::COLOR);
        assert_eq!(blend_write_mask(alpha.blend), wgpu::ColorWrites::ALPHA);
        assert_eq!(blend_write_mask(both.blend), wgpu::ColorWrites::ALL);

        let no_alpha = pipeline_key(encoded_blend_mode(1, 0, true, true), 0, 0);
        assert_eq!(blend_write_mask(no_alpha.blend), wgpu::ColorWrites::COLOR);
        assert!(no_alpha.blend.color_write);
        assert!(!no_alpha.blend.alpha_write);
    }

    #[test]
    fn draw_binding_cache_keys_canonicalize_inactive_state_without_aliasing_active_values() {
        let blend_mode = encoded_blend_mode(1, 0, true, true);
        let z_texture = gx_z_texture_state(0, 0, 1).unwrap();
        let active_zero = DrawUniform::from_gx(
            0x123456,
            gx_destination_alpha_state(blend_mode, 0x100, 1),
            z_texture,
            GxEfbDepthEncoding::Z24,
            false,
            GxFogState::default(),
        );
        let active_full = DrawUniform::from_gx(
            0x123456,
            gx_destination_alpha_state(blend_mode, 0x1ff, 1),
            z_texture,
            GxEfbDepthEncoding::Z24,
            false,
            GxFogState::default(),
        );
        assert_eq!(active_zero.destination_alpha, 0x100);
        assert_eq!(active_full.destination_alpha, 0x1ff);
        assert_eq!(active_zero.fragment_flags, 1);
        assert_ne!(binding_key(active_zero), binding_key(active_full));

        let alpha_update_disabled = encoded_blend_mode(1, 0, true, false);
        let inactive_a = DrawUniform::from_gx(
            0x123456,
            gx_destination_alpha_state(alpha_update_disabled, 0x100, 1),
            z_texture,
            GxEfbDepthEncoding::Z24,
            false,
            GxFogState::default(),
        );
        let inactive_b = DrawUniform::from_gx(
            0x123456,
            gx_destination_alpha_state(alpha_update_disabled, 0x1ff, 1),
            z_texture,
            GxEfbDepthEncoding::Z24,
            false,
            GxFogState::default(),
        );
        assert_eq!(inactive_a.destination_alpha, 0);
        assert_eq!(binding_key(inactive_a), binding_key(inactive_b));

        let no_alpha = DrawUniform::from_gx(
            0x123456,
            gx_destination_alpha_state(blend_mode, 0x1ff, 0),
            gx_z_texture_state(0, 0, 0).unwrap(),
            GxEfbDepthEncoding::Z24,
            false,
            GxFogState::default(),
        );
        assert_eq!(no_alpha.fragment_flags, 0);
        assert_ne!(binding_key(inactive_a), binding_key(no_alpha));
    }

    #[test]
    fn draw_uniform_transports_all_eight_sampler_words_into_the_binding_key() {
        assert_eq!(std::mem::size_of::<DrawUniform>(), 128);
        let sampler_modes = [
            0x0000_0000,
            0x0000_0011,
            0x0000_0022,
            0x0000_0033,
            0x0000_0044,
            0x0000_0055,
            0x0000_0066,
            0x0018_0097,
        ];
        let draw = DrawUniform::from_gx(
            0,
            gx_destination_alpha_state(0, 0, 0),
            gx_z_texture_state(0, 0, 0).unwrap(),
            GxEfbDepthEncoding::Z24,
            false,
            GxFogState::default(),
        )
        .with_sampler_modes(sampler_modes);
        assert_eq!(draw.sampler_modes0, sampler_modes[..4]);
        assert_eq!(draw.sampler_modes1, sampler_modes[4..]);

        let different = draw.with_sampler_modes([0; MAX_TEV_TEXTURES]);
        assert_ne!(binding_key(draw), binding_key(different));
    }

    #[test]
    fn draw_uniform_marks_active_fog_without_changing_the_rgba6_flag() {
        let destination_alpha = gx_destination_alpha_state(0, 0, 0);
        let z_texture = gx_z_texture_state(0, 0, 0).unwrap();
        let disabled = DrawUniform::from_gx(
            0,
            destination_alpha,
            z_texture,
            GxEfbDepthEncoding::Z24,
            false,
            GxFogState::default(),
        );
        let mut fog = GxFogState::default();
        fog.parameters[3] = 2 << 21;
        let enabled = DrawUniform::from_gx(
            0,
            destination_alpha,
            z_texture,
            GxEfbDepthEncoding::Z24,
            false,
            fog,
        );
        assert_eq!(disabled.fragment_flags & DRAW_FRAGMENT_FLAG_FOG, 0);
        assert_eq!(
            enabled.fragment_flags & DRAW_FRAGMENT_FLAG_FOG,
            DRAW_FRAGMENT_FLAG_FOG
        );
        assert_eq!(
            disabled.fragment_flags & DRAW_FRAGMENT_FLAG_RGBA6,
            enabled.fragment_flags & DRAW_FRAGMENT_FLAG_RGBA6
        );
    }

    #[test]
    fn draw_and_copy_clear_uniforms_share_the_model_depth_encoding() {
        let destination_alpha = gx_destination_alpha_state(0, 0, 2);
        let z_texture = gx_z_texture_state(0, 0, 2).unwrap();
        for (encoding, expected_code) in [
            (GxEfbDepthEncoding::Z24, 0),
            (GxEfbDepthEncoding::Z16(GxDepthCompression::Linear), 1),
            (GxEfbDepthEncoding::Z16(GxDepthCompression::Near), 2),
            (GxEfbDepthEncoding::Z16(GxDepthCompression::Mid), 3),
            (GxEfbDepthEncoding::Z16(GxDepthCompression::Far), 4),
        ] {
            let draw = DrawUniform::from_gx(
                0,
                destination_alpha,
                z_texture,
                encoding,
                true,
                GxFogState::default(),
            );
            assert_eq!(
                (draw.fragment_flags >> DRAW_FRAGMENT_DEPTH_ENCODING_SHIFT) & 7,
                expected_code
            );
            let clear = CopyClearUniform::new([0; 4], 0x12_3456, encoding);
            assert_eq!(
                clear.depth_and_padding[0],
                encoding.depth32_float(0x12_3456)
            );
        }
    }

    #[test]
    fn every_z_test_uses_canonical_fragment_depth_and_late_ztexture_is_selected_in_uniform() {
        let destination_alpha = gx_destination_alpha_state(0, 0, 0);
        let late = gx_z_texture_state(0x12_3456, 2 | (1 << 2), 0).unwrap();
        let early = gx_z_texture_state(0x12_3456, 2 | (1 << 2), 1 << 6).unwrap();
        let disabled = gx_z_texture_state(0xff_ffff, 2, 0).unwrap();

        let pipeline = |z_mode, z_texture| {
            PipelineKey::from_gx(
                Primitive::Triangles,
                z_mode,
                0,
                destination_alpha,
                z_texture,
                0,
            )
        };
        assert!(pipeline(1, late).canonical_fragment_depth);
        assert!(pipeline(1, early).canonical_fragment_depth);
        assert!(!pipeline(0, late).canonical_fragment_depth);
        assert!(pipeline(1, disabled).canonical_fragment_depth);
        assert!(pipeline(1, late).unclipped_depth);
        assert!(!pipeline(1, early).unclipped_depth);
        assert!(!pipeline(0, late).unclipped_depth);
        assert!(!pipeline(1, disabled).unclipped_depth);

        let draw = DrawUniform::from_gx(
            0,
            destination_alpha,
            late,
            GxEfbDepthEncoding::Z24,
            true,
            GxFogState::default(),
        );
        assert_eq!(draw.z_texture, 0x0612_3456);
        let early_draw = DrawUniform::from_gx(
            0,
            destination_alpha,
            early,
            GxEfbDepthEncoding::Z24,
            true,
            GxFogState::default(),
        );
        assert_eq!(early_draw.z_texture, draw.z_texture);
        assert_ne!(early_draw.fragment_flags, draw.fragment_flags);
        assert_eq!(
            draw.fragment_flags & DRAW_FRAGMENT_FLAG_LATE_Z_TEXTURE,
            DRAW_FRAGMENT_FLAG_LATE_Z_TEXTURE
        );
        assert_eq!(
            early_draw.fragment_flags & DRAW_FRAGMENT_FLAG_LATE_Z_TEXTURE,
            0
        );
        let inactive_late = DrawUniform::from_gx(
            0,
            destination_alpha,
            late,
            GxEfbDepthEncoding::Z24,
            false,
            GxFogState::default(),
        );
        let inactive_early = DrawUniform::from_gx(
            0,
            destination_alpha,
            early,
            GxEfbDepthEncoding::Z24,
            false,
            GxFogState::default(),
        );
        assert_eq!(binding_key(inactive_late), binding_key(inactive_early));
        let disabled_draw = DrawUniform::from_gx(
            0,
            destination_alpha,
            disabled,
            GxEfbDepthEncoding::Z24,
            true,
            GxFogState::default(),
        );
        assert_eq!(disabled_draw.z_texture, 0);
        assert_ne!(binding_key(draw), binding_key(disabled_draw));
    }
}
