use super::*;

fn exact_state() -> GxExactClipState {
    GxExactClipState {
        bp_gen_mode: 0,
        bp_scissor_top_left: (342 << 12) | 342,
        bp_scissor_bottom_right: ((342 + 639) << 12) | (342 + 527),
        bp_scissor_offset: 171 | (171 << 10),
        xf_clip_disable: 0,
        viewport_bits: [
            320.0f32.to_bits(),
            (-264.0f32).to_bits(),
            16_777_215.0f32.to_bits(),
            342.0f32.to_bits(),
            342.0f32.to_bits(),
            0.0f32.to_bits(),
        ],
    }
}

fn bits<const COMPONENTS: usize>(vertex: [f32; COMPONENTS]) -> [u32; COMPONENTS] {
    vertex.map(f32::to_bits)
}

#[test]
fn viewport_projection_matches_the_js_oracle_bit_for_bit() {
    let projection = GxExactProjectionState::qualify(exact_state()).unwrap();
    assert_eq!(
        projection.viewport().map(f32::to_bits),
        exact_state().viewport_bits
    );
    assert_eq!(projection.scissor_offset(), [342, 342]);
    assert_eq!(
        projection.raster_scissor(),
        GxRasterScissor::new(0, 0, 640, 528, 0, 0).unwrap()
    );

    let clip = [
        f32::from_bits(0x400a_aaab),
        f32::from_bits(0xbfb0_0000),
        f32::from_bits(0xc09b_ffff),
        f32::from_bits(0x4060_0000),
        f32::from_bits(0x8000_0000),
    ];
    assert_eq!(
        bits(projection.project(clip).unwrap()),
        [
            0x4346_1860,
            0x42cf_6db8,
            0xcbb2_4923,
            0x4060_0000,
            0x8000_0000,
        ],
        "divide, viewport multiply/add, and BP59 subtraction each round to f32"
    );
}

#[test]
fn raw_scissor_decoding_keeps_inclusive_corners_and_local_coordinates() {
    let mut state = exact_state();
    state.bp_scissor_top_left = (350 << 12) | 344;
    state.bp_scissor_bottom_right = (360 << 12) | 350;
    let projection = GxExactProjectionState::qualify(state).unwrap();
    assert_eq!(
        projection.raster_scissor(),
        GxRasterScissor::new(8, 2, 19, 9, 0, 0).unwrap()
    );

    state.bp_scissor_top_left = (300 << 12) | 300;
    state.bp_scissor_bottom_right = (400 << 12) | 400;
    let clipped = GxExactProjectionState::qualify(state).unwrap();
    assert_eq!(
        clipped.raster_scissor(),
        GxRasterScissor::new(0, 0, 59, 59, 0, 0).unwrap()
    );
}

#[test]
fn ignored_bp59_high_bits_do_not_change_projection_state() {
    let canonical = GxExactProjectionState::qualify(exact_state()).unwrap();
    let mut ignored_high_bits = exact_state();
    ignored_high_bits.bp_scissor_offset |= (1 << 9) | (1 << 19);
    assert_eq!(
        GxExactProjectionState::qualify(ignored_high_bits),
        Ok(canonical)
    );

    let mut ignored_corner_bits = exact_state();
    ignored_corner_bits.bp_scissor_top_left |= (1 << 11) | (1 << 23);
    ignored_corner_bits.bp_scissor_bottom_right |= (1 << 11) | (1 << 23);
    assert_eq!(
        GxExactProjectionState::qualify(ignored_corner_bits),
        Ok(canonical)
    );
}

#[test]
fn wrapped_empty_and_reversed_scissors_are_distinct() {
    let mut wrapped = exact_state();
    wrapped.bp_scissor_top_left = 0;
    wrapped.bp_scissor_bottom_right = (0x7ff << 12) | 0x7ff;
    assert_eq!(
        GxExactProjectionState::qualify(wrapped),
        Err(GxExactProjectionError::WrappedScissor)
    );

    let mut wrapped_only = exact_state();
    wrapped_only.bp_scissor_top_left = 342;
    wrapped_only.bp_scissor_bottom_right = (100 << 12) | (342 + 527);
    wrapped_only.bp_scissor_offset =
        511 | (exact_state().bp_scissor_offset & (GX_SCISSOR_OFFSET_MASK << 10));
    assert_eq!(
        GxExactProjectionState::qualify(wrapped_only),
        Err(GxExactProjectionError::WrappedScissor),
        "one rectangle visible only through a nonzero wrap is still unsupported"
    );

    let mut invisible = exact_state();
    invisible.bp_scissor_top_left = (1042 << 12) | 342;
    invisible.bp_scissor_bottom_right = (1100 << 12) | (342 + 527);
    assert_eq!(
        GxExactProjectionState::qualify(invisible),
        Err(GxExactProjectionError::NoVisibleScissor)
    );

    let mut reversed = exact_state();
    reversed.bp_scissor_top_left = (500 << 12) | 342;
    reversed.bp_scissor_bottom_right = (499 << 12) | (342 + 527);
    assert_eq!(
        GxExactProjectionState::qualify(reversed),
        Err(GxExactProjectionError::InvalidScissor)
    );
}

#[test]
fn all_nonzero_clip_disable_modes_remain_outside_the_exact_subset() {
    for value in 1..=7 {
        let mut state = exact_state();
        state.xf_clip_disable = value;
        assert_eq!(
            GxExactProjectionState::qualify(state),
            Err(GxExactProjectionError::UnsupportedClipDisable(value))
        );
    }
    let mut invalid = exact_state();
    invalid.xf_clip_disable = 8;
    assert_eq!(
        GxExactProjectionState::qualify(invalid),
        Err(GxExactProjectionError::InvalidClipDisable(8))
    );
}

#[test]
fn malformed_bp_and_viewport_state_cannot_reach_projection() {
    for mutate in [
        |state: &mut GxExactClipState| state.bp_gen_mode = 0x0100_0000,
        |state: &mut GxExactClipState| state.bp_scissor_top_left = 0x0100_0000,
        |state: &mut GxExactClipState| state.bp_scissor_bottom_right = 0x0100_0000,
        |state: &mut GxExactClipState| state.bp_scissor_offset = 0x0100_0000,
    ] {
        let mut state = exact_state();
        mutate(&mut state);
        assert_eq!(
            GxExactProjectionState::qualify(state),
            Err(GxExactProjectionError::InvalidBpState)
        );
    }

    for (component, value) in [
        (0, 0.0f32.to_bits()),
        (1, (-0.0f32).to_bits()),
        (2, f32::INFINITY.to_bits()),
        (3, f32::NAN.to_bits()),
        (4, f32::NEG_INFINITY.to_bits()),
        (5, f32::NAN.to_bits()),
    ] {
        let mut state = exact_state();
        state.viewport_bits[component] = value;
        assert_eq!(
            GxExactProjectionState::qualify(state),
            Err(GxExactProjectionError::InvalidViewport)
        );
    }
}

#[test]
fn projection_rejects_noncanonical_vertices_without_partial_output() {
    let projection = GxExactProjectionState::qualify(exact_state()).unwrap();
    assert_eq!(
        projection.project([0.0, 0.0, 1.0]),
        Err(GxExactProjectionError::InvalidComponentCount)
    );
    assert_eq!(
        projection.project([0.0, 0.0, 1.0, 1.0, f32::NAN]),
        Err(GxExactProjectionError::NonFiniteVertex)
    );
    for zero in [0.0, -0.0] {
        assert_eq!(
            projection.project([0.0, 0.0, 1.0, zero]),
            Err(GxExactProjectionError::ZeroClipW)
        );
    }
    assert_eq!(
        projection.project([1.0, 0.0, 0.0, f32::from_bits(1)]),
        Err(GxExactProjectionError::ArithmeticOverflow)
    );
}

#[test]
fn finite_negative_w_and_payload_bits_are_preserved() {
    let projection = GxExactProjectionState::qualify(exact_state()).unwrap();
    let projected = projection
        .project([0.5, -0.25, -0.75, -1.0, f32::from_bits(1)])
        .unwrap();
    assert!(projected[..4].iter().all(|component| component.is_finite()));
    assert_eq!(projected[3].to_bits(), (-1.0f32).to_bits());
    assert_eq!(projected[4].to_bits(), 1);
}
