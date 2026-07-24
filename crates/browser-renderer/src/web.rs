use std::cell::Cell;
use std::collections::{HashMap, HashSet};
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

use crate::packet::{GxCopyKind, GxCopyState, GxFramePacket};
use crate::tev::{
    MAX_TEV_TEXTURES, TEV_DRAW_STATE_BYTES, TEV_TEXTURE_METADATA_WORDS, TEV_VERTEX_FLOATS,
    required_texture_maps, shader_source as tev_shader_source, validate_draw_transport,
};
use crate::{
    EFB_HEIGHT, EFB_WIDTH, GX_DEPTH24_MAX, GX_IDENTITY_COPY_FILTER, GX_MAX_COPY_DIMENSION,
    GxBlendFactor, GxBlendOperation, GxCopyClearMask, GxEfbFormat, GxXfbCopyParameters,
    RendererFailureState, RendererHostTimings, RendererMetrics, RendererPhaseTiming,
    SamplerIdentity, SelectedTexture, SurfacePixelOrder, SurfaceReadbackRequestError,
    TextureAddressMode, TextureBindingIdentity, XfbCopyMetadata, XfbReadbackLayout, XfbScanoutPlan,
    clipped_copy_extent, compact_surface_readback_rows, compact_xfb_scanout_rows,
    decoded_texture_cache_hit, decoded_texture_is_available, gx_blend_state, gx_copy_clear_mask,
    gx_copy_clear_rgba, gx_depth24_to_float, gx_sampler_identity, gx_xfb_copy_parameters,
    gx_xfb_output_height, merge_contiguous_draw_range, requested_surface_readback_layout,
    require_tev_texture, reusable_xfb_surface_index, rgba8_texture_byte_len, select_texture,
    xfb_copy_matches_selection, xfb_readback_layout, xfb_scanout_plan, xfb_surface_extent_matches,
};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn host_performance_now() -> f64;
}

const PRESENT_SHADER: &str = "
struct XfbPresentUniform {
    geometry: vec4<u32>,
    scanout: vec4<u32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var<uniform> present: XfbPresentUniform;

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
    let selected_row = present.scanout.x;
    let source_row_step = present.scanout.y;
    let field_height = present.scanout.z;
    let row_repeat = present.scanout.w;
    let output_x = min(u32(input.position.x), display_width - 1u);
    let output_y = min(u32(input.position.y), display_height - 1u);
    let logical_x = min(output_x * logical_width / display_width, logical_width - 1u);
    let field_line = min(output_y / row_repeat, field_height - 1u);
    let logical_y = selected_row + field_line * source_row_step;
    let source_size = textureDimensions(source_texture);
    let source_x = min(logical_x * source_size.x / logical_width, source_size.x - 1u);
    let source_y = min(logical_y * source_size.y / logical_height, source_size.y - 1u);
    return vec4<f32>(
        textureLoad(source_texture, vec2<i32>(i32(source_x), i32(source_y)), 0).rgb,
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

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct TevVertex {
    position: [f32; 4],
    raster0: [f32; 4],
    raster1: [f32; 4],
    tex_coords: [[f32; 3]; MAX_TEV_TEXTURES],
}

const _: () = assert!(std::mem::size_of::<TevVertex>() == TEV_VERTEX_FLOATS * size_of::<f32>());

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct DrawUniform {
    alpha_test: u32,
    _padding: [u32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct CopyClearUniform {
    color: [f32; 4],
    depth_and_padding: [f32; 4],
}

impl CopyClearUniform {
    fn new(rgba: [u8; 4], depth: u32) -> Self {
        Self {
            color: rgba.map(|channel| f32::from(channel) / 255.0),
            depth_and_padding: [gx_depth24_to_float(depth), 0.0, 0.0, 0.0],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct XfbPresentUniform {
    geometry: [u32; 4],
    scanout: [u32; 4],
}

impl XfbPresentUniform {
    fn new(
        logical_width: u32,
        logical_height: u32,
        display_width: u32,
        plan: XfbScanoutPlan,
    ) -> Self {
        Self {
            geometry: [
                logical_width,
                logical_height,
                display_width,
                plan.display_height,
            ],
            scanout: [
                plan.selected_row,
                plan.source_row_step,
                plan.field_height,
                plan.row_repeat,
            ],
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
struct BlendPipelineState {
    enabled: bool,
    source: wgpu::BlendFactor,
    destination: wgpu::BlendFactor,
    operation: wgpu::BlendOperation,
    color_write: bool,
    alpha_write: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct PipelineKey {
    primitive: Primitive,
    cull: CullMode,
    depth: DepthPipelineState,
    blend: BlendPipelineState,
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
    pipeline: PipelineKey,
    scissor: ScissorRect,
    binding: usize,
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
    alpha_test: u32,
}

struct CachedTevDrawBinding {
    _alpha_uniform: wgpu::Buffer,
    alpha_bind_group: wgpu::BindGroup,
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
    present_uniform: wgpu::Buffer,
    present_bind_group: wgpu::BindGroup,
    width: u32,
    height: u32,
}

struct CachedXfb {
    surface: CachedXfbSurface,
    spare: Option<CachedXfbSurface>,
    metadata: XfbCopyMetadata,
    output_width: u32,
    output_height: u32,
}

#[derive(Clone)]
struct PresentedXfb {
    surface_id: u64,
    texture: wgpu::Texture,
    selected_address: u32,
    generation: u32,
    scanout: XfbScanoutPlan,
    source_width: u32,
    source_height: u32,
    logical_width: u32,
    logical_height: u32,
    display_width: u32,
}

#[derive(Clone)]
struct PresentedSurface {
    buffer: wgpu::Buffer,
    layout: XfbReadbackLayout,
    pixel_order: SurfacePixelOrder,
    surface_format: wgpu::TextureFormat,
    presentation_serial: u64,
    selected_address: u32,
    generation: u32,
    scanout: XfbScanoutPlan,
}

struct Pipelines {
    tev_shader: wgpu::ShaderModule,
    tev_layout: wgpu::PipelineLayout,
    tev_geometry: HashMap<PipelineKey, wgpu::RenderPipeline>,
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
    tev_draw_layout: wgpu::BindGroupLayout,
    tev_texture_layout: wgpu::BindGroupLayout,
    present_layout: wgpu::BindGroupLayout,
    samplers: HashMap<SamplerIdentity, wgpu::Sampler>,
    white_texture: CachedTexture,
    texture_cache: HashMap<String, CachedTexture>,
    efb_copy_cache: HashMap<u32, CachedTexture>,
    xfb_cache: HashMap<u32, CachedXfb>,
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
        ("drainCalls", metrics.drain_calls),
        ("expandedVertexBytes", metrics.expanded_vertex_bytes),
        ("gxFramePacketBytes", metrics.gx_frame_packet_bytes),
        (
            "gxFramePacketPayloadBytes",
            metrics.gx_frame_packet_payload_bytes,
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

#[wasm_bindgen]
impl WebGpuRenderer {
    pub async fn create(canvas: HtmlCanvasElement) -> Result<WebGpuRenderer, JsValue> {
        Self::create_inner(canvas)
            .await
            .map_err(|error| JsValue::from_str(&error))
    }

    pub fn reset(&mut self) -> Result<(), JsValue> {
        self.record_wasm_bridge_call(0);
        self.ensure_healthy()?;
        self.clear_segment();
        self.texture_cache.clear();
        self.efb_copy_cache.clear();
        self.xfb_cache.clear();
        self.last_presented_xfb = None;
        self.last_presented_surface = None;
        self.presentation_serial = 0;
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
            );
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
    ) {
        let mask = gx_copy_clear_mask(state.z_mode, state.blend_mode, state.pixel_control);
        if !mask.writes_anything() {
            return;
        }
        let rgba = gx_copy_clear_rgba(state.pixel_control, state.clear_rgba);
        let uniform = CopyClearUniform::new(rgba, state.clear_depth);
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
            let layout = xfb_readback_layout(
                presented.source_width,
                presented.source_height,
                presented.logical_height,
                0,
            )
            .ok_or_else(|| JsValue::from_str("presented WebGPU XFB has no readable pixels"))?;
            let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("browser presented XFB readback"),
                size: layout.buffer_bytes,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("browser presented XFB readback encoder"),
            });
            encoder.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo {
                    texture: &presented.texture,
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
            queue.submit([encoder.finish()]);
            BufferMap::new(&buffer)
                .await
                .map_err(|error| JsValue::from_str(&format!("WebGPU XFB map failed: {error}")))?;
            let pixels = {
                let mapped = buffer.slice(..).get_mapped_range();
                let pixels = compact_xfb_scanout_rows(
                    &mapped,
                    layout,
                    presented.logical_height,
                    presented.scanout,
                );
                drop(mapped);
                buffer.unmap();
                pixels.ok_or_else(|| JsValue::from_str("WebGPU XFB map returned truncated rows"))?
            };
            ensure_renderer_healthy(&failure_state)?;

            let result = Object::new();
            let source_row = u32::try_from(
                u64::from(presented.scanout.selected_row)
                    .checked_mul(u64::from(presented.source_height))
                    .ok_or_else(|| JsValue::from_str("presented WebGPU XFB row overflow"))?
                    / u64::from(presented.logical_height),
            )
            .map_err(|_| JsValue::from_str("presented WebGPU XFB row overflow"))?;
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
                ("address", presented.selected_address),
                ("generation", presented.generation),
                ("row", presented.scanout.selected_row),
                ("sourceRow", source_row),
                ("width", layout.width),
                ("height", presented.scanout.display_height),
                ("textureWidth", presented.source_width),
                ("textureHeight", presented.source_height),
                ("logicalWidth", presented.logical_width),
                ("logicalHeight", presented.logical_height),
                ("displayWidth", presented.display_width),
                ("displayHeight", presented.scanout.display_height),
                ("fieldStrideBytes", presented.scanout.field_stride_bytes),
                ("sourceRowStep", presented.scanout.source_row_step),
                ("fieldHeight", presented.scanout.field_height),
                ("rowRepeat", presented.scanout.row_repeat),
            ] {
                Reflect::set(
                    &result,
                    &JsValue::from_str(name),
                    &JsValue::from_f64(f64::from(value)),
                )?;
            }
            Reflect::set(
                &result,
                &JsValue::from_str("scanoutPolicy"),
                &JsValue::from_str(if presented.scanout.row_repeat == 2 {
                    "bob"
                } else {
                    "direct"
                }),
            )?;
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
                ("address", presented.selected_address),
                ("generation", presented.generation),
                ("row", presented.scanout.selected_row),
                ("width", presented.layout.width),
                ("height", presented.layout.height),
                ("fieldStrideBytes", presented.scanout.field_stride_bytes),
                ("sourceRowStep", presented.scanout.source_row_step),
                ("fieldHeight", presented.scanout.field_height),
                ("rowRepeat", presented.scanout.row_repeat),
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
            Reflect::set(
                &result,
                &JsValue::from_str("scanoutPolicy"),
                &JsValue::from_str(if presented.scanout.row_repeat == 2 {
                    "bob"
                } else {
                    "direct"
                }),
            )?;
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
            z_mode,
            blend_mode,
            alpha_test,
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
        // Resolve every required texture before beginning the segment. Packet
        // syntax is already validated above; this preflight also makes a
        // missing resident payload fail without leaving earlier draws queued.
        for draw in packet.draws() {
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
        let mut source_vertices =
            Vec::with_capacity(header.total_vertex_count as usize * TEV_VERTEX_FLOATS);
        for draw in packet.draws() {
            source_vertices.extend(draw.vertex_floats());
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
            for draw in packet.draws() {
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
                    draw.record.z_mode,
                    draw.record.blend_mode,
                    draw.record.alpha_test,
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
        z_mode: u32,
        blend_mode: u32,
        alpha_test: u32,
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
        let required_maps =
            required_texture_maps(tev_state).map_err(|error| JsValue::from_str(&error))?;
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
        let pipeline = PipelineKey::from_gx(primitive, z_mode, blend_mode, cull_mode);
        let Some(scissor) = clipped_scissor(scissor_x, scissor_y, scissor_width, scissor_height)
        else {
            return Ok(());
        };
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
        let sampler_identities =
            std::array::from_fn(|map| gx_sampler_identity(textures[map].sampler));
        let binding_key = TevBindingKey {
            textures: texture_identities,
            samplers: sampler_identities,
            state: tev_state.to_vec(),
            alpha_test: alpha_test & 0x00ff_ffff,
        };
        let binding = if let Some(binding) = self.tev_draw_binding_indices.get(&binding_key) {
            *binding
        } else {
            let alpha_uniform = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("browser GX TEV alpha-test state"),
                    contents: bytemuck::bytes_of(&DrawUniform {
                        alpha_test: binding_key.alpha_test,
                        _padding: [0; 3],
                    }),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
            let alpha_bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("browser GX TEV alpha-test bind group"),
                layout: &self.tev_draw_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 2,
                    resource: alpha_uniform.as_entire_binding(),
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
                _alpha_uniform: alpha_uniform,
                alpha_bind_group,
                _tev_uniform: tev_uniform,
                tev_bind_group,
            });
            self.tev_draw_binding_indices.insert(binding_key, binding);
            binding
        };
        drop(resource_preparation_timer);

        let start = self.tev_vertices.len() as u32;
        for index in expanded {
            let offset = index * TEV_VERTEX_FLOATS;
            self.tev_vertices.push(TevVertex {
                position: source_vertices[offset..offset + 4]
                    .try_into()
                    .expect("validated TEV position"),
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
            });
        }
        let end = self.tev_vertices.len() as u32;
        let state = DrawCommandState {
            pipeline,
            scissor,
            binding,
        };
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
            );
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
        let protected_surface = self
            .last_presented_xfb
            .as_ref()
            .map(|presented| presented.surface_id);
        let mut surfaces = Vec::with_capacity(2);
        if let Some(cached) = self.xfb_cache.remove(&destination) {
            surfaces.push(cached.surface);
            surfaces.extend(cached.spare);
        }
        let surface_descriptors = surfaces
            .iter()
            .map(|surface| (surface.id, surface.width, surface.height))
            .collect::<Vec<_>>();
        let surface = reusable_xfb_surface_index(
            &surface_descriptors,
            protected_surface,
            xfb_width,
            xfb_height,
        )
        .map_or_else(
            || self.create_xfb_surface(xfb_width, xfb_height),
            |index| surfaces.remove(index),
        );
        let spare = surfaces.into_iter().find(|candidate| {
            xfb_surface_extent_matches(candidate.width, candidate.height, xfb_width, xfb_height)
        });
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
            );
        }
        self.queue.submit([encoder.finish()]);
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.queue_submissions = metrics.queue_submissions.saturating_add(1);
        });
        self.xfb_cache.insert(
            destination,
            CachedXfb {
                surface,
                spare,
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
        output_width: u32,
        output_height: u32,
        field_stride_bytes: u32,
        field_height: u32,
        row_repeat: u32,
        capture_surface: bool,
    ) -> Result<bool, JsValue> {
        self.record_wasm_bridge_call(0);
        // Evidence proves one exact presentation. Never let a rejected plan,
        // renderer failure, or uncaptured presentation expose stale metadata.
        self.last_presented_xfb = None;
        self.last_presented_surface = None;
        self.ensure_healthy()?;
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.present_xfb_calls = metrics.present_xfb_calls.saturating_add(1);
        });
        if selected_address == 0 || expected_generation == 0 {
            return Ok(false);
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
            return Ok(false);
        };
        if output_width == 0
            || output_width > GX_MAX_COPY_DIMENSION
            || output_height == 0
            || output_height > GX_MAX_COPY_DIMENSION
            || output_width != cached_width
        {
            return Ok(false);
        }
        let Some(scanout) = xfb_scanout_plan(
            metadata,
            selected_row,
            field_stride_bytes,
            field_height,
            row_repeat,
            output_height,
        ) else {
            return Ok(false);
        };
        let uniform = XfbPresentUniform::new(cached_width, cached_height, output_width, scanout);
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
            .write_buffer(&surface.present_uniform, 0, bytemuck::bytes_of(&uniform));
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("browser XFB presentation encoder"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("browser XFB presentation pass"),
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
            pass.set_bind_group(0, &surface.present_bind_group, &[]);
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
                selected_address,
                generation: metadata.generation,
                scanout,
            }
        });
        self.queue.submit([encoder.finish()]);
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.queue_submissions = metrics.queue_submissions.saturating_add(1);
        });
        output.present();
        self.presentation_serial = next_presentation_serial;
        self.last_presented_surface = surface_capture;
        self.last_presented_xfb = Some(PresentedXfb {
            surface_id: surface.id,
            texture: surface.texture,
            selected_address,
            generation: metadata.generation,
            scanout,
            source_width: surface.width,
            source_height: surface.height,
            logical_width: cached_width,
            logical_height: cached_height,
            display_width: output_width,
        });
        if let Err(error) = self.ensure_healthy() {
            self.last_presented_xfb = None;
            self.last_presented_surface = None;
            return Err(error);
        }
        Ok(true)
    }
}

impl WebGpuRenderer {
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
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("Lazuli browser WebGPU device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::defaults().using_resolution(adapter.limits()),
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                memory_hints: wgpu::MemoryHints::Performance,
                trace: wgpu::Trace::Off,
            })
            .await
            .map_err(|error| format!("failed to create WebGPU device: {error}"))?;
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
            tev_draw_layout,
            tev_texture_layout,
            present_layout,
            samplers,
            white_texture,
            texture_cache: HashMap::new(),
            efb_copy_cache: HashMap::new(),
            xfb_cache: HashMap::new(),
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
        let initial_uniform = XfbPresentUniform {
            geometry: [0; 4],
            scanout: [0; 4],
        };
        let present_uniform = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("browser XFB scanout plan"),
                contents: bytemuck::bytes_of(&initial_uniform),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
        let present_bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("browser XFB presentation bind group"),
            layout: &self.present_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: present_uniform.as_entire_binding(),
                },
            ],
        });
        update_renderer_metrics(&self.metrics, |metrics| {
            metrics.textures_created = metrics.textures_created.saturating_add(1);
            metrics.buffers_created = metrics.buffers_created.saturating_add(1);
            metrics.bind_groups_created = metrics.bind_groups_created.saturating_add(1);
        });
        let id = self.next_xfb_surface_id;
        self.next_xfb_surface_id = self.next_xfb_surface_id.wrapping_add(1).max(1);
        CachedXfbSurface {
            id,
            texture,
            view,
            present_uniform,
            present_bind_group,
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
            .map(|command| command.state.pipeline)
            .collect::<HashSet<_>>();
        for key in tev_pipeline_keys {
            if self.pipelines.prepare_tev_geometry(&self.device, key) {
                update_renderer_metrics(&self.metrics, |metrics| {
                    metrics.render_pipelines_created =
                        metrics.render_pipelines_created.saturating_add(1);
                });
            }
        }
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
                let binding = &self.tev_draw_bindings[command.state.binding];
                pass.set_vertex_buffer(0, vertex_buffer.slice(..));
                pass.set_pipeline(&self.pipelines.tev_geometry[&command.state.pipeline]);
                pass.set_bind_group(0, &binding.alpha_bind_group, &[]);
                pass.set_bind_group(1, &binding.tev_bind_group, &[]);
                pass.set_scissor_rect(
                    command.state.scissor.x,
                    command.state.scissor.y,
                    command.state.scissor.width,
                    command.state.scissor.height,
                );
                pass.draw(command.vertices.clone(), 0..1);
            }
        }
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
    fn from_gx(primitive: Primitive, z_mode: u32, blend_mode: u32, cull_mode: u8) -> Self {
        let depth_enabled = z_mode & 1 != 0;
        let depth = DepthPipelineState {
            compare: if depth_enabled {
                compare_function(((z_mode >> 1) & 7) as u8)
            } else {
                wgpu::CompareFunction::Always
            },
            write: depth_enabled && z_mode & (1 << 4) != 0,
        };

        let blend = gx_blend_state(blend_mode);
        let cull = if primitive == Primitive::Triangles {
            match cull_mode & 3 {
                1 => CullMode::Back,
                2 => CullMode::Front,
                3 => CullMode::All,
                _ => CullMode::None,
            }
        } else {
            CullMode::None
        };
        Self {
            primitive,
            cull,
            depth,
            blend: BlendPipelineState {
                enabled: blend.enabled,
                source: blend_factor(blend.source),
                destination: blend_factor(blend.destination),
                operation: blend_operation(blend.operation),
                color_write: blend.color_write,
                alpha_write: blend.alpha_write,
            },
        }
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

fn blend_factor(factor: GxBlendFactor) -> wgpu::BlendFactor {
    match factor {
        GxBlendFactor::Zero => wgpu::BlendFactor::Zero,
        GxBlendFactor::One => wgpu::BlendFactor::One,
        GxBlendFactor::Source => wgpu::BlendFactor::Src,
        GxBlendFactor::OneMinusSource => wgpu::BlendFactor::OneMinusSrc,
        GxBlendFactor::SourceAlpha => wgpu::BlendFactor::SrcAlpha,
        GxBlendFactor::OneMinusSourceAlpha => wgpu::BlendFactor::OneMinusSrcAlpha,
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
}

fn create_tev_geometry_pipeline(
    device: &wgpu::Device,
    shader: &wgpu::ShaderModule,
    layout: &wgpu::PipelineLayout,
    key: PipelineKey,
) -> wgpu::RenderPipeline {
    let topology = match key.primitive {
        Primitive::Triangles => wgpu::PrimitiveTopology::TriangleList,
        Primitive::Lines => wgpu::PrimitiveTopology::LineList,
        Primitive::Points => wgpu::PrimitiveTopology::PointList,
    };
    let cull_mode = match key.cull {
        CullMode::None => None,
        CullMode::Back | CullMode::All => Some(wgpu::Face::Back),
        CullMode::Front => Some(wgpu::Face::Front),
    };
    let blend = key.blend.enabled.then_some(wgpu::BlendState {
        color: wgpu::BlendComponent {
            src_factor: key.blend.source,
            dst_factor: key.blend.destination,
            operation: key.blend.operation,
        },
        alpha: wgpu::BlendComponent {
            src_factor: key.blend.source,
            dst_factor: key.blend.destination,
            operation: key.blend.operation,
        },
    });
    let mut write_mask = wgpu::ColorWrites::empty();
    if key.blend.color_write {
        write_mask |= wgpu::ColorWrites::COLOR;
    }
    if key.blend.alpha_write {
        write_mask |= wgpu::ColorWrites::ALPHA;
    }
    let vertex_layout = wgpu::VertexBufferLayout {
        array_stride: std::mem::size_of::<TevVertex>() as u64,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &wgpu::vertex_attr_array![
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
        ],
    };
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("browser GX per-fragment TEV state pipeline"),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_main"),
            compilation_options: Default::default(),
            buffers: &[vertex_layout],
        },
        primitive: wgpu::PrimitiveState {
            topology,
            strip_index_format: None,
            front_face: wgpu::FrontFace::Cw,
            cull_mode,
            unclipped_depth: false,
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
            entry_point: Some("fs_main"),
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
        contents: bytemuck::bytes_of(&CopyClearUniform::new([0; 4], GX_DEPTH24_MAX)),
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
        tev_geometry: HashMap::new(),
        present,
    }
}

#[cfg(test)]
mod tests {
    use super::expanded_indices;

    #[test]
    fn expands_gamecube_topologies_for_webgpu() {
        assert_eq!(expanded_indices(0, 4).unwrap(), [0, 1, 2, 0, 2, 3]);
        assert_eq!(expanded_indices(2, 3).unwrap(), [0, 1, 2]);
        assert_eq!(expanded_indices(3, 4).unwrap(), [0, 1, 2, 1, 3, 2]);
        assert_eq!(expanded_indices(4, 4).unwrap(), [0, 1, 2, 0, 2, 3]);
        assert_eq!(expanded_indices(6, 3).unwrap(), [0, 1, 1, 2]);
    }
}
