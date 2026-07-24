import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rendererSource = readFileSync(
  new URL("../crates/browser-renderer/src/web.rs", import.meta.url),
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

function rendererSection(startText, endText) {
  return sourceSection(rendererSource, startText, endText);
}

test("LZGX v3 Z-texture tail selects exact late fragment depth without touching ordinary draws", () => {
  const submit = rendererSection("pub fn submit_gx_frame", "fn push_tev_draw_inner");
  assert.match(
    submit,
    /draw\.record\.fragment_tail\.z_texture_bias,\s*draw\.record\.fragment_tail\.z_texture_mode,/s,
  );

  const draw = rendererSection("fn push_tev_draw_inner", "pub fn copy_texture");
  assert.match(
    draw,
    /gx_z_texture_state\(z_texture_bias, z_texture_mode, pixel_control\)/,
  );
  assert.match(draw, /map_err\(\|error\| JsValue::from_str\(&error\.to_string\(\)\)\)/);

  const key = rendererSection("impl PipelineKey", "fn color_blend_component");
  assert.match(key, /late_fragment_depth: depth_enabled/);
  assert.match(key, /z_texture\.operation != GxZTextureOperation::Disabled/);
  assert.match(
    key,
    /z_texture\.depth_compare_location == GxDepthCompareLocation::Late/,
  );

  const pipeline = rendererSection(
    "fn create_tev_geometry_pipeline",
    "fn create_xfb_copy_resources",
  );
  assert.match(pipeline, /unclipped_depth: key\.late_fragment_depth/);
  assert.match(
    pipeline,
    /entry_point: Some\(if key\.late_fragment_depth \{\s*"fs_depth_main"\s*\} else \{\s*"fs_main"/s,
  );

  const fragment = sourceSection(
    tevSource,
    "pub(crate) const TEV_FRAGMENT_WGSL",
    "pub(crate) fn shader_source",
  );
  assert.match(fragment, /@builtin\(frag_depth\) depth: f32/);
  assert.match(fragment, /fn fs_depth_main/);
  assert.match(
    fragment,
    /u32\(round\(clamp\(input\.depth24, 0\.0, 16777215\.0\)\)\)/,
  );
  assert.match(tevSource, /@location\(10\) @interpolate\(linear\) depth24: f32/);
  assert.match(tevSource, /output\.depth24 = input\.position\.z/);
  assert.match(fragment, /source = raw_texture\.a/);
  assert.match(fragment, /raw_texture\.a << 8u\) \| raw_texture\.r/);
  assert.match(
    fragment,
    /raw_texture\.r << 16u\) \| \(raw_texture\.g << 8u\) \| raw_texture\.b/,
  );
  assert.match(fragment, /& 0x00ffffffu/);

  const tev = sourceSection(
    tevSource,
    "struct TevEvaluation",
    "pub(crate) const TEV_FRAGMENT_WGSL",
  );
  assert.match(tev, /var raw_texture = vec4<i32>\(0\)/);
  assert.match(
    tev,
    /texture_base = tev_sample_texture[\s\S]*raw_texture = texture_base[\s\S]*tev_swizzle\(texture_base/,
  );
});
