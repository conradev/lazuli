import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rendererSource = readFileSync(
  new URL("../crates/browser-renderer/src/web.rs", import.meta.url),
  "utf8",
);
const rendererCoreSource = readFileSync(
  new URL("../crates/browser-renderer/src/lib.rs", import.meta.url),
  "utf8",
);
const tevSource = readFileSync(
  new URL("../crates/browser-renderer/src/tev.rs", import.meta.url),
  "utf8",
);

function sourceSection(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1, `missing ${startText}`);
  assert.notEqual(end, -1, `missing ${endText}`);
  return source.slice(start, end);
}

test("GX alpha outcome and early-depth planning are exact over the u8 alpha domain", () => {
  const planner = sourceSection(
    rendererCoreSource,
    "pub(crate) enum GxAlphaTestOutcome",
    "fn source_blend_factor",
  );
  for (const outcome of ["AlwaysPass", "AlwaysFail", "Variable"]) {
    assert.match(planner, new RegExp(outcome));
  }
  for (const plan of ["FixedFunction", "DepthOnly", "PrimitiveOrdered"]) {
    assert.match(planner, new RegExp(plan));
  }
  assert.match(planner, /fn alpha_values_below\(limit: u16\) -> \[u64; 4\]/);
  assert.match(planner, /fn alpha_comparison_mask/);
  assert.match(planner, /first\[word\] & second\[word\]/);
  assert.match(planner, /first\[word\] \| second\[word\]/);
  assert.match(planner, /first\[word\] \^ second\[word\]/);
  assert.match(planner, /!\(first\[word\] \^ second\[word\]\)/);
  assert.match(planner, /z_mode & 1 != 0/);
  assert.match(planner, /z_mode & \(1 << 4\) != 0/);
  assert.match(planner, /pixel_control & \(1 << 6\) != 0/);
  assert.match(planner, /blend\.color_write/);
  assert.match(planner, /blend\.alpha_write && gx_efb_format\(pixel_control\)\.has_alpha\(\)/);
});

test("browser draw routing keeps fixed-function fast paths and manages only variable early alpha", () => {
  const draw = sourceSection(
    rendererSource,
    "fn push_tev_draw_inner",
    "pub fn copy_texture",
  );
  assert.match(
    draw,
    /gx_early_depth_plan\(z_mode, blend_mode, alpha_test, pixel_control\)/,
  );
  assert.match(
    draw,
    /\.color_pipeline_for_early_depth\(early_depth\)/,
  );
  assert.match(draw, /early_depth,\s*scissor,\s*binding,/s);

  const key = sourceSection(
    rendererSource,
    "impl PipelineKey",
    "fn color_blend_component",
  );
  assert.match(
    key,
    /plan == GxEarlyDepthPlan::PrimitiveOrdered \{\s*self\.depth\.write = false;/s,
  );
  assert.match(
    key,
    /DepthCommitPipelineKey[\s\S]*primitive: pipeline\.primitive,[\s\S]*cull: pipeline\.cull,[\s\S]*compare: pipeline\.depth\.compare/,
  );
});

test("managed early depth pairs color then unconditional depth commit per expanded primitive", () => {
  const flush = sourceSection(
    rendererSource,
    "fn flush_geometry",
    "fn clear_segment",
  );
  assert.match(
    flush,
    /GxEarlyDepthPlan::FixedFunction[\s\S]*pass\.draw\(command\.vertices\.clone\(\), 0\.\.1\)/,
  );
  assert.match(
    flush,
    /GxEarlyDepthPlan::DepthOnly[\s\S]*early_depth_commit\[&commit\][\s\S]*pass\.draw\(command\.vertices\.clone\(\), 0\.\.1\)/,
  );
  const managed = sourceSection(
    flush,
    "GxEarlyDepthPlan::PrimitiveOrdered",
    "self.tev_vertices.clear()",
  );
  assert.match(managed, /expanded_primitive_ranges\(/);
  const color = managed.indexOf("pass.set_pipeline(color)");
  const colorDraw = managed.indexOf("pass.draw(vertices.clone()", color);
  const commit = managed.indexOf("pass.set_pipeline(commit)", colorDraw);
  const commitDraw = managed.indexOf("pass.draw(vertices, 0..1)", commit);
  assert.ok(
    color >= 0 &&
      color < colorDraw &&
      colorDraw < commit &&
      commit < commitDraw,
    "each primitive must attempt color before its unconditional depth commit",
  );

  const ranges = sourceSection(
    rendererSource,
    "fn primitive_vertex_width",
    "fn color_blend_component",
  );
  assert.match(ranges, /Primitive::Triangles => 3/);
  assert.match(ranges, /Primitive::Lines => 2/);
  assert.match(ranges, /Primitive::Points => 1/);
  assert.match(ranges, /\.step_by\(width as usize\)/);
});

test("WebGPU depth commits preserve source Z without TEV color or alpha side effects", () => {
  const pipeline = sourceSection(
    rendererSource,
    "fn create_early_depth_commit_pipeline",
    "fn tev_vertex_layout",
  );
  assert.match(pipeline, /entry_point: Some\("vs_main"\)/);
  assert.match(pipeline, /depth_write_enabled: Some\(true\)/);
  assert.match(pipeline, /depth_compare: Some\(key\.compare\)/);
  assert.match(pipeline, /entry_point: Some\(match key\.depth_encoding/);
  for (const entry of [
    "fs_early_depth_commit_z24",
    "fs_early_depth_commit_z16_linear",
    "fs_early_depth_commit_z16_near",
    "fs_early_depth_commit_z16_mid",
    "fs_early_depth_commit_z16_far",
  ]) {
    assert.match(pipeline, new RegExp(`"${entry}"`));
  }
  assert.match(pipeline, /write_mask: wgpu::ColorWrites::empty\(\)/);
  assert.match(pipeline, /unclipped_depth: false/);
  assert.doesNotMatch(pipeline, /fs_depth_main/);

  const commit = sourceSection(
    tevSource,
    "fn gx_early_depth_commit(",
    "fn alpha_compare",
  );
  assert.match(commit, /gx_raster_depth24\(input\.depth24\)/);
  assert.match(commit, /gx_efb_depth_to_attachment/);
  assert.match(commit, /CanonicalDepthOutput/);
  for (const forbidden of [
    "discard",
    "tev_evaluate",
    "textureSample",
    "fog",
    "destination_alpha",
    "draw_state",
  ]) {
    assert.doesNotMatch(commit, new RegExp(forbidden));
  }
});

test("early-depth compatibility work is visible in renderer diagnostics", () => {
  const metrics = sourceSection(
    rendererSource,
    "fn renderer_metrics_object",
    "fn surface_pixel_order",
  );
  for (const name of [
    "depthCommitDraws",
    "earlyDepthOnlyCommands",
    "managedEarlyDepthCommands",
    "managedEarlyDepthPrimitives",
  ]) {
    assert.match(metrics, new RegExp(`"${name}"`));
  }
});
