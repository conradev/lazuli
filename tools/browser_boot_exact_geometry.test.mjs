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
    "// Resolve every required texture",
    "drop(packet_parse_timer)",
    "self.begin_segment_inner()?",
  ]);
  assert.match(
    submit,
    /packet\.draws\(\)\.zip\(&prepared_exact_draws\)/,
  );
  assert.match(
    submit,
    /is_some_and\(PreparedExactDraw::is_authoritative_empty\)[\s\S]*continue;[\s\S]*gx_early_depth_plan/,
  );
  assert.match(
    submit,
    /self\.push_tev_draw_inner\([\s\S]*draw\.record\.post_cull_actions\.as_deref\(\),\s*prepared_exact\.as_ref\(\),/,
  );
});

test("absent, unqualified, and authoritative exact inputs remain distinct", () => {
  const preparationTypes = sourceSection(
    rendererSource,
    "struct QualifiedExactDraw",
    "const DRAW_FRAGMENT_FLAG_RGBA6",
  );
  assert.match(
    preparationTypes,
    /enum PreparedExactDraw \{\s*Unqualified,\s*Qualified\(QualifiedExactDraw\),\s*\}/,
  );
  assert.match(
    preparationTypes,
    /fn is_authoritative_empty\(&self\)[\s\S]*self\.qualified\(\)\.is_some_and\(QualifiedExactDraw::is_empty\)/,
  );

  const prepare = sourceSection(
    rendererSource,
    "fn prepare_exact_draw",
    "fn expanded_indices",
  );
  assert.match(prepare, /draw\.exact_clip_input\?;/);
  assert.match(
    prepare,
    /let Ok\(geometry\) = gx_exact_draw_raster_geometry\(draw, source_vertices\) else \{\s*return Some\(PreparedExactDraw::Unqualified\);/,
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
    /PreparedExactDraw::Qualified\(QualifiedExactDraw \{[\s\S]*vertices: geometry\.into_vertices\(\),[\s\S]*expanded,[\s\S]*scissor,/,
  );
});

test("authoritative empty and depth-only routing precede all TEV gates", () => {
  const draw = sourceSection(
    rendererSource,
    "fn push_tev_draw_inner",
    "fn push_expanded_draw",
  );
  assertOrdered(draw, [
    "metrics.record_draw_transport",
    "let qualified_exact",
    "QualifiedExactDraw::is_empty",
    "gx_early_depth_plan",
    "GxEarlyDepthPlan::DepthOnly",
    "required_texture_maps",
  ]);
  assert.match(
    draw,
    /QualifiedExactDraw::is_empty\) \{[\s\S]*return Ok\(\(\)\);[\s\S]*let early_depth/,
  );
  assert.match(
    draw,
    /if early_depth == GxEarlyDepthPlan::DepthOnly \{[\s\S]*source_vertices,[\s\S]*&expanded,[\s\S]*ManagedCoverageEvidence::None/,
  );
});

test("exact managed geometry wins and unsafe exact input falls back natively", () => {
  const draw = sourceSection(
    rendererSource,
    "fn push_tev_draw_inner",
    "fn push_expanded_draw",
  );
  assertOrdered(draw, [
    "let exact_managed",
    "let managed_expanded",
    "let managed_evidence",
    "let scissor = if let Some(exact)",
    "pipeline = pipeline.with_managed_coverage()",
  ]);
  assert.match(
    draw,
    /let exact_managed = qualified_exact\.filter\([\s\S]*ManagedCoverageEvidence::TrustedExactClip[\s\S]*exact\.vertices[\s\S]*&exact\.expanded[\s\S]*scissor/,
  );
  assert.match(
    draw,
    /let managed_expanded = prepared_exact\s*\.is_none\(\)/,
  );
  assert.match(
    draw,
    /let scissor = if let Some\(exact\) = exact_managed \{[\s\S]*exact[\s\S]*\.scissor[\s\S]*\} else \{[\s\S]*native_scissor/,
  );
  assert.match(
    draw,
    /if let Some\(exact\) = exact_managed \{\s*\(exact\.vertices\.as_slice\(\), exact\.expanded\.as_slice\(\), 0\.0\)/,
  );
  assert.match(
    draw,
    /else \{\s*\(\s*source_vertices,\s*expanded\.as_slice\(\),\s*raster_position_correction,/,
  );
  assert.doesNotMatch(
    draw,
    /expanded_indices\([^)]*exact|source_indices\(\)/,
  );
});

test("exact activation retains every managed shader-safety gate", () => {
  const qualification = sourceSection(
    rendererSource,
    "fn managed_coverage_draw_is_safe",
    "fn managed_coverage_triangle_vertices",
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
    "managed_coverage_payload_is_safe",
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
  assert.match(
    qualification,
    /evidence == ManagedCoverageEvidence::TrustedPostCull && !depth_is_flat/,
  );
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
