// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../crates/browser-renderer/src/web.rs", import.meta.url),
  "utf8",
);

function presentShader() {
  const start = source.indexOf('const PRESENT_SHADER: &str = "');
  assert.notEqual(start, -1, "missing WebGPU XFB presentation shader");
  const end = source.indexOf('\n";', start);
  assert.notEqual(end, -1, "unterminated WebGPU XFB presentation shader");
  return source.slice(start, end);
}

test("WebGPU VI presentation weaves two exact integer-loaded field textures", () => {
  const shader = presentShader();

  assert.match(shader, /@builtin\(position\)/);
  assert.match(shader, /@binding\(0\) var top_texture: texture_2d<f32>/);
  assert.match(shader, /@binding\(1\) var bottom_texture: texture_2d<f32>/);
  assert.match(shader, /present\.options\.x == 1u && \(output_y & 1u\) == 1u/);
  assert.equal(
    [...shader.matchAll(
      /let field_line = min\(output_y \/ row_repeat, field_height - 1u\)/g,
    )].length,
    2,
  );
  assert.equal(
    [...shader.matchAll(
      /let logical_y = selected_row \+ field_line \* source_row_step/g,
    )].length,
    2,
  );
  assert.match(shader, /textureLoad\(top_texture,/);
  assert.match(shader, /textureLoad\(bottom_texture,/);
  assert.doesNotMatch(shader, /textureSample/);
  assert.doesNotMatch(shader, /\bsampler\b/);
  assert.doesNotMatch(shader, /source_rect|normalized|uv/);
});

test("WebGPU VI presentation reuses one uniform and a bounded two-view binding cache", () => {
  const layoutStart = source.indexOf(
    'label: Some("browser XFB presentation layout")',
  );
  const layoutEnd = source.indexOf("let copy_clear =", layoutStart);
  assert.notEqual(layoutStart, -1);
  assert.notEqual(layoutEnd, -1);
  const layout = source.slice(layoutStart, layoutEnd);
  assert.equal(
    [...layout.matchAll(/Float \{ filterable: false \}/g)].length,
    2,
  );
  assert.match(layout, /binding: 2,[\s\S]*BufferBindingType::Uniform/);
  assert.match(source, /const XFB_PRESENT_BIND_GROUP_CACHE_CAPACITY: usize = 32/);
  assert.match(source, /struct XfbPresentResources \{[\s\S]*uniform: wgpu::Buffer,[\s\S]*VecDeque/);
  assert.match(
    source,
    /write_buffer\(&self\.xfb_present\.uniform, 0, bytemuck::bytes_of\(&uniform\)\)/,
  );
  assert.match(
    source,
    /if self\.xfb_present\.bindings\.len\(\) == XFB_PRESENT_BIND_GROUP_CACHE_CAPACITY[\s\S]*pop_front\(\)/,
  );
  assert.doesNotMatch(
    source.slice(
      source.indexOf("struct CachedXfbSurface"),
      source.indexOf("struct CachedXfbPresentBinding"),
    ),
    /present_uniform|present_bind_group/,
  );
  assert.doesNotMatch(source, /source_rect_buffer/);
});

test("only Ready frames acquire the canvas while staged fields preserve complete evidence", () => {
  const start = source.indexOf("    pub fn present_xfb(");
  const end = source.indexOf("\n}\n\nimpl WebGpuRenderer {", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const wrapper = source.slice(start, end);
  const typedStart = source.indexOf("    fn present_xfb_typed(", end);
  const typedEnd = source.indexOf("\n    fn present_host_xfb_frame(", typedStart);
  assert.notEqual(typedStart, -1);
  assert.notEqual(typedEnd, -1);
  const method = source.slice(typedStart, typedEnd);
  const validate = method.indexOf("xfb_scanout_plan(");
  const stage = method.indexOf("ViFieldPairOutcome::Awaiting");
  const ready = method.indexOf("ViFieldPairOutcome::Ready");
  const present = method.indexOf("self.present_host_xfb_frame");
  const rejectZeroEpoch = wrapper.indexOf("if pair_epoch == 0");
  const typedRejectZeroEpoch = method.indexOf("if pair_epoch == 0");
  const parseMode = wrapper.indexOf("vi_presentation_mode(");
  const parseParity = wrapper.indexOf("vi_field_parity(");
  const lookupXfb = method.indexOf(".xfb_cache");
  const unavailableRetirements = [
    ...method.matchAll(/reject_unavailable_member\(mode, pair_epoch, parity\)/g),
  ];

  assert.match(
    wrapper,
    /capture_surface: bool,\s*capture_sustained_surface_history: bool,/,
  );
  assert.match(
    wrapper,
    /xfb_presentation_result_from_outcome\(self\.present_xfb_typed\([\s\S]*?capture_surface,\s*capture_sustained_surface_history,/,
  );
  assert.match(
    method,
    /self\.present_host_xfb_frame\(\s*frame,\s*capture_surface,\s*capture_sustained_surface_history,/,
  );
  assert.ok(rejectZeroEpoch >= 0 && rejectZeroEpoch < parseMode);
  assert.ok(rejectZeroEpoch < parseParity);
  assert.match(
    wrapper.slice(rejectZeroEpoch, parseMode),
    /xfb_presentation_result\(\s*false,\s*false,\s*"vi-field-invalid-epoch",\s*pair_epoch,\s*None,/,
  );
  assert.ok(typedRejectZeroEpoch >= 0 && typedRejectZeroEpoch < lookupXfb);
  assert.ok(validate >= 0 && validate < stage);
  assert.ok(stage >= 0 && stage < ready && ready < present);
  assert.equal(
    unavailableRetirements.length,
    2,
    "both missing and stale XFB provenance must retire an exact pending mate",
  );
  assert.doesNotMatch(method, /get_current_texture/);
  assert.doesNotMatch(method, /last_presented_(?:xfb|surface) = None/);
  assert.doesNotMatch(method, /\.clamp\(/);

  const helperStart = source.indexOf("    fn present_host_xfb_frame(");
  const helperEnd = source.indexOf("\n    fn xfb_present_bind_group", helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  assert.match(
    helper,
    /capture_surface: bool,\s*capture_sustained_surface_history: bool,/,
  );
  assert.ok(
    helper.indexOf(
      ".capture_requested(capture_sustained_surface_history)",
    ) < helper.indexOf("self.surface.get_current_texture()"),
    "history gaps and overflow must fail before acquiring a canvas texture",
  );
  assert.match(helper, /self\.surface\.get_current_texture\(\)/);
  assert.equal([...helper.matchAll(/begin_render_pass/g)].length, 1);
  assert.ok(
    helper.indexOf('"browser sustained presented surface readback"')
      < helper.indexOf("self.queue.submit"),
    "optional sustained capture must be encoded before the presentation submit",
  );
  assert.doesNotMatch(helper, /BufferMap::new|QueueDrain::new|future_to_promise|\.await/);

  const resetStart = source.indexOf("    pub fn reset(&mut self)");
  const resetEnd = source.indexOf("    pub fn reset_diagnostics", resetStart);
  const reset = source.slice(resetStart, resetEnd);
  assert.ok(reset.indexOf("self.vi_field_pairs.reset()") < reset.indexOf("self.ensure_healthy()?"));
  assert.ok(
    reset.indexOf("self.sustained_presented_surface_history.reset()")
      < reset.indexOf("self.ensure_healthy()?"),
  );
});
