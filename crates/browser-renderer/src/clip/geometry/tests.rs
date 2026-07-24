use super::*;

fn exact_state(cull_mode: u8) -> GxExactClipState {
    GxExactClipState {
        bp_gen_mode: u32::from(cull_mode) << GX_GEN_MODE_CULL_SHIFT,
        bp_scissor_top_left: (342 << 12) | 342,
        bp_scissor_bottom_right: ((342 + 639) << 12) | (342 + 527),
        bp_scissor_offset: 171 | (171 << 10),
        xf_clip_disable: 0,
        viewport_bits: [
            320.0f32.to_bits(),
            (-264.0f32).to_bits(),
            16_777_215.0f32.to_bits(),
            662.0f32.to_bits(),
            606.0f32.to_bits(),
            16_777_215.0f32.to_bits(),
        ],
    }
}

fn source_vertices(vertex_count: usize) -> Vec<f32> {
    let flat_rasters = [0.0, -0.0, 0.25, 1.0, 2.0, 4.0, 8.0, 255.0];
    let mut vertices = vec![0.0; vertex_count * TEV_VERTEX_FLOATS];
    for vertex in 0..vertex_count {
        let offset = vertex * TEV_VERTEX_FLOATS;
        vertices[offset] = 100.0 + vertex as f32;
        vertices[offset + 1] = 200.0 + vertex as f32;
        // Legacy projected Z is deliberately not authoritative.
        vertices[offset + 2] = 300.0 + vertex as f32;
        vertices[offset + 3] = 1.0;
        vertices[offset + 4..offset + 12].copy_from_slice(&flat_rasters);
        vertices[offset + 12] = vertex as f32 * 2.0;
        for component in 13..TEV_VERTEX_FLOATS {
            vertices[offset + component] = component as f32 + vertex as f32;
        }
    }
    vertices
}

fn vertex_slices(vertices: &[f32]) -> Vec<&[f32]> {
    vertices.chunks_exact(TEV_VERTEX_FLOATS).collect()
}

#[test]
fn partial_clip_composes_exact_fan_payload_and_source_provenance() {
    let source = source_vertices(3);
    let clip = [
        [0.0, 0.0, -0.5, 1.0],
        [2.0, 0.0, -0.5, 1.0],
        [0.0, 1.0, -0.5, 1.0],
    ];
    let geometry = gx_exact_raster_geometry(2, 0, &source, &clip, exact_state(0)).unwrap();
    assert_eq!(geometry.triangle_count(), 2);
    assert_eq!(geometry.source_indices(), [[0, 1, 2], [0, 1, 2]]);
    assert_eq!(geometry.scissor_rect(), [0, 0, 640, 528]);
    assert_eq!(
        geometry.raster_scissor(),
        GxRasterScissor::new(0, 0, 640, 528, 0, 0).unwrap()
    );

    let vertices = vertex_slices(geometry.vertices());
    assert_eq!(vertices.len(), 6);
    assert_eq!(
        vertices
            .iter()
            .map(|vertex| [vertex[0], vertex[1]])
            .collect::<Vec<_>>(),
        [
            [320.0, 264.0],
            [640.0, 264.0],
            [640.0, 132.0],
            [320.0, 264.0],
            [640.0, 132.0],
            [320.0, 0.0],
        ]
    );
    assert!(
        vertices
            .iter()
            .all(|vertex| vertex[2].to_bits() == 8_388_607.5f32.to_bits())
    );
    assert!(vertices.iter().all(|vertex| vertex[3] == 1.0));
    assert_eq!(
        vertices.iter().map(|vertex| vertex[12]).collect::<Vec<_>>(),
        [0.0, 1.0, 3.0, 0.0, 3.0, 4.0],
        "STQ payload follows the literal OUT + ((IN - OUT) * T) fan walk"
    );
    for vertex in vertices {
        assert_eq!(
            vertex[4..12]
                .iter()
                .copied()
                .map(f32::to_bits)
                .collect::<Vec<_>>(),
            source[4..12]
                .iter()
                .copied()
                .map(f32::to_bits)
                .collect::<Vec<_>>(),
            "flat rasters are stamped instead of using the inexact color clip path"
        );
    }
}

#[test]
fn source_rasters_are_flat_but_legacy_depth_may_vary() {
    let source = source_vertices(3);
    assert_ne!(source[2].to_bits(), source[TEV_VERTEX_FLOATS + 2].to_bits());
    let clip = [
        [-0.5, -0.5, -0.5, 1.0],
        [0.5, -0.5, -0.5, 1.0],
        [-0.5, 0.5, -0.5, 1.0],
    ];
    assert!(
        gx_exact_raster_geometry(2, 0, &source, &clip, exact_state(0)).is_ok(),
        "exact projected depth replaces the legacy f64 projection"
    );

    for component in 4..12 {
        let mut varying = source.clone();
        varying[TEV_VERTEX_FLOATS + component] =
            f32::from_bits(varying[TEV_VERTEX_FLOATS + component].to_bits() ^ 1);
        assert_eq!(
            gx_exact_raster_geometry(2, 0, &varying, &clip, exact_state(0)),
            Err(GxExactGeometryError::UnsupportedSourceRaster),
            "varying raster component {component} was accepted"
        );
    }
}

#[test]
fn backfaces_reorder_payload_but_keep_original_provenance() {
    let source = source_vertices(3);
    let backface = [
        [-0.5, -0.5, -0.5, 1.0],
        [-0.5, 0.5, -0.5, 1.0],
        [0.5, -0.5, -0.5, 1.0],
    ];
    let geometry = gx_exact_raster_geometry(2, 0, &source, &backface, exact_state(0)).unwrap();
    assert_eq!(geometry.source_indices(), [[0, 1, 2]]);
    assert_eq!(
        vertex_slices(geometry.vertices())
            .iter()
            .map(|vertex| vertex[12])
            .collect::<Vec<_>>(),
        [0.0, 4.0, 2.0],
        "backfaces normalize from source 012 to raster order 021"
    );
}

#[test]
fn strip_fans_retain_their_original_source_triples() {
    let source = source_vertices(4);
    let strip = [
        [-0.5, -0.5, -0.5, 1.0],
        [0.5, -0.5, -0.5, 1.0],
        [-0.5, 0.5, -0.5, 1.0],
        [0.5, 0.5, -0.5, 1.0],
    ];
    let geometry = gx_exact_raster_geometry(3, 0, &source, &strip, exact_state(0)).unwrap();
    assert_eq!(geometry.triangle_count(), 2);
    assert_eq!(geometry.source_indices(), [[0, 1, 2], [1, 3, 2]]);
}

#[test]
fn fully_rejected_geometry_is_an_authoritative_empty_result() {
    let source = source_vertices(3);
    let front = [
        [-0.5, -0.5, -0.5, 1.0],
        [0.5, -0.5, -0.5, 1.0],
        [-0.5, 0.5, -0.5, 1.0],
    ];
    let culled = gx_exact_raster_geometry(2, 1, &source, &front, exact_state(1)).unwrap();
    assert_eq!(culled.triangle_count(), 0);
    assert!(culled.vertices().is_empty());
    assert!(culled.source_indices().is_empty());

    let behind = [[0.0, 0.0, 0.0, -1.0]; 3];
    let clipped = gx_exact_raster_geometry(2, 0, &source, &behind, exact_state(0)).unwrap();
    assert_eq!(clipped.triangle_count(), 0);

    let mut invisible_scissor = exact_state(0);
    invisible_scissor.bp_scissor_top_left = (1042 << 12) | 342;
    invisible_scissor.bp_scissor_bottom_right = (1100 << 12) | (342 + 527);
    let invisible = gx_exact_raster_geometry(2, 0, &source, &front, invisible_scissor).unwrap();
    assert_eq!(invisible.triangle_count(), 0);
    assert_eq!(invisible.scissor_rect(), [0, 0, 0, 0]);
}

#[test]
fn exact_state_activation_gates_reject_atomically() {
    let source = source_vertices(3);
    let clip = [
        [-0.5, -0.5, -0.5, 1.0],
        [0.5, -0.5, -0.5, 1.0],
        [-0.5, 0.5, -0.5, 1.0],
    ];

    let mut aa = exact_state(0);
    aa.bp_gen_mode |= GX_GEN_MODE_MULTISAMPLING;
    assert_eq!(
        gx_exact_raster_geometry(2, 0, &source, &clip, aa),
        Err(GxExactGeometryError::UnsupportedMultisampling)
    );

    let mut z_freeze = exact_state(0);
    z_freeze.bp_gen_mode |= GX_GEN_MODE_Z_FREEZE;
    assert_eq!(
        gx_exact_raster_geometry(2, 0, &source, &clip, z_freeze),
        Err(GxExactGeometryError::UnsupportedZFreeze)
    );

    let mut clip_disable = exact_state(0);
    clip_disable.xf_clip_disable = 1;
    assert_eq!(
        gx_exact_raster_geometry(2, 0, &source, &clip, clip_disable),
        Err(GxExactGeometryError::Projection(
            GxExactProjectionError::UnsupportedClipDisable(1)
        ))
    );

    assert_eq!(
        gx_exact_raster_geometry(2, 1, &source, &clip, exact_state(0)),
        Err(GxExactGeometryError::CullModeStateMismatch)
    );
}

#[test]
fn post_clip_shader_restrictions_are_explicit() {
    let source = source_vertices(3);
    let flat = [
        [-0.5, -0.5, -0.5, 1.0],
        [0.5, -0.5, -0.5, 1.0],
        [-0.5, 0.5, -0.5, 1.0],
    ];

    let mut varying_depth = flat;
    varying_depth[1][2] = -0.25;
    assert_eq!(
        gx_exact_raster_geometry(2, 0, &source, &varying_depth, exact_state(0)),
        Err(GxExactGeometryError::UnsupportedPostClipDepthOrRaster)
    );

    let mut outside_position = exact_state(0);
    outside_position.viewport_bits[3] = 2_000.0f32.to_bits();
    assert_eq!(
        gx_exact_raster_geometry(2, 0, &source, &flat, outside_position),
        Err(GxExactGeometryError::UnsupportedPostClipPosition)
    );

    let mut outside_depth = exact_state(0);
    outside_depth.viewport_bits[2] = 1.0f32.to_bits();
    outside_depth.viewport_bits[5] = 0.0f32.to_bits();
    assert_eq!(
        gx_exact_raster_geometry(2, 0, &source, &flat, outside_depth),
        Err(GxExactGeometryError::UnsupportedPostClipDepth)
    );

    let zero_w = [[0.0, 0.0, 0.0, 0.0]; 3];
    assert_eq!(
        gx_exact_raster_geometry(2, 0, &source, &zero_w, exact_state(0)),
        Err(GxExactGeometryError::Projection(
            GxExactProjectionError::ZeroClipW
        ))
    );
}

#[test]
fn malformed_draw_inputs_never_return_partial_geometry() {
    let source = source_vertices(3);
    let clip = [
        [-0.5, -0.5, -0.5, 1.0],
        [0.5, -0.5, -0.5, 1.0],
        [-0.5, 0.5, -0.5, 1.0],
    ];
    assert_eq!(
        gx_exact_raster_geometry(2, 0, &[], &[], exact_state(0)),
        Err(GxExactGeometryError::InvalidVertexLayout)
    );
    assert_eq!(
        gx_exact_raster_geometry(2, 0, &source[..source.len() - 1], &clip, exact_state(0)),
        Err(GxExactGeometryError::InvalidVertexLayout)
    );
    assert_eq!(
        gx_exact_raster_geometry(2, 0, &source, &clip[..2], exact_state(0)),
        Err(GxExactGeometryError::PositionCountMismatch)
    );
    let mut nonfinite = source.clone();
    nonfinite[12] = f32::NAN;
    assert_eq!(
        gx_exact_raster_geometry(2, 0, &nonfinite, &clip, exact_state(0)),
        Err(GxExactGeometryError::NonFiniteSourceVertex)
    );
    assert_eq!(
        gx_exact_raster_geometry(5, 0, &source, &clip, exact_state(0)),
        Err(GxExactGeometryError::Clip(
            GxClipError::UnsupportedTopology(5)
        ))
    );
    assert_eq!(
        gx_exact_raster_geometry(2, 4, &source, &clip, exact_state(0)),
        Err(GxExactGeometryError::Clip(GxClipError::InvalidCullMode(4)))
    );
}
