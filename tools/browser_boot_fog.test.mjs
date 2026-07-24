import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workerSource = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);
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

test("LZGX v3 carries complete raw fog state into one canonical WebGPU draw uniform", () => {
  const worker = sourceSection(
    workerSource,
    "function gxDrawPipelineState",
    "function gxDrawTexCoords",
  );
  for (const field of [
    "fogRangeBase",
    "fogRangeK",
    "fogWords",
    "viewportHalfWidthBits",
  ]) {
    assert.match(worker, new RegExp(field));
  }

  const submit = sourceSection(
    rendererSource,
    "pub fn submit_gx_frame",
    "fn push_tev_draw_inner",
  );
  assert.match(
    submit,
    /draw\.record\.fragment_tail\.fog_range_base,\s*draw\.record\.fragment_tail\.fog_range_k,\s*draw\.record\.fragment_tail\.fog_words,\s*draw\.record\.fragment_tail\.viewport_half_width_bits,/s,
  );

  const draw = sourceSection(
    rendererSource,
    "fn push_tev_draw_inner",
    "pub fn copy_texture",
  );
  assert.match(
    draw,
    /gx_fog_state\(\s*fog_range_base,\s*fog_range_coefficients,\s*fog_parameters,\s*viewport_half_width_bits,/s,
  );
  assert.match(
    draw,
    /DrawUniform::from_gx\(\s*alpha_test,\s*destination_alpha,\s*z_texture,\s*depth_encoding,\s*pipeline\.canonical_fragment_depth,\s*fog,\s*\)/s,
  );
  assert.match(
    draw,
    /let fog = if pipeline\.blend\.color_write \{\s*fog\s*\} else \{\s*GxFogState::default\(\)\s*\};/s,
  );

  const uniform = sourceSection(
    rendererSource,
    "struct DrawUniform",
    "struct CopyClearUniform",
  );
  for (const field of [
    "fog_control",
    "fog_range0",
    "fog_range1",
    "fog_parameters0",
    "fog_parameters1",
  ]) {
    assert.match(uniform, new RegExp(`${field}: \\[u32; 4\\]`));
  }
  assert.match(uniform, /size_of::<DrawUniform>\(\) == 96/);
  assert.match(uniform, /fog_control: \[fog\.range_base, 0, 0, 0\]/);
});

test("WebGPU fog consumes theoretical post-Z-texture depth before destination alpha and blending", () => {
  const fragment = sourceSection(
    tevSource,
    "pub(crate) const TEV_FRAGMENT_WGSL",
    "pub(crate) fn shader_source",
  );
  const alphaTest = fragment.indexOf(
    "if !alpha_test_passes(tev_alpha, draw_state.alpha_test)",
  );
  const zTexture = fragment.indexOf(
    "let operation_depth = gx_z_texture_depth(raster_depth, evaluation.raw_texture)",
  );
  const fog = fragment.indexOf(
    "gx_fog_color(unorm_source, input.position.x, operation_depth)",
  );
  const destinationAlpha = fragment.indexOf(
    "if (draw_state.destination_alpha & 0x100u) == 0x100u",
  );
  assert.ok(
    alphaTest >= 0 &&
      alphaTest < zTexture &&
      zTexture < fog &&
      fog < destinationAlpha,
  );
  assert.match(fragment, /if operation == 0u \{\s*return reference_depth;/s);
  assert.match(fragment, /let fog_enabled = \(draw_state\.fragment_flags & 2u\) != 0u/);
  assert.match(fragment, /if needs_fragment_depth \|\| fog_enabled \{/);
  assert.match(
    fragment,
    /buffer_depth = select\(raster_depth, operation_depth, late_z_texture\)/,
  );
  assert.match(fragment, /let values = tev_fragment_values\(input, false\)/);
  assert.match(fragment, /let values = tev_fragment_values\(input, true\)/);
  assert.match(fragment, /values\.buffer_depth = buffer_depth/);
  assert.match(
    fragment,
    /output\.depth = gx_efb_depth_to_attachment\(values\.buffer_depth, depth_encoding\)/,
  );
  assert.match(fragment, /return vec4<u32>\(rgb, source\.a\)/);
});

test("WebGPU fog pins signed 24-bit equations and the native raw range table", () => {
  const fragment = sourceSection(
    tevSource,
    "pub(crate) const TEV_FRAGMENT_WGSL",
    "pub(crate) fn shader_source",
  );
  assert.match(
    fragment,
    /i32\(gx_fog_parameter\(1u\) & 0x00ffffffu\) - i32\(shifted\)/,
  );
  assert.match(fragment, /a_and_c\.x \* 16777216\.0/);
  assert.match(fragment, /a_and_c\.x \* f32\(depth\) \/ 16777216\.0/);
  assert.match(fragment, /raw = word & 0xfffu/);
  assert.match(fragment, /raw = \(word >> 12u\) & 0xfffu/);
  assert.match(fragment, /return f32\(raw\) \/ 256\.0/);
  assert.match(fragment, /abs\(position_x - f32\(center\)\) \/ 32\.0/);
  assert.doesNotMatch(fragment, /sqrt\(/);
  assert.match(fragment, /u32\(floor\(factor \* 256\.0 \+ 0\.5\)\)/);
  assert.match(fragment, /factor = 1\.0 - exp2\(-8\.0 \* factor\)/);
  assert.match(fragment, /factor = exp2\(-8\.0 \* \(1\.0 - factor\)\)/);
});
