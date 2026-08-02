use super::*;

fn f32_bits<const COMPONENTS: usize>(vertices: &[[f32; COMPONENTS]]) -> Vec<[u32; COMPONENTS]> {
    vertices
        .iter()
        .map(|vertex| vertex.map(f32::to_bits))
        .collect()
}

#[test]
fn source_topologies_match_the_gx_triangle_walk() {
    assert_eq!(gx_source_triangle_indices(0, 3), [[0, 1, 2]]);
    assert_eq!(gx_source_triangle_indices(0, 4), [[0, 1, 2], [0, 2, 3]]);
    assert_eq!(
        gx_source_triangle_indices(1, 7),
        [[0, 1, 2], [0, 2, 3], [4, 5, 6]]
    );
    assert_eq!(gx_source_triangle_indices(2, 7), [[0, 1, 2], [3, 4, 5]]);
    assert_eq!(
        gx_source_triangle_indices(3, 5),
        [[0, 1, 2], [1, 3, 2], [2, 3, 4]]
    );
    assert_eq!(
        gx_source_triangle_indices(4, 5),
        [[0, 1, 2], [0, 2, 3], [0, 3, 4]]
    );
}

#[test]
fn clip_masks_pin_all_six_dolphin_plane_decisions() {
    let outside = 1.0 + f32::EPSILON;
    for vertex in [
        [1.0, 0.0, 0.0, 1.0],
        [-1.0, 0.0, 0.0, 1.0],
        [0.0, 1.0, 0.0, 1.0],
        [0.0, -1.0, 0.0, 1.0],
        [0.0, 0.0, 0.0, 1.0],
        [0.0, 0.0, -1.0, 1.0],
    ] {
        assert_eq!(gx_clip_mask(&vertex), Ok(0));
    }
    assert_eq!(gx_clip_mask(&[outside, 0.0, 0.0, 1.0]), Ok(0x01));
    assert_eq!(gx_clip_mask(&[-outside, 0.0, 0.0, 1.0]), Ok(0x02));
    assert_eq!(gx_clip_mask(&[0.0, outside, 0.0, 1.0]), Ok(0x04));
    assert_eq!(gx_clip_mask(&[0.0, -outside, 0.0, 1.0]), Ok(0x08));
    assert_eq!(gx_clip_mask(&[0.0, 0.0, f32::from_bits(1), 1.0]), Ok(0x10));
    assert_eq!(gx_clip_mask(&[0.0, 0.0, -outside, 1.0]), Ok(0x20));
    assert_eq!(gx_clip_mask(&[0.0, 0.0, 0.0, -1.0]), Ok(0x2f));
    assert_eq!(gx_clip_mask(&[0.0, 0.0, 0.0, 0.0]), Ok(0));
    assert_eq!(
        gx_clip_mask(&[0.0, 0.0, 2.0_f32.powi(-80), 2.0_f32.powi(-80)]),
        Ok(0),
        "the exact W*Z mask keeps f32 underflow"
    );
}

#[test]
fn ordered_polygon_walk_matches_the_js_oracle_for_every_plane() {
    let inside_a = [0.0, 0.0, -0.5, 1.0];
    let inside_b = [0.0, 0.5, -0.5, 1.0];
    let cases = [
        (
            0x01,
            [2.0, 0.0, -0.5, 1.0],
            [-1.0, 0.0, 0.0, 1.0],
            [
                [0, 0, 0xbf00_0000, 0x3f80_0000],
                [0x3f80_0000, 0, 0xbf00_0000, 0x3f80_0000],
                [0x3f80_0000, 0x3e80_0000, 0xbf00_0000, 0x3f80_0000],
                [0, 0x3f00_0000, 0xbf00_0000, 0x3f80_0000],
            ],
        ),
        (
            0x02,
            [-2.0, 0.0, -0.5, 1.0],
            [1.0, 0.0, 0.0, 1.0],
            [
                [0, 0, 0xbf00_0000, 0x3f80_0000],
                [0xbf80_0000, 0, 0xbf00_0000, 0x3f80_0000],
                [0xbf80_0000, 0x3e80_0000, 0xbf00_0000, 0x3f80_0000],
                [0, 0x3f00_0000, 0xbf00_0000, 0x3f80_0000],
            ],
        ),
        (
            0x04,
            [0.0, 2.0, -0.5, 1.0],
            [0.0, -1.0, 0.0, 1.0],
            [
                [0, 0, 0xbf00_0000, 0x3f80_0000],
                [0, 0x3f80_0000, 0xbf00_0000, 0x3f80_0000],
                [0, 0x3f80_0000, 0xbf00_0000, 0x3f80_0000],
                [0, 0x3f00_0000, 0xbf00_0000, 0x3f80_0000],
            ],
        ),
        (
            0x08,
            [0.0, -2.0, -0.5, 1.0],
            [0.0, 1.0, 0.0, 1.0],
            [
                [0, 0, 0xbf00_0000, 0x3f80_0000],
                [0, 0xbf80_0000, 0xbf00_0000, 0x3f80_0000],
                [0, 0xbf80_0000, 0xbf00_0000, 0x3f80_0000],
                [0, 0x3f00_0000, 0xbf00_0000, 0x3f80_0000],
            ],
        ),
        (
            0x10,
            [0.0, 0.0, -0.5, -1.0],
            [0.0, 0.0, 0.0, 1.0],
            [
                [0, 0, 0xbf00_0000, 0x3f80_0000],
                [0, 0, 0xbf00_0000, 0],
                [0, 0x3e80_0000, 0xbf00_0000, 0],
                [0, 0x3f00_0000, 0xbf00_0000, 0x3f80_0000],
            ],
        ),
        (
            0x20,
            [0.0, 0.0, -2.0, 1.0],
            [0.0, 0.0, 1.0, 1.0],
            [
                [0, 0, 0xbf00_0000, 0x3f80_0000],
                [0, 0, 0xbf80_0000, 0x3f80_0000],
                [0, 0x3eaa_aaab, 0xbf80_0000, 0x3f80_0000],
                [0, 0x3f00_0000, 0xbf00_0000, 0x3f80_0000],
            ],
        ),
    ];

    for (mask, outside, plane, expected_bits) in cases {
        let polygon = gx_clip_polygon([inside_a, outside, inside_b], mask).unwrap();
        assert_eq!(f32_bits(&polygon), expected_bits, "plane mask {mask:#04x}");
        let distances = polygon
            .iter()
            .map(|vertex| gx_clip_plane_distance(vertex, plane).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            distances
                .iter()
                .filter(|distance| distance.to_bits() == 0)
                .count(),
            2,
            "plane mask {mask:#04x} emits both exact boundary intersections"
        );
        assert!(
            distances.iter().all(|distance| *distance >= 0.0),
            "plane mask {mask:#04x} retains only inside vertices"
        );
    }
}

#[test]
fn ordered_clipping_interpolates_payloads_and_fans_the_polygon() {
    let triangle = [
        [0.0, 0.0, -0.5, 1.0, 0.0],
        [2.0, 0.0, -0.5, 1.0, 2.0],
        [0.0, 1.0, -0.5, 1.0, 4.0],
    ];
    let polygon = gx_clip_polygon(triangle, 0x01).unwrap();
    assert_eq!(
        polygon,
        [
            [0.0, 0.0, -0.5, 1.0, 0.0],
            [1.0, 0.0, -0.5, 1.0, 1.0],
            [1.0, 0.5, -0.5, 1.0, 3.0],
            [0.0, 1.0, -0.5, 1.0, 4.0],
        ]
    );
    assert_eq!(
        gx_triangulate_polygon(&polygon),
        [
            [polygon[0], polygon[1], polygon[2]],
            [polygon[0], polygon[2], polygon[3]],
        ]
    );

    let interpolated = gx_clip_intersection(
        0.173_583_85,
        [0.0, 0.0, 0.0, 1.0, 18_364_432.0],
        [0.0, 0.0, 0.0, 1.0, -8_323_480.5],
    )
    .unwrap();
    assert_eq!(
        interpolated[4].to_bits(),
        0x4b51_8802,
        "OUT + f32((IN - OUT) * T) keeps every intermediate rounding"
    );
}

#[test]
fn raster_clip_lerp_quantizes_t_and_uses_signed_arithmetic_shift() {
    let out = GxRasterClipVertex::new([2.0, 0.0, -0.5, 1.0], [10, 250, 0, 255, 1, 2, 3, 4]);
    let inside = GxRasterClipVertex::new([0.0, 0.0, -0.5, 1.0], [250, 10, 255, 0, 5, 6, 7, 8]);
    let half = gx_raster_clip_intersection(0.5, out, inside).unwrap();
    assert_eq!(
        half.raster_channels(),
        [130, 130, 127, 127, 3, 4, 5, 6],
        "negative deltas must retain the signed right shift"
    );

    let just_below_one = f32::from_bits(1.0f32.to_bits() - 1);
    assert_eq!(
        gx_raster_clip_intersection(just_below_one, out, inside)
            .unwrap()
            .raster_channels()[0],
        249,
        "t*256 truncates to 255 below one"
    );
    assert_eq!(
        gx_raster_clip_intersection(1.0, out, inside)
            .unwrap()
            .raster_channels(),
        inside.raster_channels(),
        "the exact t=1 boundary uses U8.8 value 256"
    );
}

#[test]
fn raster_polygon_walk_preserves_the_generic_clip_order_and_masks() {
    let components = [
        [0.0, 0.0, -0.5, 1.0, 0.0],
        [2.0, 2.0, -0.5, 1.0, 2.0],
        [0.0, 0.5, -0.5, 1.0, 4.0],
    ];
    let raster = [
        GxRasterClipVertex::new(components[0], [0; 8]),
        GxRasterClipVertex::new(components[1], [255; 8]),
        GxRasterClipVertex::new(components[2], [64; 8]),
    ];
    let generic = gx_clip_polygon(components, 0x01 | 0x04).unwrap();
    let specialized = gx_raster_clip_polygon(raster, 0x01 | 0x04).unwrap();
    assert_eq!(
        specialized
            .iter()
            .map(|vertex| vertex.components())
            .collect::<Vec<_>>(),
        generic,
        "specialized raster transport must not change the ordered f32 geometry walk"
    );
    assert_eq!(
        specialized
            .iter()
            .map(|vertex| vertex.raster_channels()[0])
            .collect::<Vec<_>>(),
        [0, 127, 127, 127, 64],
        "the second plane must consume the first plane's quantized u8 endpoint",
    );
    assert_eq!(
        specialized[3].raster_channels()[0],
        127,
        "sequential U8.8 clipping differs from a one-step original-endpoint reconstruction (128)",
    );
    assert_eq!(gx_triangulate_raster_polygon(&specialized).len(), 3);
}

#[test]
fn plane_order_retains_duplicate_boundary_transitions() {
    let polygon = gx_clip_polygon(
        [
            [0.0, 0.0, -0.5, 1.0],
            [2.0, 2.0, -0.5, 1.0],
            [0.0, 0.5, -0.5, 1.0],
        ],
        0x01 | 0x04,
    )
    .unwrap();
    assert_eq!(
        f32_bits(&polygon),
        [
            [0, 0, 0xbf00_0000, 0x3f80_0000],
            [0x3f80_0000, 0x3f80_0000, 0xbf00_0000, 0x3f80_0000],
            [0x3f80_0000, 0x3f80_0000, 0xbf00_0000, 0x3f80_0000],
            [0x3f2a_aaaa, 0x3f80_0000, 0xbf00_0000, 0x3f80_0000],
            [0, 0x3f00_0000, 0xbf00_0000, 0x3f80_0000],
        ]
    );
    assert_eq!(gx_triangulate_polygon(&polygon).len(), 3);
}

#[test]
fn face_cull_modes_are_not_exact_cpu_authority() {
    let front = [
        [0.0, 0.0, -0.5, 1.0, 0.0],
        [2.0, 0.0, -0.5, 1.0, 2.0],
        [0.0, 1.0, -0.5, 1.0, 4.0],
    ];
    let back = [front[0], front[2], front[1]];
    let front_triangles = gx_post_clip_triangle(front, 0, -264.0).unwrap();
    assert_eq!(front_triangles.len(), 2);
    assert_eq!(
        gx_post_clip_triangle(back, 0, -264.0).unwrap(),
        front_triangles
    );
    assert_eq!(
        gx_post_clip_triangle(front, 1, -264.0),
        Err(GxClipError::UncertifiedFaceCull(1)),
    );
    assert_eq!(
        gx_post_clip_triangle(back, 2, -264.0),
        Err(GxClipError::UncertifiedFaceCull(2)),
    );
    assert!(
        gx_post_clip_triangle(front, 3, -264.0).unwrap().is_empty(),
        "raw cull-all remains an authoritative empty result",
    );
    let trivially_rejected = [
        [2.0, 0.0, -0.5, 1.0, 0.0],
        [2.0, 1.0, -0.5, 1.0, 2.0],
        [2.0, -1.0, -0.5, 1.0, 4.0],
    ];
    for cull_mode in [0, 1, 2, 3] {
        assert!(
            gx_post_clip_triangle(trivially_rejected, cull_mode, -264.0)
                .unwrap()
                .is_empty(),
            "Dolphin trivially rejects before cull mode {cull_mode} classification",
        );
    }
}

#[test]
fn clip_bypass_retains_trivial_rejection_and_no_cull_backface_order() {
    let raster = |components| GxRasterClipVertex::new(components, [0; 8]);
    let crossing_near = [
        raster([-0.5, -0.5, -1.5, 1.0]),
        raster([0.5, -0.5, -1.0, 1.0]),
        raster([-0.5, 0.5, -1.0, 1.0]),
    ];
    assert_eq!(
        gx_post_clip_raster_triangle(crossing_near, 0, -264.0)
            .unwrap()
            .len(),
        0,
    );
    assert_eq!(
        gx_bypass_clip_raster_triangle(crossing_near, 0, -264.0, false).unwrap(),
        [crossing_near],
    );

    let uniform_near = crossing_near.map(|mut vertex| {
        vertex.components[2] = -1.5;
        vertex
    });
    assert!(
        gx_bypass_clip_raster_triangle(uniform_near, 0, -264.0, false)
            .unwrap()
            .is_empty(),
        "bit zero alone must retain pre-clip trivial rejection",
    );
    assert_eq!(
        gx_bypass_clip_raster_triangle(uniform_near, 0, -264.0, true).unwrap(),
        [uniform_near],
        "bit one bypasses the otherwise identical trivial rejection",
    );

    let backface = [crossing_near[0], crossing_near[2], crossing_near[1]];
    assert_eq!(
        gx_bypass_clip_raster_triangle(backface, 0, -264.0, false).unwrap(),
        [crossing_near],
        "backfaces are normalized to the same post-cull edge order",
    );
    assert_eq!(
        gx_bypass_clip_raster_triangle(crossing_near, 1, -264.0, false),
        Err(GxClipError::UncertifiedFaceCull(1)),
        "face classification delegates to the direct GPU path",
    );
    assert!(
        gx_bypass_clip_raster_triangle(uniform_near, 1, -264.0, false)
            .unwrap()
            .is_empty(),
        "enabled trivial rejection precedes the conservative face-cull gate",
    );
    assert_eq!(
        gx_bypass_clip_raster_triangle(uniform_near, 1, -264.0, true),
        Err(GxClipError::UncertifiedFaceCull(1)),
        "disabling trivial rejection still delegates face classification",
    );
}

#[test]
fn viewport_sign_only_normalizes_the_certified_no_cull_subset() {
    let front = [
        [0.0, 0.0, -0.5, 1.0],
        [1.0, 0.0, -0.5, 1.0],
        [0.0, 1.0, -0.5, 1.0],
    ];
    let back = [front[0], front[2], front[1]];
    for viewport_height in [-1.0, 1.0] {
        let normalized_front = gx_post_clip_triangle(front, 0, viewport_height).unwrap();
        let normalized_back = gx_post_clip_triangle(back, 0, viewport_height).unwrap();
        assert_eq!(normalized_front, normalized_back);
        for cull_mode in [1, 2] {
            assert_eq!(
                gx_post_clip_triangle(front, cull_mode, viewport_height),
                Err(GxClipError::UncertifiedFaceCull(cull_mode)),
            );
            assert_eq!(
                gx_post_clip_triangle(back, cull_mode, viewport_height),
                Err(GxClipError::UncertifiedFaceCull(cull_mode)),
            );
        }
        assert!(
            gx_post_clip_triangle(front, 3, viewport_height)
                .unwrap()
                .is_empty(),
        );
    }

    let collinear = [
        [0.0, 0.0, -0.5, 1.0],
        [0.5, 0.0, -0.5, 1.0],
        [1.0, 0.0, -0.5, 1.0],
    ];
    assert_eq!(gx_clip_normal_z(&collinear).unwrap().to_bits(), 0);
    assert_eq!(
        gx_post_clip_triangle(collinear, 0, -1.0).unwrap().len(),
        1,
        "no-cull normalization retains the literal signed-zero face result"
    );
    assert_eq!(
        gx_post_clip_triangle(collinear, 2, -1.0),
        Err(GxClipError::UncertifiedFaceCull(2)),
    );
}

#[test]
fn positive_z_uses_dolphins_mask_then_w_plane_quirk() {
    let mixed_positive_z = [
        [0.0, 0.0, -0.5, 1.0],
        [1.0, 0.0, 0.25, 1.0],
        [0.0, 1.0, -0.5, 1.0],
    ];
    assert_eq!(
        gx_post_clip_triangle(mixed_positive_z, 0, -264.0).unwrap(),
        [mixed_positive_z],
        "the +Z mask triggers a W >= 0 polygon walk that leaves this triangle intact"
    );

    let all_positive_z = mixed_positive_z.map(|mut vertex| {
        vertex[2] = 0.25;
        vertex
    });
    assert!(
        gx_post_clip_triangle(all_positive_z, 0, -264.0)
            .unwrap()
            .is_empty(),
        "three +Z mask bits still trigger trivial rejection first"
    );
}

#[test]
fn draw_derivation_rejects_noncanonical_inputs_without_partial_output() {
    let triangle = [
        [0.0, 0.0, -0.5, 1.0],
        [1.0, 0.0, -0.5, 1.0],
        [0.0, 1.0, -0.5, 1.0],
    ];
    assert_eq!(
        gx_exact_clip_triangles(5, &triangle, 0, -264.0),
        Err(GxClipError::UnsupportedTopology(5))
    );
    assert_eq!(
        gx_exact_clip_triangles(2, &triangle[..2], 0, -264.0),
        Err(GxClipError::NoSourceTriangles)
    );
    assert_eq!(
        gx_exact_clip_triangles(2, &triangle, 4, -264.0),
        Err(GxClipError::InvalidCullMode(4))
    );
    assert_eq!(
        gx_exact_clip_triangles(2, &triangle, 0, 0.0),
        Err(GxClipError::InvalidViewportHeight)
    );
    let mut nonfinite = triangle;
    nonfinite[2][0] = f32::NAN;
    assert_eq!(
        gx_exact_clip_triangles(2, &nonfinite, 0, -264.0),
        Err(GxClipError::NonFiniteVertex)
    );
    assert_eq!(
        gx_exact_clip_triangles(2, &[[0.0; 3]; 3], 0, -264.0),
        Err(GxClipError::InvalidComponentCount)
    );
}
