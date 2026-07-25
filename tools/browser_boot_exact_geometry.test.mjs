// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rendererSource = readFileSync(
  new URL("../crates/browser-renderer/src/web.rs", import.meta.url),
  "utf8",
);
const rendererCargo = readFileSync(
  new URL("../crates/browser-renderer/Cargo.toml", import.meta.url),
  "utf8",
);

function sourceSection(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1, `missing ${startText}`);
  assert.notEqual(end, -1, `missing ${endText}`);
  return source.slice(start, end);
}

function assertOrdered(source, needles) {
  let previous = -1;
  let previousNeedle = "the section start";
  for (const needle of needles) {
    const current = source.indexOf(needle);
    assert.ok(current > previous, `${needle} must follow ${previousNeedle}`);
    previous = current;
    previousNeedle = needle;
  }
}

test("exact geometry and empty-draw proof are prepared before WebGPU mutation", () => {
  const submit = sourceSection(
    rendererSource,
    "pub fn submit_gx_frame",
    "fn push_tev_draw_inner",
  );
  assertOrdered(submit, [
    "let prepared_exact_draws",
    "// Resolve every texture consumed",
    "let mut packet_texture_keys",
    "drop(packet_parse_timer)",
    "self.begin_segment_inner()?",
  ]);
  assert.match(
    submit,
    /packet\.draws\(\)\.zip\(&prepared_exact_draws\)/,
  );
  assert.match(
    submit,
    /let mut packet_texture_keys = HashSet::new\(\);[\s\S]*if !draw_requires_texture_preflight\(draw, prepared_exact\.as_ref\(\)\) \{\s*continue;[\s\S]*packet_texture_keys\.insert\(texture\.key\);/,
  );

  const preflight = sourceSection(
    rendererSource,
    "fn draw_requires_texture_preflight",
    "fn prepare_exact_managed_vertices",
  );
  assertOrdered(preflight, [
    "PreparedExactDraw::authoritative_noop",
    "gx_early_depth_plan",
    "PreparedExactDraw::is_required",
    "GxEarlyDepthPlan::FixedFunction",
    "GxEarlyDepthPlan::DepthOnly",
  ]);
  assert.match(
    preflight,
    /PreparedExactDraw::authoritative_noop\)[\s\S]*\.is_some\(\)\s*\{\s*return false;[\s\S]*early_depth != GxEarlyDepthPlan::FixedFunction[\s\S]*return false;[\s\S]*early_depth != GxEarlyDepthPlan::DepthOnly/,
  );
  assert.match(
    submit,
    /self\.push_tev_draw_inner\([\s\S]*draw\.record\.post_cull_actions\.as_deref\(\),\s*prepared_exact\.as_ref\(\),/,
  );
});

test("absent, optional, and required exact inputs remain distinct", () => {
  const preparationTypes = sourceSection(
    rendererSource,
    "struct QualifiedExactDraw",
    "const DRAW_FRAGMENT_FLAG_RGBA6",
  );
  assert.match(
    preparationTypes,
    /struct QualifiedExactDraw \{\s*scissor: Option<ScissorRect>,\s*managed_vertices: Option<Vec<TevVertex>>,\s*exact_empty: bool,\s*\}/,
  );
  assert.doesNotMatch(preparationTypes, /vertices: Vec<f32>|expanded: Vec<usize>/);
  assert.match(
    preparationTypes,
    /struct PreparedExactDraw \{\s*required: bool,\s*required_managed_safe: bool,\s*qualified: Option<QualifiedExactDraw>,\s*\}/,
  );
  assert.match(
    preparationTypes,
    /fn is_empty\(&self\)[\s\S]*self\.exact_empty[\s\S]*managed_vertices[\s\S]*is_some_and\(Vec::is_empty\)/,
  );
  assert.match(
    preparationTypes,
    /enum ExactAuthoritativeNoop \{\s*RasterEmpty,\s*RequiredRejected,\s*\}[\s\S]*fn authoritative_noop\(&self\)[\s\S]*self\.qualified\(\)\.is_some_and\(QualifiedExactDraw::is_empty\)[\s\S]*Some\(ExactAuthoritativeNoop::RasterEmpty\)[\s\S]*self\.required && \(!self\.required_managed_safe \|\| self\.qualified\.is_none\(\)\)[\s\S]*Some\(ExactAuthoritativeNoop::RequiredRejected\)/,
  );

  const requiredRoute = sourceSection(
    rendererSource,
    "fn prepare_exact_managed_vertices",
    "fn prepare_exact_draw",
  );
  for (const requirement of [
    "draw_depth_encoding",
    "required_texture_maps",
    "required_texture_coords",
    "gx_z_texture_state",
    "gx_fog_state",
    "prepare_managed_coverage_vertices",
  ]) {
    assert.match(requiredRoute, new RegExp(requirement));
  }
  assert.match(
    requiredRoute,
    /let Ok\(z_texture\)[\s\S]*else \{\s*return None;[\s\S]*let Ok\(fog\)[\s\S]*else \{\s*return None;/,
  );
  assert.match(
    requiredRoute,
    /early_depth != GxEarlyDepthPlan::FixedFunction[\s\S]*return None;[\s\S]*draw_depth_encoding/,
  );
  assert.match(requiredRoute, /-> Option<Vec<TevVertex>>/);

  const rasterEmpty = sourceSection(
    rendererSource,
    "fn exact_geometry_is_raster_empty",
    "fn prepare_exact_managed_vertices",
  );
  assert.match(rasterEmpty, /GxRasterTriangle28_4::setup_post_cull/);
  assert.match(rasterEmpty, /GxRasterWinding::Negative/);
  assert.match(rasterEmpty, /triangle\.has_covered_sample\(\)/);
  assert.doesNotMatch(rasterEmpty, /bounds\.left < bounds\.right/);

  const prepare = sourceSection(
    rendererSource,
    "fn prepare_exact_draw",
    "fn expanded_index_count",
  );
  assert.match(prepare, /draw\.exact_clip_input\?;/);
  assert.match(prepare, /let required = draw\.record\.exact_clip_required;/);
  assert.match(
    prepare,
    /let Ok\(geometry\) = gx_exact_draw_raster_geometry\(draw, source_vertices\) else \{\s*return Some\(PreparedExactDraw \{\s*required,\s*required_managed_safe: false,\s*qualified: None,\s*\}\);/,
  );
  assert.match(
    prepare,
    /let expanded = \(0\.\.geometry\.triangle_count\(\) \* 3\)\.collect::<Vec<_>>\(\);/,
  );
  assert.match(
    prepare,
    /let \[left, top, right, bottom\] = geometry\.scissor_rect\(\)\.map\(u32::from\);/,
  );
  assert.match(prepare, /width: right - left,\s*height: bottom - top,/);
  assert.doesNotMatch(prepare, /right - left \+ 1|bottom - top \+ 1/);
  assert.match(
    prepare,
    /let exact_vertices = geometry\.into_vertices\(\);[\s\S]*let exact_empty = expanded\.is_empty\(\)[\s\S]*exact_geometry_is_raster_empty\(&exact_vertices, &expanded, scissor\)[\s\S]*let managed_vertices = \(!exact_empty\)[\s\S]*prepare_exact_managed_vertices\(\s*draw,\s*&exact_vertices,\s*&expanded,\s*scissor,\s*sampler_states,\s*\)[\s\S]*let qualified = QualifiedExactDraw \{\s*scissor,\s*managed_vertices,\s*exact_empty,\s*\};[\s\S]*let required_managed_safe = required && qualified\.managed_vertices\.is_some\(\);/,
  );
});

test("authoritative no-op and depth routing precede all TEV gates", () => {
  const draw = sourceSection(
    rendererSource,
    "fn push_tev_draw_inner",
    "fn push_expanded_draw",
  );
  assertOrdered(draw, [
    "metrics.record_draw_transport",
    "PreparedExactDraw::authoritative_noop",
    "let qualified_exact",
    "let required_exact",
    "gx_early_depth_plan",
    "required_exact && early_depth != GxEarlyDepthPlan::FixedFunction",
    "GxEarlyDepthPlan::DepthOnly",
    "required_texture_maps",
  ]);
  assert.match(
    draw,
    /PreparedExactDraw::authoritative_noop\)[\s\S]*ExactAuthoritativeNoop::RasterEmpty[\s\S]*ExactAuthoritativeNoop::RequiredRejected[\s\S]*return Ok\(\(\)\);[\s\S]*let qualified_exact/,
  );
  assert.match(
    draw,
    /if required_exact && early_depth != GxEarlyDepthPlan::FixedFunction \{[\s\S]*return Ok\(\(\)\);[\s\S]*let depth_encoding/,
  );
  assert.match(
    draw,
    /if early_depth == GxEarlyDepthPlan::DepthOnly \{[\s\S]*return self\.push_expanded_draw\([\s\S]*source_vertices,[\s\S]*&expanded,[\s\S]*raster_position_correction,[\s\S]*state/,
  );
});

test("exact managed geometry wins while only optional unsafe input falls back", () => {
  const draw = sourceSection(
    rendererSource,
    "fn push_tev_draw_inner",
    "fn push_expanded_draw",
  );
  assertOrdered(draw, [
    "let exact_managed",
    "if required_exact && exact_managed.is_none()",
    "let native_expanded",
    "let managed_vertices",
    "let managed_evidence",
    "let scissor = if let Some(exact)",
    "pipeline = pipeline.with_managed_coverage()",
    "let mut selected",
    "return self.push_prepared_managed_draw",
  ]);
  assert.match(
    draw,
    /let exact_managed =\s*qualified_exact\.filter\(\|exact\| exact\.managed_vertices\.is_some\(\)\);/,
  );
  assert.match(
    draw,
    /if required_exact && exact_managed\.is_none\(\) \{[\s\S]*return Ok\(\(\)\);[\s\S]*let native_expanded/,
  );
  assert.match(
    draw,
    /let native_expanded = exact_managed\.is_none\(\)\.then\(\|\| \{[\s\S]*expanded_indices\(topology, vertex_count\)/,
  );
  assert.match(
    draw,
    /let managed_vertices = prepared_exact\s*\.is_none\(\)[\s\S]*prepare_managed_coverage_vertices\([\s\S]*ManagedCoverageEvidence::TrustedPostCull/,
  );
  assert.match(
    draw,
    /if managed_vertices\.as_ref\(\)\.is_some_and\(Vec::is_empty\) \{[\s\S]*return Ok\(\(\)\);[\s\S]*\}[\s\S]*let managed_evidence =/,
  );
  assert.match(
    draw,
    /let scissor = if let Some\(exact\) = exact_managed \{[\s\S]*exact[\s\S]*\.scissor[\s\S]*\} else \{[\s\S]*native_scissor/,
  );
  assert.match(
    draw,
    /if let Some\(exact\) = exact_managed \{[\s\S]*push_prepared_managed_draw\([\s\S]*exact[\s\S]*\.managed_vertices/,
  );
  assert.match(
    draw,
    /if let Some\(vertices\) = managed_vertices\.as_deref\(\) \{[\s\S]*push_prepared_managed_draw\(vertices, state\)/,
  );
  assert.doesNotMatch(
    draw,
    /expanded_indices\([^)]*exact|source_indices\(\)/,
  );
  assert.doesNotMatch(draw, /managed_coverage_triangle_vertices\(/);
});

test("exact activation retains every managed shader-safety gate", () => {
  const qualification = sourceSection(
    rendererSource,
    "fn prepare_managed_coverage_vertices",
    "fn managed_coverage_draw_is_safe",
  );
  for (const requirement of [
    "ManagedCoverageEvidence::TrustedPostCull",
    "primitive != Primitive::Triangles",
    "GxRasterCenterEvidence::KnownNonAntialiased",
    "GxEarlyDepthPlan::FixedFunction",
    "managed_coverage_samplers_are_safe",
    "fog != GxFogState::default()",
    "z_texture.operation != GxZTextureOperation::Disabled",
    "source_triangle_depth_is_bitwise_flat",
    "source_triangle_rasters_are_bitwise_flat",
    "managed_coverage_attribute_payload_for_depth",
    "managed_coverage_raster_endpoints",
    "managed_coverage_payload_is_safe",
    "let mut prepared",
    "prepared.extend",
  ]) {
    assert.match(qualification, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(
    qualification,
    /managed_coverage_texture_coord\(required_coords\)/,
  );
  assert.match(qualification, /vertex\[3\] <= 0\.0/);
  assert.match(qualification, /GX_DEPTH24_MAX/);
  assert.match(rendererSource, /fn managed_coverage_depth_plane_is_safe/);
  assert.match(rendererSource, /fn managed_coverage_raster_planes_are_safe/);
  assert.match(rendererSource, /fn managed_coverage_raster_channel_u8/);
  assert.match(
    qualification,
    /evidence == ManagedCoverageEvidence::TrustedPostCull\s*&& \(!depth_is_flat \|\| !rasters_are_flat\)/,
  );
  assert.match(qualification, /Some\(prepared\)\s*\}/);
});

test("the activated path remains wgpu WebGPU-only and disables GPU reculling", () => {
  const pipeline = sourceSection(
    rendererSource,
    "impl PipelineKey",
    "fn color_blend_component",
  );
  assert.match(
    pipeline,
    /fn with_managed_coverage[\s\S]*self\.managed_coverage = true;[\s\S]*self\.cull = CullMode::None;/,
  );
  assert.match(rendererSource, /use wgpu::util::DeviceExt;/);
  assert.doesNotMatch(rendererSource, /WebGl|webgl|CanvasRenderingContext2d/);
  assert.match(
    rendererCargo,
    /wgpu = \{ workspace = true, features = \["webgpu", "wgsl"\] \}/,
  );
  assert.doesNotMatch(rendererCargo, /webgl/);
});
