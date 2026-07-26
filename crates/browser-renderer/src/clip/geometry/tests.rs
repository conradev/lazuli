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
    let flat_rasters = [
        0.0,
        -0.0,
        64.0 / 255.0,
        1.0,
        2.0 / 255.0,
        4.0 / 255.0,
        8.0 / 255.0,
        1.0,
    ];
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

fn assert_geometry_bits_eq(
    actual: &GxExactRasterGeometry,
    expected: &GxExactRasterGeometry,
    context: &str,
) {
    assert_eq!(
        actual
            .vertices()
            .iter()
            .copied()
            .map(f32::to_bits)
            .collect::<Vec<_>>(),
        expected
            .vertices()
            .iter()
            .copied()
            .map(f32::to_bits)
            .collect::<Vec<_>>(),
        "{context}: vertex bits changed",
    );
    assert_eq!(
        actual.source_indices(),
        expected.source_indices(),
        "{context}: source provenance changed",
    );
    assert_eq!(
        actual.raster_scissor(),
        expected.raster_scissor(),
        "{context}: raster scissor changed",
    );
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
    for vertex in &vertices {
        assert_eq!(
            vertex[4..12]
                .iter()
                .copied()
                .map(gx_normalized_raster_channel_u8)
                .collect::<Vec<_>>(),
            source[4..12]
                .iter()
                .copied()
                .map(gx_normalized_raster_channel_u8)
                .collect::<Vec<_>>(),
            "canonical flat raster bytes survive the integer color clip path"
        );
    }
    assert_eq!(
        source[5].to_bits(),
        (-0.0_f32).to_bits(),
        "the source fixture pins accepted signed zero"
    );
    assert_eq!(
        vertices[0][5].to_bits(),
        0.0_f32.to_bits(),
        "the byte-domain clip transport canonicalizes either signed zero to byte zero"
    );
}

#[test]
fn source_rasters_may_vary_but_must_be_canonical_bytes() {
    let mut source = source_vertices(3);
    assert_ne!(source[2].to_bits(), source[TEV_VERTEX_FLOATS + 2].to_bits());
    for (vertex, red) in [1_u8, 127, 254].into_iter().enumerate() {
        source[vertex * TEV_VERTEX_FLOATS + 4] = f32::from(red) / 255.0;
    }
    let clip = [
        [-0.5, -0.5, -0.5, 1.0],
        [0.5, -0.5, -0.5, 1.0],
        [-0.5, 0.5, -0.5, 1.0],
    ];
    let geometry = gx_exact_raster_geometry(2, 0, &source, &clip, exact_state(0)).unwrap();
    assert_eq!(
        vertex_slices(geometry.vertices())
            .iter()
            .map(|vertex| gx_normalized_raster_channel_u8(vertex[4]))
            .collect::<Vec<_>>(),
        [1, 127, 254],
        "post-cull vertices retain their own raster endpoints"
    );

    source[TEV_VERTEX_FLOATS + 4] = 0.5;
    assert_eq!(
        gx_exact_raster_geometry(2, 0, &source, &clip, exact_state(0)),
        Err(GxExactGeometryError::NonCanonicalSourceRaster),
    );
}

#[test]
fn clipped_raster_endpoints_use_dolphins_u8_8_integer_lerp() {
    let mut source = source_vertices(3);
    for (vertex, (raster0, raster1)) in [
        ([10, 20, 30, 40], [210, 200, 190, 180]),
        ([250, 240, 230, 220], [10, 20, 30, 40]),
        ([90, 100, 110, 120], [130, 140, 150, 160]),
    ]
    .into_iter()
    .enumerate()
    {
        let offset = vertex * TEV_VERTEX_FLOATS + 4;
        for (destination, byte) in source[offset..offset + 8]
            .iter_mut()
            .zip(raster0.into_iter().chain(raster1))
        {
            *destination = byte as f32 / 255.0;
        }
    }
    let clip = [
        [0.0, 0.0, -0.5, 1.0],
        [2.01, 0.0, -0.5, 1.0],
        [0.0, 1.0, -0.5, 1.0],
    ];
    let geometry = gx_exact_raster_geometry(2, 0, &source, &clip, exact_state(0)).unwrap();
    let vertices = vertex_slices(geometry.vertices());
    assert_eq!(vertices.len(), 6);
    let raster_bytes = vertices
        .iter()
        .map(|vertex| {
            std::array::from_fn::<_, 8, _>(|channel| {
                gx_normalized_raster_channel_u8(vertex[4 + channel])
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(
        raster_bytes,
        [
            [10, 20, 30, 40, 210, 200, 190, 180],
            [130, 130, 130, 130, 110, 110, 110, 110],
            [170, 170, 170, 170, 70, 80, 90, 100],
            [10, 20, 30, 40, 210, 200, 190, 180],
            [170, 170, 170, 170, 70, 80, 90, 100],
            [90, 100, 110, 120, 130, 140, 150, 160],
        ],
        "negative deltas use signed arithmetic shift after truncating t*256",
    );
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
    let mut unproved_clip_disable = clip;
    unproved_clip_disable[0][0] = 2.0;
    assert_eq!(
        gx_exact_raster_geometry(2, 0, &source, &unproved_clip_disable, clip_disable,),
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
fn proven_clip_disable_noops_preserve_exact_geometry_bit_for_bit() {
    let source = source_vertices(3);
    let inside = [
        [-0.5, -0.5, -0.5, 1.0],
        [0.5, -0.5, -0.5, 1.0],
        [-0.5, 0.5, -0.5, 1.0],
    ];
    let inside_reference =
        gx_exact_raster_geometry(2, 0, &source, &inside, exact_state(0)).unwrap();
    for value in 1..=7 {
        let mut state = exact_state(0);
        state.xf_clip_disable = value;
        let actual = gx_exact_raster_geometry(2, 0, &source, &inside, state).unwrap();
        assert_geometry_bits_eq(
            &actual,
            &inside_reference,
            &format!("in-frustum mode {value} must be observationally inert"),
        );
    }

    let crossing = [
        [0.0, 0.0, -0.5, 1.0],
        [2.0, 0.0, -0.5, 1.0],
        [0.0, 1.0, -0.5, 1.0],
    ];
    let crossing_reference =
        gx_exact_raster_geometry(2, 0, &source, &crossing, exact_state(0)).unwrap();
    assert_eq!(crossing_reference.triangle_count(), 2);
    let outside = [
        [2.0, -0.5, -0.5, 1.0],
        [2.0, 0.5, -0.5, 1.0],
        [3.0, -0.5, -0.5, 1.0],
    ];
    let outside_reference =
        gx_exact_raster_geometry(2, 0, &source, &outside, exact_state(0)).unwrap();
    assert_eq!(outside_reference.triangle_count(), 0);
    for value in [2, 4, 6] {
        let mut state = exact_state(0);
        state.xf_clip_disable = value;
        let crossing_actual = gx_exact_raster_geometry(2, 0, &source, &crossing, state).unwrap();
        assert_geometry_bits_eq(
            &crossing_actual,
            &crossing_reference,
            &format!("clip-enabled mode {value} must retain the exact clip fan"),
        );
        let outside_actual = gx_exact_raster_geometry(2, 0, &source, &outside, state).unwrap();
        assert_geometry_bits_eq(
            &outside_actual,
            &outside_reference,
            &format!("clip-enabled mode {value} must retain the final empty result"),
        );
    }
}

#[test]
fn clipping_detection_disable_requires_strict_positive_w_inside_endpoints() {
    let source = source_vertices(3);
    let base = [
        [-0.5, -0.5, -0.5, 1.0],
        [0.5, -0.5, -0.5, 1.0],
        [-0.5, 0.5, -0.5, 1.0],
    ];
    let outside_endpoints = [
        [2.0, 0.0, -0.5, 1.0],
        [-2.0, 0.0, -0.5, 1.0],
        [0.0, 2.0, -0.5, 1.0],
        [0.0, -2.0, -0.5, 1.0],
        [0.0, 0.0, 0.5, 1.0],
        [0.0, 0.0, -2.0, 1.0],
    ];
    for value in [1, 3, 5, 7] {
        let expected = Err(GxExactGeometryError::Projection(
            GxExactProjectionError::UnsupportedClipDisable(value),
        ));
        for endpoint in outside_endpoints {
            let mut clip = base;
            clip[0] = endpoint;
            let mut state = exact_state(0);
            state.xf_clip_disable = value;
            assert_eq!(
                gx_exact_raster_geometry(2, 0, &source, &clip, state),
                expected,
                "mode {value} cannot bypass an unproved GX clip plane",
            );
        }
        for w in [0.0, -0.0, -1.0] {
            let mut clip = base;
            clip[0][3] = w;
            let mut state = exact_state(0);
            state.xf_clip_disable = value;
            assert_eq!(
                gx_exact_raster_geometry(2, 0, &source, &clip, state),
                expected,
                "mode {value} cannot bypass an unproved W endpoint",
            );
        }
    }
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
    let varying = gx_exact_raster_geometry(2, 0, &source, &varying_depth, exact_state(0)).unwrap();
    assert_eq!(
        vertex_slices(varying.vertices())
            .iter()
            .map(|vertex| vertex[2].to_bits())
            .collect::<Vec<_>>(),
        [
            8_388_607.5f32.to_bits(),
            12_582_911.0f32.to_bits(),
            8_388_607.5f32.to_bits(),
        ],
        "exact projected depth remains screen-linear instead of being forced flat"
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

#[test]
fn exact_preparation_failure_telemetry_is_exhaustive_and_bounded() {
    use ExactRequiredPreparationRejectionReason as Reason;

    let geometry = GxExactPreparationFailure::Geometry;
    let cases = [
        (
            geometry(GxExactGeometryError::InvalidVertexLayout),
            Reason::InvalidVertexLayout,
        ),
        (
            geometry(GxExactGeometryError::MissingExactClipInput),
            Reason::MissingExactClipInput,
        ),
        (
            geometry(GxExactGeometryError::PositionCountMismatch),
            Reason::PositionCountMismatch,
        ),
        (
            geometry(GxExactGeometryError::NonFiniteSourceVertex),
            Reason::NonFiniteSourceVertex,
        ),
        (
            geometry(GxExactGeometryError::CullModeStateMismatch),
            Reason::CullModeStateMismatch,
        ),
        (
            geometry(GxExactGeometryError::UnsupportedMultisampling),
            Reason::UnsupportedMultisampling,
        ),
        (
            geometry(GxExactGeometryError::UnsupportedZFreeze),
            Reason::UnsupportedZFreeze,
        ),
        (
            geometry(GxExactGeometryError::NonCanonicalSourceRaster),
            Reason::NonCanonicalSourceRaster,
        ),
        (
            geometry(GxExactGeometryError::UnsupportedPostClipW),
            Reason::UnsupportedPostClipW,
        ),
        (
            geometry(GxExactGeometryError::UnsupportedPostClipPosition),
            Reason::UnsupportedPostClipPosition,
        ),
        (
            geometry(GxExactGeometryError::UnsupportedPostClipDepth),
            Reason::UnsupportedPostClipDepth,
        ),
        (
            geometry(GxExactGeometryError::Clip(
                GxClipError::InvalidComponentCount,
            )),
            Reason::ClipInvalidComponentCount,
        ),
        (
            geometry(GxExactGeometryError::Clip(
                GxClipError::UnsupportedTopology(5),
            )),
            Reason::UnsupportedTopology5,
        ),
        (
            geometry(GxExactGeometryError::Clip(
                GxClipError::UnsupportedTopology(6),
            )),
            Reason::UnsupportedTopology6,
        ),
        (
            geometry(GxExactGeometryError::Clip(
                GxClipError::UnsupportedTopology(7),
            )),
            Reason::UnsupportedTopology7,
        ),
        (
            geometry(GxExactGeometryError::Clip(
                GxClipError::UnsupportedTopology(8),
            )),
            Reason::UnsupportedTopologyOther,
        ),
        (
            geometry(GxExactGeometryError::Clip(GxClipError::NoSourceTriangles)),
            Reason::ClipNoSourceTriangles,
        ),
        (
            geometry(GxExactGeometryError::Clip(GxClipError::InvalidCullMode(4))),
            Reason::ClipInvalidCullMode,
        ),
        (
            geometry(GxExactGeometryError::Clip(
                GxClipError::InvalidViewportHeight,
            )),
            Reason::ClipInvalidViewportHeight,
        ),
        (
            geometry(GxExactGeometryError::Clip(GxClipError::NonFiniteVertex)),
            Reason::ClipNonFiniteVertex,
        ),
        (
            geometry(GxExactGeometryError::Clip(GxClipError::ArithmeticOverflow)),
            Reason::ClipArithmeticOverflow,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::InvalidComponentCount,
            )),
            Reason::ProjectionInvalidComponentCount,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::InvalidBpState,
            )),
            Reason::ProjectionInvalidBpState,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::InvalidClipDisable(8),
            )),
            Reason::ProjectionInvalidClipDisable,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(1),
            )),
            Reason::UnsupportedClipDisable1,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(2),
            )),
            Reason::UnsupportedClipDisable2,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(3),
            )),
            Reason::UnsupportedClipDisable3,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(4),
            )),
            Reason::UnsupportedClipDisable4,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(5),
            )),
            Reason::UnsupportedClipDisable5,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(6),
            )),
            Reason::UnsupportedClipDisable6,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(7),
            )),
            Reason::UnsupportedClipDisable7,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(8),
            )),
            Reason::UnsupportedClipDisableOther,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::InvalidViewport,
            )),
            Reason::ProjectionInvalidViewport,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::InvalidScissor,
            )),
            Reason::ProjectionInvalidScissor,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::NoVisibleScissor,
            )),
            Reason::ProjectionNoVisibleScissor,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::WrappedScissor,
            )),
            Reason::ProjectionWrappedScissor,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::NonFiniteVertex,
            )),
            Reason::ProjectionNonFiniteVertex,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::ZeroClipW,
            )),
            Reason::ProjectionZeroClipW,
        ),
        (
            geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::ArithmeticOverflow,
            )),
            Reason::ProjectionArithmeticOverflow,
        ),
        (
            GxExactPreparationFailure::InvalidPreparedScissor,
            Reason::InvalidPreparedScissor,
        ),
    ];

    assert_eq!(cases.len(), Reason::ALL.len());
    let mut seen = vec![false; Reason::ALL.len()];
    for (failure, expected) in cases {
        assert_eq!(failure.telemetry_reason(), expected);
        assert!(!seen[expected.index()], "duplicate telemetry bucket");
        seen[expected.index()] = true;
    }
    assert!(seen.into_iter().all(|was_seen| was_seen));

    let exact_error = GxExactGeometryError::Clip(GxClipError::UnsupportedTopology(5));
    assert_eq!(
        GxExactPreparationFailure::from(exact_error),
        GxExactPreparationFailure::Geometry(exact_error),
        "preparation retains the exact geometry-error subtype",
    );
}
