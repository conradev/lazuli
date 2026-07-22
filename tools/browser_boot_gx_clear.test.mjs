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

function rendererSection(startText, endText) {
  const start = rendererSource.indexOf(startText);
  const end = rendererSource.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1, `missing ${startText}`);
  assert.notEqual(end, -1, `missing ${endText}`);
  return rendererSource.slice(start, end);
}

function sourceSection(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1, `missing ${startText}`);
  assert.notEqual(end, -1, `missing ${endText}`);
  return source.slice(start, end);
}

test("reset remains an unconditional full-EFB clear", () => {
  const reset = rendererSection("pub fn reset(&mut self)", "pub fn reset_diagnostics");
  assert.match(reset, /self\.reset_efb_inner\(\)/);
  assert.doesNotMatch(reset, /gx_copy_clear_mask|encode_copy_clear/);

  const resetInner = rendererSection("fn reset_efb_inner", "fn clear_copy_region_inner");
  assert.match(resetInner, /LoadOp::Clear\(wgpu::Color/);
  assert.match(resetInner, /r: 0\.0,\s*g: 0\.0,\s*b: 0\.0,\s*a: 1\.0/s);
  assert.match(resetInner, /load: wgpu::LoadOp::Clear\(1\.0\)/);
  assert.doesNotMatch(resetInner, /set_scissor_rect/);
});

test("texture and XFB copies encode their clipped clear after the copy and before submit", () => {
  for (const [start, end] of [
    ["fn copy_texture_inner", "pub fn copy_xfb"],
    ["fn copy_xfb_inner", "pub fn present_xfb"],
  ]) {
    const section = rendererSection(start, end);
    const clip = section.indexOf("clipped_copy_extent");
    const copy = section.indexOf("encoder.copy_texture_to_texture");
    const clear = section.indexOf("self.encode_copy_clear");
    const submit = section.indexOf("self.queue.submit", clear);
    assert.notEqual(clip, -1, `${start} must compute a clipped extent`);
    assert.notEqual(copy, -1, `${start} must encode a texture copy`);
    assert.notEqual(clear, -1, `${start} must encode a copy clear`);
    assert.notEqual(submit, -1, `${start} must submit the encoder`);
    assert.ok(clip < copy, `${start} must clip before copying`);
    assert.ok(copy < clear, `${start} cleared before copying`);
    assert.ok(clear < submit, `${start} submitted before clearing`);
  }
});

test("the draw clear loads prior EFB contents and independently masks RGB alpha and depth", () => {
  const resources = rendererSection(
    "fn create_copy_clear_resources",
    "fn encode_copy_clear_pass",
  );
  assert.match(resources, /if mask\.color \{\s*write_mask \|= wgpu::ColorWrites::COLOR/s);
  assert.match(resources, /if mask\.alpha \{\s*write_mask \|= wgpu::ColorWrites::ALPHA/s);
  assert.match(resources, /depth_write_enabled: Some\(mask\.depth\)/);
  assert.match(resources, /depth_compare: Some\(wgpu::CompareFunction::Always\)/);

  const pass = rendererSection("fn encode_copy_clear_pass", "fn create_pipelines");
  assert.equal(pass.match(/load: wgpu::LoadOp::Load/g)?.length, 2);
  assert.match(pass, /pass\.set_scissor_rect\(/);
  assert.match(pass, /pass\.draw\(0\.\.3, 0\.\.1\)/);
});

test("GX depth endpoints span the full unsigned 24-bit range in clears and draws", () => {
  const vertexShader = sourceSection(
    tevSource,
    "pub(crate) const TEV_VERTEX_WGSL",
    "pub(crate) const TEV_WGSL",
  );
  const readbackConversion = sourceSection(
    rendererCoreSource,
    "pub(crate) fn gx_float_to_depth24",
    "pub(crate) enum GxBlendFactor",
  );
  assert.match(
    rendererCoreSource,
    /\(depth & GX_DEPTH24_MAX\) as f32 \/ GX_DEPTH24_MAX as f32/,
  );
  assert.match(vertexShader, /input\.position\.z \/ 16777215\.0/);
  assert.doesNotMatch(vertexShader, /input\.position\.z \/ 16777216\.0/);
  assert.match(readbackConversion, /\* GX_DEPTH24_MAX as f32\)\.round\(\) as u32/);
  assert.doesNotMatch(rendererCoreSource, /GX_DEPTH24_SCALE|GX_DEPTH24_MAX_FLOAT/);
});
