use super::*;

fn raw_winding(points: [GxRasterPoint28_4; 3]) -> GxRasterWinding {
    let [a, b, c] = points;
    let ab_x = i128::from(b.x.raw()) - i128::from(a.x.raw());
    let ab_y = i128::from(b.y.raw()) - i128::from(a.y.raw());
    let ac_x = i128::from(c.x.raw()) - i128::from(a.x.raw());
    let ac_y = i128::from(c.y.raw()) - i128::from(a.y.raw());
    match ab_x * ac_y - ab_y * ac_x {
        area if area < 0 => GxRasterWinding::Negative,
        0 => GxRasterWinding::Collinear,
        _ => GxRasterWinding::Positive,
    }
}

fn triangle(setup: GxRasterSetup) -> GxRasterTriangle28_4 {
    match setup {
        GxRasterSetup::Triangle(triangle) => triangle,
        GxRasterSetup::Degenerate { source_winding } => {
            panic!("expected triangle, got {source_winding:?} snapped degenerate")
        }
    }
}

fn raw_triangle(points: [GxRasterPoint28_4; 3], scissor: GxRasterScissor) -> GxRasterTriangle28_4 {
    triangle(GxRasterTriangle28_4::setup_post_cull(
        points,
        raw_winding(points),
        scissor,
    ))
}

fn mask_4x4(triangle: GxRasterTriangle28_4) -> u16 {
    let mut result = 0;
    for block_y in [0_u32, 2] {
        for block_x in [0_u32, 2] {
            let block = triangle.coverage_mask_2x2(block_x, block_y).unwrap().bits();
            for local_y in 0..2 {
                for local_x in 0..2 {
                    let local_bit = local_y * 2 + local_x;
                    if block & (1 << local_bit) != 0 {
                        let x = block_x + local_x;
                        let y = block_y + local_y;
                        result |= 1 << (y * 4 + x);
                    }
                }
            }
        }
    }
    result
}

fn quad_mask_4x4(left: f32) -> u16 {
    let scissor = GxRasterScissor::full_efb();
    let lower_left = triangle(
        GxRasterTriangle28_4::from_post_cull_efb(
            [[left, -1.0], [left, 5.0], [5.0, 5.0]],
            GxRasterWinding::Negative,
            scissor,
        )
        .unwrap(),
    );
    let upper_right = triangle(
        GxRasterTriangle28_4::from_post_cull_efb(
            [[left, -1.0], [5.0, 5.0], [5.0, -1.0]],
            GxRasterWinding::Negative,
            scissor,
        )
        .unwrap(),
    );
    mask_4x4(lower_left) | mask_4x4(upper_right)
}

#[test]
fn exact_seven_twelfths_sample_mapping_covers_every_efb_pixel() {
    for y in 0..EFB_HEIGHT as u16 {
        for x in 0..EFB_WIDTH as u16 {
            let sample = gx_non_aa_raster_sample_12(x, y);
            assert_eq!(sample.x_numerator, i32::from(x) * 12 + 7);
            assert_eq!(sample.y_numerator, i32::from(y) * 12 + 7);

            // Snapping the rational sample itself lands at 9/16 of a 28.4
            // pixel. That approximation must stay distinct from the exact
            // 7/12 numerator used by coverage and interpolation.
            let snapped_x =
                gx_non_aa_raster_coord_28_4(sample.x_numerator as f32 / 12.0, 0).unwrap();
            let snapped_y =
                gx_non_aa_raster_coord_28_4(sample.y_numerator as f32 / 12.0, 0).unwrap();
            assert_eq!(snapped_x.raw(), i32::from(x) * 16 + 9);
            assert_eq!(snapped_y.raw(), i32::from(y) * 16 + 9);
            assert_ne!(snapped_x.raw() * 12, sample.x_numerator * 16);
            assert_ne!(snapped_y.raw() * 12, sample.y_numerator * 16);
        }
    }
}

#[test]
fn vertex_snap_buckets_are_exact_at_the_discriminating_threshold() {
    for (coordinate, expected) in [
        (0.575, 9),
        (0.590, 9),
        (0.593_749, 9),
        (0.593_75, 10),
        (0.600, 10),
        (-0.575, -9),
        (-0.600, -9),
    ] {
        assert_eq!(
            gx_non_aa_raster_coord_28_4(coordinate, 0).unwrap().raw(),
            expected,
            "{coordinate}"
        );
    }
}

#[test]
fn same_snap_bucket_can_collapse_a_pre_snap_triangle() {
    let setup = GxRasterTriangle28_4::from_post_cull_efb(
        [[0.575, 0.0], [0.590, 1.0], [0.575, 2.0]],
        GxRasterWinding::Positive,
        GxRasterScissor::full_efb(),
    )
    .unwrap();
    assert_eq!(
        setup,
        GxRasterSetup::Degenerate {
            source_winding: GxRasterWinding::Positive
        }
    );
    assert_eq!(setup.source_winding(), GxRasterWinding::Positive);
}

#[test]
fn snap_bucket_quad_oracle_distinguishes_the_adjacent_bucket() {
    assert_eq!(quad_mask_4x4(0.575), 0xffff);
    assert_eq!(quad_mask_4x4(0.590), 0xffff);
    assert_eq!(quad_mask_4x4(0.600), 0xeeee);
}

#[test]
fn exact_seven_twelfths_rejects_the_dolphin_nine_sixteenths_only_pixel() {
    let points = [
        GxRasterPoint28_4::from_raw(-8, -8),
        GxRasterPoint28_4::from_raw(-8, 0),
        GxRasterPoint28_4::from_raw(52, 32),
    ];
    let triangle = raw_triangle(points, GxRasterScissor::full_efb());

    // Exact GX 7/12 coverage is 0x0040. Dolphin's software-reference
    // 9/16 approximation additionally covers bit zero and yields 0x0041.
    assert_eq!(mask_4x4(triangle), 0x0040);
    assert_eq!(
        triangle.bounds(),
        GxRasterBounds {
            left: 0,
            top: 0,
            right: 3,
            bottom: 2,
        }
    );
}

#[test]
fn rational_top_left_bias_is_not_scaled_with_the_edge_equation() {
    let edge = GxRasterEdge28_4::new(
        GxRasterPoint28_4::from_raw(0, 1),
        GxRasterPoint28_4::from_raw(9, 9),
    );
    assert!(edge.inclusive);
    assert_eq!(edge.value_3(0, 0), -1);
    assert!(!edge.covers_pixel(0, 0));
}

#[test]
fn shared_edge_masks_are_complementary_and_exhaustive() {
    let scissor = GxRasterScissor::full_efb();
    let upper_right = raw_triangle(
        [
            GxRasterPoint28_4::from_raw(0, 0),
            GxRasterPoint28_4::from_raw(64, 64),
            GxRasterPoint28_4::from_raw(64, 0),
        ],
        scissor,
    );
    let lower_left = raw_triangle(
        [
            GxRasterPoint28_4::from_raw(0, 0),
            GxRasterPoint28_4::from_raw(0, 64),
            GxRasterPoint28_4::from_raw(64, 64),
        ],
        scissor,
    );

    let upper_right_mask = mask_4x4(upper_right);
    let lower_left_mask = mask_4x4(lower_left);
    assert_eq!(upper_right_mask, 0x8cef);
    assert_eq!(lower_left_mask, 0x7310);
    assert_eq!(upper_right_mask | lower_left_mask, 0xffff);
    assert_eq!(upper_right_mask & lower_left_mask, 0);
}

#[test]
fn vertex_permutations_preserve_order_and_source_sign() {
    let base = [
        GxRasterPoint28_4::from_raw(0, 0),
        GxRasterPoint28_4::from_raw(64, 64),
        GxRasterPoint28_4::from_raw(64, 0),
    ];
    for permutation in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        let points = [
            base[permutation[0]],
            base[permutation[1]],
            base[permutation[2]],
        ];
        let expected_winding = raw_winding(points);
        let triangle = triangle(GxRasterTriangle28_4::setup_post_cull(
            points,
            expected_winding,
            GxRasterScissor::full_efb(),
        ));
        assert_eq!(triangle.source_winding(), expected_winding);
        let expected_mask = match expected_winding {
            GxRasterWinding::Negative => 0x8cef,
            GxRasterWinding::Positive => 0,
            GxRasterWinding::Collinear => unreachable!(),
        };
        assert_eq!(mask_4x4(triangle), expected_mask, "{permutation:?}");
    }
}

#[test]
fn pre_snap_winding_survives_a_snap_area_inversion_without_reordering() {
    let setup = GxRasterTriangle28_4::from_post_cull_efb(
        [[-0.25, 1.9375], [1.9375, 2.7175], [1.8125, 2.6575]],
        GxRasterWinding::Negative,
        GxRasterScissor::full_efb(),
    )
    .unwrap();
    assert_eq!(setup.source_winding(), GxRasterWinding::Negative);
    let triangle = triangle(setup);
    assert_eq!(triangle.source_winding(), GxRasterWinding::Negative);
    assert_eq!(
        triangle.bounds(),
        GxRasterBounds {
            left: 0,
            top: 2,
            right: 2,
            bottom: 3,
        }
    );
    // The snapped area inverted to +24. Coverage setup must not silently swap
    // it back: post-cull ordering belongs to the pre-snap homogeneous stage.
    assert_eq!(mask_4x4(triangle), 0);
}

#[test]
fn snapped_degenerates_retain_each_possible_source_winding() {
    let points = [
        GxRasterPoint28_4::from_raw(0, 0),
        GxRasterPoint28_4::from_raw(16, 16),
        GxRasterPoint28_4::from_raw(32, 32),
    ];
    for source_winding in [
        GxRasterWinding::Negative,
        GxRasterWinding::Collinear,
        GxRasterWinding::Positive,
    ] {
        let setup = GxRasterTriangle28_4::setup_post_cull(
            points,
            source_winding,
            GxRasterScissor::full_efb(),
        );
        assert_eq!(setup, GxRasterSetup::Degenerate { source_winding });
        assert_eq!(setup.source_winding(), source_winding);
    }
}

#[test]
fn odd_pixel_bounds_expand_to_the_even_two_by_two_block_origin() {
    let scissor = GxRasterScissor::full_efb();
    let first = triangle(
        GxRasterTriangle28_4::from_post_cull_efb(
            [[1.5, 2.5], [1.5, 2.75], [1.75, 2.75]],
            GxRasterWinding::Negative,
            scissor,
        )
        .unwrap(),
    );
    let second = triangle(
        GxRasterTriangle28_4::from_post_cull_efb(
            [[1.5, 2.5], [1.75, 2.75], [1.75, 2.5]],
            GxRasterWinding::Negative,
            scissor,
        )
        .unwrap(),
    );
    let expected_bounds = GxRasterBounds {
        left: 1,
        top: 2,
        right: 2,
        bottom: 3,
    };
    assert_eq!(first.bounds(), expected_bounds);
    assert_eq!(second.bounds(), expected_bounds);
    assert_eq!(
        first.coverage_mask_2x2(0, 2).unwrap().bits()
            | second.coverage_mask_2x2(0, 2).unwrap().bits(),
        0x2,
    );
    assert_eq!(mask_4x4(first) | mask_4x4(second), 0x0200);
}

#[test]
fn scissor_intersections_are_exhaustive_for_one_aligned_block() {
    let points = [
        GxRasterPoint28_4::from_raw(-64, -64),
        GxRasterPoint28_4::from_raw(-64, 192),
        GxRasterPoint28_4::from_raw(192, -64),
    ];
    for left in 0_u16..=2 {
        for right in left..=2 {
            for top in 0_u16..=2 {
                for bottom in top..=2 {
                    let scissor = GxRasterScissor::new(left, top, right, bottom, 0, 0).unwrap();
                    let triangle = raw_triangle(points, scissor);
                    let actual = triangle.coverage_mask_2x2(0, 0).unwrap().bits();
                    let mut expected = 0;
                    for y in 0_u16..2 {
                        for x in 0_u16..2 {
                            if x >= left && x < right && y >= top && y < bottom {
                                expected |= 1 << (y * 2 + x);
                            }
                        }
                    }
                    assert_eq!(
                        actual, expected,
                        "scissor=({left},{top})..({right},{bottom})"
                    );
                }
            }
        }
    }
}

#[test]
fn small_fixed_grid_masks_match_scalar_coverage() {
    let coordinates = [-1, 0, 9, 10, 16, 25, 26, 32];
    let mut points = Vec::new();
    for y in coordinates {
        for x in coordinates {
            points.push(GxRasterPoint28_4::from_raw(x, y));
        }
    }

    let mut checked = 0_u32;
    for &a in &points {
        for &b in &points {
            for &c in &points {
                let raw = [a, b, c];
                let GxRasterSetup::Triangle(triangle) = GxRasterTriangle28_4::setup_post_cull(
                    raw,
                    raw_winding(raw),
                    GxRasterScissor::full_efb(),
                ) else {
                    continue;
                };
                let mut scalar = 0;
                for y in 0..2 {
                    for x in 0..2 {
                        if triangle.covers_pixel(x, y) {
                            scalar |= 1 << (y * 2 + x);
                        }
                    }
                }
                assert_eq!(
                    triangle.coverage_mask_2x2(0, 0).unwrap().bits(),
                    scalar,
                    "points={raw:?}"
                );
                checked += 1;
            }
        }
    }
    assert!(checked > 200_000, "only checked {checked} triangles");
}

#[test]
fn scissor_validation_offsets_and_empty_rectangles_are_explicit() {
    assert_eq!(
        GxRasterScissor::new(2, 0, 1, 1, 0, 0),
        Err(GxRasterError::InvalidScissor)
    );
    assert_eq!(
        GxRasterScissor::new(0, 2, 1, 1, 0, 0),
        Err(GxRasterError::InvalidScissor)
    );
    assert_eq!(
        GxRasterScissor::new(0, 0, EFB_WIDTH as u16 + 1, 1, 0, 0),
        Err(GxRasterError::InvalidScissor)
    );
    assert_eq!(
        GxRasterScissor::new(0, 0, 1, EFB_HEIGHT as u16 + 1, 0, 0),
        Err(GxRasterError::InvalidScissor)
    );

    let offset_scissor =
        GxRasterScissor::new(0, 0, EFB_WIDTH as u16, EFB_HEIGHT as u16, 2, 3).unwrap();
    let point = GxRasterPoint28_4::from_efb(2.5, 3.5, 2, 3).unwrap();
    assert_eq!(point, GxRasterPoint28_4::from_raw(8, 8));
    let triangle = triangle(
        GxRasterTriangle28_4::from_post_cull_efb(
            [[2.0, 3.0], [2.0, 5.0], [4.0, 3.0]],
            GxRasterWinding::Negative,
            offset_scissor,
        )
        .unwrap(),
    );
    assert_eq!(triangle.coverage_mask_2x2(0, 0).unwrap().bits(), 0x1);

    let empty_scissor = GxRasterScissor::new(1, 1, 1, 1, 0, 0).unwrap();
    let outside = raw_triangle(
        [
            GxRasterPoint28_4::from_raw(0, 0),
            GxRasterPoint28_4::from_raw(0, 64),
            GxRasterPoint28_4::from_raw(64, 0),
        ],
        empty_scissor,
    );
    assert_eq!(outside.coverage_mask_2x2(0, 0).unwrap().bits(), 0);
}

#[test]
fn two_by_two_masks_require_even_efb_origins() {
    let triangle = raw_triangle(
        [
            GxRasterPoint28_4::from_raw(-64, -64),
            GxRasterPoint28_4::from_raw(-64, 192),
            GxRasterPoint28_4::from_raw(192, -64),
        ],
        GxRasterScissor::full_efb(),
    );
    assert_eq!(
        triangle.coverage_mask_2x2(1, 0),
        Err(GxRasterError::UnalignedBlockOrigin)
    );
    assert_eq!(
        triangle.coverage_mask_2x2(0, 1),
        Err(GxRasterError::UnalignedBlockOrigin)
    );
    assert_eq!(
        triangle.coverage_mask_2x2(1, 1),
        Err(GxRasterError::UnalignedBlockOrigin)
    );
    assert_eq!(triangle.coverage_mask_2x2(2, 2).unwrap().bits(), 0x0f);
}

#[test]
fn coordinate_errors_and_extreme_fixed_edges_are_checked() {
    for coordinate in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert_eq!(
            gx_non_aa_raster_coord_28_4(coordinate, 0),
            Err(GxRasterError::NonFiniteCoordinate)
        );
    }
    for coordinate in [f32::MAX, -f32::MAX, 134_217_728.0, -134_217_744.0] {
        assert_eq!(
            gx_non_aa_raster_coord_28_4(coordinate, 0),
            Err(GxRasterError::CoordinateOverflow),
            "{coordinate}"
        );
    }
    assert_eq!(
        gx_non_aa_raster_coord_28_4(-134_217_728.0, 0)
            .unwrap()
            .raw(),
        i32::MIN
    );
    assert_eq!(
        gx_non_aa_raster_coord_28_4(134_217_712.0, 0).unwrap().raw(),
        2_147_483_392
    );
    assert_eq!(
        GxRasterTriangle28_4::from_post_cull_efb(
            [[f32::NAN, 0.0], [0.0, 1.0], [1.0, 0.0]],
            GxRasterWinding::Negative,
            GxRasterScissor::full_efb(),
        ),
        Err(GxRasterError::NonFiniteCoordinate)
    );

    let extreme = raw_triangle(
        [
            GxRasterPoint28_4::from_raw(i32::MAX, i32::MAX),
            GxRasterPoint28_4::from_raw(i32::MAX, i32::MIN),
            GxRasterPoint28_4::from_raw(i32::MIN, i32::MAX),
        ],
        GxRasterScissor::full_efb(),
    );
    assert_eq!(
        extreme.bounds(),
        GxRasterBounds {
            left: 0,
            top: 0,
            right: EFB_WIDTH as i32,
            bottom: EFB_HEIGHT as i32,
        }
    );
    assert_eq!(extreme.coverage_mask_2x2(0, 0).unwrap().bits(), 0x0f);
    assert_eq!(
        extreme
            .coverage_mask_2x2(u32::MAX - 1, u32::MAX - 1)
            .unwrap()
            .bits(),
        0
    );
}

#[test]
fn rational_bounds_are_exact_across_signed_and_extreme_coordinates() {
    for (raw, expected) in [
        (-8, -1),
        (0, 0),
        (9, 0),
        (10, 1),
        (24, 1),
        (28, 2),
        (52, 3),
        (64, 4),
        (i32::MIN, -134_217_728),
        (i32::MAX, 134_217_728),
    ] {
        assert_eq!(
            gx_raster_ceil_sample_pixel(GxRasterCoord28_4(raw)),
            expected,
            "{raw}",
        );
    }
}
