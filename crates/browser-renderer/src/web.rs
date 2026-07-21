use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::ops::Range;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use bytemuck::{Pod, Zeroable};
use js_sys::{Array, Float32Array, Promise, Uint8Array, Uint32Array};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;
use web_sys::HtmlCanvasElement;
use wgpu::util::DeviceExt;

use crate::tev::{
    MAX_TEV_TEXTURES, TEV_DRAW_STATE_BYTES, TEV_TEXTURE_METADATA_WORDS, TEV_VERTEX_FLOATS,
    required_texture_maps, shader_source as tev_shader_source, validate_draw_transport,
};
use crate::{
    EFB_HEIGHT, EFB_WIDTH, GxBlendFactor, GxBlendOperation, RendererFailureState, SamplerIdentity,
    SelectedTexture, TextureAddressMode, TextureBindingIdentity, XfbCopyMetadata,
    clipped_copy_extent, decoded_texture_cache_hit, decoded_texture_is_available, gx_blend_state,
    gx_sampler_identity, merge_contiguous_draw_range, require_tev_texture, rgba8_texture_byte_len,
    select_texture, xfb_copy_matches_selection, xfb_source_rect,
};

const PRESENT_SHADER: &str = "
struct SourceRect {
    value: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var<uniform> source_rect: SourceRect;

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
    let positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    let coordinates = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0),
    );
    var output: VertexOutput;
    output.position = vec4<f32>(positions[index], 0.0, 1.0);
    output.uv = source_rect.value.xy + coordinates[index] * source_rect.value.zw;
    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(textureSample(source_texture, source_sampler, input.uv).rgb, 1.0);
}
";

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

struct CachedXfb {
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
    metadata: XfbCopyMetadata,
    output_width: u32,
    output_height: u32,
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
    surface_config: wgpu::SurfaceConfiguration,
    efb_color: wgpu::Texture,
    efb_color_view: wgpu::TextureView,
    _efb_depth: wgpu::Texture,
    efb_depth_view: wgpu::TextureView,
    tev_draw_layout: wgpu::BindGroupLayout,
    tev_texture_layout: wgpu::BindGroupLayout,
    present_layout: wgpu::BindGroupLayout,
    samplers: HashMap<SamplerIdentity, wgpu::Sampler>,
    white_texture: CachedTexture,
    texture_cache: HashMap<String, CachedTexture>,
    efb_copy_cache: HashMap<u32, CachedTexture>,
    xfb_cache: HashMap<u32, CachedXfb>,
    pipelines: Pipelines,
    tev_vertices: Vec<TevVertex>,
    commands: Vec<DrawCommand>,
    tev_draw_binding_indices: HashMap<TevBindingKey, usize>,
    tev_draw_bindings: Vec<CachedTevDrawBinding>,
}

#[wasm_bindgen]
impl WebGpuRenderer {
    pub async fn create(canvas: HtmlCanvasElement) -> Result<WebGpuRenderer, JsValue> {
        Self::create_inner(canvas)
            .await
            .map_err(|error| JsValue::from_str(&error))
    }

    pub fn reset(&mut self) -> Result<(), JsValue> {
        self.ensure_healthy()?;
        self.clear_segment();
        self.texture_cache.clear();
        self.efb_copy_cache.clear();
        self.xfb_cache.clear();
        self.clear_efb(0, 0, 0)
    }

    pub fn clear_efb(&self, red: u8, green: u8, blue: u8) -> Result<(), JsValue> {
        self.ensure_healthy()?;
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("browser EFB clear encoder"),
            });
        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("browser EFB clear pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.efb_color_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: f64::from(red) / 255.0,
                            g: f64::from(green) / 255.0,
                            b: f64::from(blue) / 255.0,
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
        self.ensure_healthy()
    }

    pub fn begin_segment(&mut self) -> Result<(), JsValue> {
        self.ensure_healthy()?;
        self.clear_segment();
        Ok(())
    }

    pub fn check_health(&self) -> Result<(), JsValue> {
        self.ensure_healthy()
    }

    pub fn has_decoded_texture(&self, key: &str, width: u32, height: u32) -> bool {
        decoded_texture_cache_hit(
            width,
            height,
            self.texture_cache
                .get(key)
                .map(|texture| (texture.width, texture.height)),
        )
    }

    pub fn drain(&self) -> Promise {
        let queue = self.queue.clone();
        let failure_state = self.failure_state.clone();
        future_to_promise(async move {
            ensure_renderer_healthy(&failure_state)?;
            QueueDrain::new(&queue).await;
            ensure_renderer_healthy(&failure_state)?;
            Ok(JsValue::UNDEFINED)
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
        let vertex_count = validate_draw_transport(
            source_vertices.len(),
            tev_state.len(),
            texture_keys.length() as usize,
            texture_metadata.len(),
            texture_pixels.length() as usize,
        )
        .map_err(|error| JsValue::from_str(&error))?;
        debug_assert_eq!(tev_state.len(), TEV_DRAW_STATE_BYTES);
        debug_assert_eq!(texture_metadata.len(), TEV_TEXTURE_METADATA_WORDS);

        let expanded = expanded_indices(topology, vertex_count)
            .ok_or_else(|| JsValue::from_str("unsupported GX primitive topology"))?;
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

        let required_maps =
            required_texture_maps(&tev_state).map_err(|error| JsValue::from_str(&error))?;
        let mut keys = Vec::with_capacity(MAX_TEV_TEXTURES);
        let mut pixels = Vec::with_capacity(MAX_TEV_TEXTURES);
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
            pixels.push(pixels_value.unchecked_into::<Uint8Array>());
        }

        let mut selected = [SelectedTexture::White; MAX_TEV_TEXTURES];
        for map in 0..MAX_TEV_TEXTURES {
            if !required_maps[map] {
                continue;
            }
            let metadata = map * 5;
            let address = texture_metadata[metadata];
            let generation = texture_metadata[metadata + 1];
            let width = texture_metadata[metadata + 2];
            let height = texture_metadata[metadata + 3];
            let cached_dimensions = self
                .texture_cache
                .get(&keys[map])
                .map(|texture| (texture.width, texture.height));
            let decoded_is_valid = decoded_texture_is_available(
                width,
                height,
                pixels[map].length() as usize,
                cached_dimensions,
            )
            .map_err(|error| {
                JsValue::from_str(&format!("TEV texture map {map} key {}: {error}", keys[map]))
            })?;
            selected[map] = require_tev_texture(
                map,
                true,
                select_texture(
                    generation,
                    self.efb_copy_cache
                        .get(&address)
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
            .map(|(map, _)| keys[map].clone())
            .collect::<HashSet<_>>();
        for map in 0..MAX_TEV_TEXTURES {
            if selected[map] != SelectedTexture::Decoded
                || self.texture_cache.contains_key(&keys[map])
            {
                continue;
            }
            let metadata = map * 5;
            let pixels = pixels[map].to_vec();
            let texture = self.upload_texture(
                &format!("GX TEV texture {}", keys[map]),
                texture_metadata[metadata + 2],
                texture_metadata[metadata + 3],
                &pixels,
                0,
            )?;
            if self.texture_cache.len() >= 128
                && let Some(key) = self
                    .texture_cache
                    .keys()
                    .find(|key| !protected_keys.contains(*key))
                    .cloned()
            {
                self.texture_cache.remove(&key);
            }
            self.texture_cache.insert(keys[map].clone(), texture);
        }

        let texture_identities = std::array::from_fn(|map| {
            let metadata = map * 5;
            match selected[map] {
                SelectedTexture::EfbCopy => TextureBindingIdentity::EfbCopy {
                    address: texture_metadata[metadata],
                    generation: texture_metadata[metadata + 1],
                },
                SelectedTexture::Decoded => TextureBindingIdentity::Decoded(keys[map].clone()),
                SelectedTexture::White => TextureBindingIdentity::White,
            }
        });
        let sampler_identities =
            std::array::from_fn(|map| gx_sampler_identity(texture_metadata[map * 5 + 4]));
        let binding_key = TevBindingKey {
            textures: texture_identities,
            samplers: sampler_identities,
            state: tev_state.clone(),
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
                    contents: &tev_state,
                    usage: wgpu::BufferUsages::UNIFORM,
                });
            let texture_views = (0..MAX_TEV_TEXTURES)
                .map(|map| {
                    let metadata = map * 5;
                    match selected[map] {
                        SelectedTexture::EfbCopy => {
                            &self.efb_copy_cache[&texture_metadata[metadata]].view
                        }
                        SelectedTexture::Decoded => &self.texture_cache[&keys[map]].view,
                        SelectedTexture::White => &self.white_texture.view,
                    }
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
        clear_red: u8,
        clear_green: u8,
        clear_blue: u8,
    ) -> Result<(), JsValue> {
        self.ensure_healthy()?;
        let mut encoder = self.flush_geometry();
        let Some((width, height)) = clipped_copy_extent(source_x, source_y, width, height) else {
            self.queue.submit([encoder.finish()]);
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
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.queue.submit([encoder.finish()]);
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
        if self.efb_copy_cache.len() > 64
            && let Some(address) = self.efb_copy_cache.keys().next().copied()
            && address != destination
        {
            self.efb_copy_cache.remove(&address);
        }
        if clear {
            self.clear_efb(clear_red, clear_green, clear_blue)?;
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
        clear_red: u8,
        clear_green: u8,
        clear_blue: u8,
    ) -> Result<(), JsValue> {
        self.ensure_healthy()?;
        let mut encoder = self.flush_geometry();
        let Some((width, source_height)) =
            clipped_copy_extent(source_x, source_y, width, source_height)
        else {
            self.queue.submit([encoder.finish()]);
            return self.ensure_healthy();
        };
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("browser XFB copy"),
            size: wgpu::Extent3d {
                width,
                height: source_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
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
                height: source_height,
                depth_or_array_layers: 1,
            },
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.queue.submit([encoder.finish()]);
        self.xfb_cache.insert(
            destination,
            CachedXfb {
                _texture: texture,
                view,
                metadata: XfbCopyMetadata {
                    destination,
                    stride,
                    height: xfb_height.max(1),
                    generation,
                },
                output_width: xfb_width.max(1),
                output_height: xfb_height.max(1),
            },
        );
        if self.xfb_cache.len() > 16
            && let Some(address) = self
                .xfb_cache
                .iter()
                .min_by_key(|(_, copy)| copy.metadata.generation)
                .map(|(address, _)| *address)
        {
            self.xfb_cache.remove(&address);
        }
        if clear {
            self.clear_efb(clear_red, clear_green, clear_blue)?;
        }
        self.ensure_healthy()
    }

    pub fn present_xfb(
        &mut self,
        selected_address: u32,
        expected_generation: u32,
        selected_row: u32,
        output_width: u32,
        output_height: u32,
    ) -> Result<bool, JsValue> {
        self.ensure_healthy()?;
        if selected_address == 0 || expected_generation == 0 {
            return Ok(false);
        }
        let Some((texture_view, cached_width, cached_height)) = self
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
            .map(|copy| (copy.view.clone(), copy.output_width, copy.output_height))
        else {
            return Ok(false);
        };
        let Some(rect) = xfb_source_rect(selected_row, cached_height) else {
            return Ok(false);
        };
        let output_width = if output_width == 0 {
            cached_width
        } else {
            output_width
        }
        .clamp(1, 1024);
        let output_height = if output_height == 0 {
            cached_height
        } else {
            output_height
        }
        .clamp(1, 1024);
        self.resize_surface(output_width, output_height);
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
        let rect_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("browser XFB source rectangle"),
                contents: bytemuck::cast_slice(&rect),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("browser XFB presentation bind group"),
            layout: &self.present_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(
                        &self.samplers[&SamplerIdentity {
                            mag_filter: true,
                            min_filter: true,
                            address_u: TextureAddressMode::ClampToEdge,
                            address_v: TextureAddressMode::ClampToEdge,
                        }],
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: rect_buffer.as_entire_binding(),
                },
            ],
        });
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
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([encoder.finish()]);
        output.present();
        self.ensure_healthy()?;
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
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
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
                    visibility: wgpu::ShaderStages::VERTEX,
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
            surface_config,
            efb_color,
            efb_color_view,
            _efb_depth: efb_depth,
            efb_depth_view,
            tev_draw_layout,
            tev_texture_layout,
            present_layout,
            samplers,
            white_texture,
            texture_cache: HashMap::new(),
            efb_copy_cache: HashMap::new(),
            xfb_cache: HashMap::new(),
            pipelines,
            tev_vertices: Vec::new(),
            commands: Vec::new(),
            tev_draw_binding_indices: HashMap::new(),
            tev_draw_bindings: Vec::new(),
        };
        renderer
            .clear_efb(0, 0, 0)
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
        upload_texture(
            &self.device,
            &self.queue,
            label,
            width,
            height,
            pixels,
            generation,
        )
        .map_err(|error| JsValue::from_str(&error))
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
            self.pipelines.prepare_tev_geometry(&self.device, key);
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
    fn prepare_tev_geometry(&mut self, device: &wgpu::Device, key: PipelineKey) {
        if self.tev_geometry.contains_key(&key) {
            return;
        }
        let pipeline =
            create_tev_geometry_pipeline(device, &self.tev_shader, &self.tev_layout, key);
        self.tev_geometry.insert(key, pipeline);
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
