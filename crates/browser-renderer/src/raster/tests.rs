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

#[test]
fn attribute_plane_interpolates_variable_depth_at_the_gx_sample() {
    let plane = GxRasterAttributePlaneF32::from_screen_triangle(
        [[0.0, 0.0], [4.0, 0.0], [0.0, 4.0]],
        [16.25, 48.25, 80.25],
    )
    .unwrap();
    assert_eq!(plane.slopes().dfdx(), 8.0);
    assert_eq!(plane.slopes().dfdy(), 16.0);

    let depth = plane.sample_non_aa(1, 2).unwrap();
    assert_eq!(depth, 70.25);
    assert_eq!(crate::gx_depth24_from_units(depth), 70);
}

#[test]
fn attribute_plane_constructs_the_exact_rational_sample_before_rounding() {
    let identity_x = GxRasterAttributePlaneF32::from_screen_triangle(
        [[0.0, 0.0], [4.0, 0.0], [0.0, 4.0]],
        [0.0, 4.0, 0.0],
    )
    .unwrap();
    let exact = 19.0_f32 / 12.0;
    let separately_rounded = 1.0_f32 + 7.0_f32 / 12.0;
    assert_eq!(
        identity_x.sample_non_aa(1, 1).unwrap().to_bits(),
        exact.to_bits()
    );
    assert_eq!(exact.to_bits(), 0x3fca_aaab);
    assert_eq!(separately_rounded.to_bits(), 0x3fca_aaaa);
}

#[test]
fn attribute_planes_interpolate_screen_linear_raster_channels() {
    let positions = [[0.0, 0.0], [12.0, 0.0], [0.0, 12.0]];
    let planes = [
        GxRasterAttributePlaneF32::from_screen_triangle(positions, [1.0, 241.0, 1.0]).unwrap(),
        GxRasterAttributePlaneF32::from_screen_triangle(positions, [2.0, 2.0, 122.0]).unwrap(),
        GxRasterAttributePlaneF32::from_screen_triangle(positions, [3.0, 123.0, 243.0]).unwrap(),
        GxRasterAttributePlaneF32::from_screen_triangle(positions, [255.0, 255.0, 255.0]).unwrap(),
    ];

    assert_eq!(planes[0].slopes().dfdx(), 20.0);
    assert_eq!(planes[0].slopes().dfdy(), 0.0);
    assert_eq!(planes[1].slopes().dfdx(), 0.0);
    assert_eq!(planes[1].slopes().dfdy(), 10.0);
    assert_eq!(planes[2].slopes().dfdx(), 10.0);
    assert_eq!(planes[2].slopes().dfdy(), 20.0);
    assert_eq!(
        gx_non_aa_raster_color_rgba8(planes, 2, 3).unwrap(),
        [52, 37, 100, 255],
    );
}

#[test]
fn attribute_plane_pins_f32_slope_and_evaluation_order() {
    let plane = GxRasterAttributePlaneF32::from_screen_triangle(
        [[7.0, 85.0], [-20.0, 29.0], [40.0, 70.0]],
        [-418.0, -313.0, 792.0],
    )
    .unwrap();

    assert_eq!(plane.origin_position(), [7.0, 85.0]);
    assert_eq!(plane.origin_value(), -418.0);
    assert_eq!(plane.slopes().dfdx().to_bits(), 0x41eb_02d7);
    assert_eq!(plane.slopes().dfdy().to_bits(), 0xc180_4f15);
    let value = plane.sample_non_aa(21, 77).unwrap();
    assert_eq!(value.to_bits(), 0x4301_5bd3);

    // Adding the Y term before the X term produces the adjacent f32. This
    // guards the setup's documented `f0 + dfdx*dx + dfdy*dy` association.
    let sample_x = 259.0_f32 / 12.0;
    let sample_y = 931.0_f32 / 12.0;
    let dx = sample_x - 7.0;
    let dy = sample_y - 85.0;
    let x_term = plane.slopes().dfdx() * dx;
    let y_term = plane.slopes().dfdy() * dy;
    let reordered = (-418.0_f32 + y_term) + x_term;
    assert_eq!(reordered.to_bits(), 0x4301_5bd2);
    assert_ne!(value.to_bits(), reordered.to_bits());
}

#[test]
fn attribute_plane_pins_f32_setup_operation_order() {
    let positions = [
        [f32::from_bits(0xc399_437a), f32::from_bits(0x43a3_da19)],
        [f32::from_bits(0xc35e_e365), f32::from_bits(0xc41a_fc1b)],
        [f32::from_bits(0x4383_b6b4), f32::from_bits(0xc289_dde7)],
    ];
    let attributes = [
        f32::from_bits(0xc462_8780),
        f32::from_bits(0xc366_9b6b),
        f32::from_bits(0xc44c_6bed),
    ];
    let plane = GxRasterAttributePlaneF32::from_screen_triangle(positions, attributes).unwrap();

    assert_eq!(plane.slopes().dfdx().to_bits(), 0xbeb9_f848);
    assert_eq!(plane.slopes().dfdy().to_bits(), 0xbf3e_b119);

    // A single rounding after each multiply-subtract gives different slope
    // bits. The GX reference sequence rounds both products before subtraction.
    let [[x0, y0], [x1, y1], [x2, y2]] = positions;
    let [f0, f1, f2] = attributes;
    let dx10 = x1 - x0;
    let dx20 = x2 - x0;
    let dy10 = y1 - y0;
    let dy20 = y2 - y0;
    let delta20 = f2 - f0;
    let delta10 = f1 - f0;
    let single_round_a =
        (f64::from(delta20) * f64::from(dy10) - f64::from(delta10) * f64::from(dy20)) as f32;
    let single_round_b =
        (f64::from(dx20) * f64::from(delta10) - f64::from(dx10) * f64::from(delta20)) as f32;
    let single_round_c =
        (f64::from(dx20) * f64::from(dy10) - f64::from(dx10) * f64::from(dy20)) as f32;
    assert_eq!((single_round_a / single_round_c).to_bits(), 0xbeb9_f846);
    assert_eq!((single_round_b / single_round_c).to_bits(), 0xbf3e_b117);
}

#[test]
fn raster_channel_conversion_clamps_then_truncates() {
    for (value, expected) in [
        (f32::NEG_INFINITY, 0),
        (-1.0, 0),
        (-0.0, 0),
        (0.0, 0),
        (0.999, 0),
        (1.999, 1),
        (254.999, 254),
        (255.0, 255),
        (300.0, 255),
        (f32::INFINITY, 255),
        (f32::NAN, 0),
    ] {
        assert_eq!(gx_raster_channel_u8(value), expected, "{value:?}");
    }
}

#[test]
fn attribute_plane_rejects_nonfinite_overflow_and_degenerate_inputs() {
    let positions = [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]];
    for coordinate in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert_eq!(
            GxRasterAttributePlaneF32::from_screen_triangle(
                [[coordinate, 0.0], positions[1], positions[2]],
                [0.0, 1.0, 2.0],
            ),
            Err(GxRasterAttributeError::NonFinitePosition),
        );
    }
    for attribute in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert_eq!(
            GxRasterAttributePlaneF32::from_screen_triangle(positions, [attribute, 1.0, 2.0],),
            Err(GxRasterAttributeError::NonFiniteAttribute),
        );
    }
    assert_eq!(
        GxRasterAttributePlaneF32::from_screen_triangle(
            [[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]],
            [0.0, 1.0, 2.0],
        ),
        Err(GxRasterAttributeError::DegenerateTriangle),
    );
    assert_eq!(
        GxRasterAttributePlaneF32::from_screen_triangle(
            [[f32::MAX, 0.0], [-f32::MAX, 0.0], [0.0, 1.0]],
            [0.0, 1.0, 2.0],
        ),
        Err(GxRasterAttributeError::PlaneOverflow),
    );

    let sample_overflow =
        GxRasterAttributePlaneF32::from_screen_triangle(positions, [0.0, f32::MAX / 4.0, 0.0])
            .unwrap();
    assert_eq!(
        sample_overflow.sample_non_aa(i32::MAX, 0),
        Err(GxRasterAttributeError::SampleOverflow),
    );

    let signed_sample = GxRasterAttributePlaneF32::from_screen_triangle(
        [[-4.0, -4.0], [4.0, -4.0], [-4.0, 4.0]],
        [-10.0, 6.0, 14.0],
    )
    .unwrap();
    assert_eq!(
        signed_sample.sample_non_aa(-2, -1).unwrap().to_bits(),
        0x40bd_5556,
    );
}

#[test]
fn gx_seven_twelfths_depth_plane_preserves_the_z101_seam() {
    let plane = GxRasterAttributePlaneF32::from_screen_triangle(
        [[0.0, 0.0], [1280.0, 0.0], [0.0, 1056.0]],
        [94.25, 94.25 + 12.0 * 1280.0, 94.25],
    )
    .unwrap();
    assert_eq!(plane.slopes().dfdx(), 12.0);
    assert_eq!(plane.slopes().dfdy(), 0.0);

    let gx_depth = plane.sample_non_aa(0, 0).unwrap();
    assert_eq!(gx_depth, 101.25);
    assert_eq!(crate::gx_depth24_from_units(gx_depth), 101);
    assert_eq!(crate::gx_depth24_from_units(94.25 + 12.0 * 0.5), 100,);
}
