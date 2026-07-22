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

test("WebGPU VI presentation uses only exact integer scanout rows", () => {
  const shader = presentShader();

  assert.match(shader, /@builtin\(position\)/);
  assert.match(shader, /let field_line = min\(output_y \/ row_repeat, field_height - 1u\)/);
  assert.match(shader, /let logical_y = selected_row \+ field_line \* source_row_step/);
  assert.match(shader, /textureLoad\(source_texture,/);
  assert.doesNotMatch(shader, /textureSample/);
  assert.doesNotMatch(shader, /\bsampler\b/);
  assert.doesNotMatch(shader, /source_rect|normalized|uv/);
});

test("WebGPU VI presentation binds an unfilterable texture and integer plan uniform", () => {
  assert.match(
    source,
    /label: Some\("browser XFB presentation layout"\)[\s\S]*Float \{ filterable: false \}[\s\S]*BufferBindingType::Uniform/,
  );
  assert.match(source, /write_buffer\(&surface\.present_uniform,[\s\S]*bytes_of\(&uniform\)/);
  assert.doesNotMatch(source, /source_rect_buffer/);
});

test("invalid scanout plans fail before surface acquisition and clear prior evidence", () => {
  const start = source.indexOf("    pub fn present_xfb(");
  const end = source.indexOf("\n}\n\nimpl WebGpuRenderer {", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const method = source.slice(start, end);
  const clearXfb = method.indexOf("self.last_presented_xfb = None");
  const clearSurface = method.indexOf("self.last_presented_surface = None");
  const validate = method.indexOf("xfb_scanout_plan(");
  const acquire = method.indexOf("self.surface.get_current_texture()");

  assert.ok(clearXfb >= 0 && clearXfb < validate);
  assert.ok(clearSurface >= 0 && clearSurface < validate);
  assert.ok(validate >= 0 && validate < acquire);
  assert.doesNotMatch(method, /\.clamp\(/);
});
