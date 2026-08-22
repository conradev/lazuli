#[allow(dead_code)]
#[path = "../src/render_runtime.rs"]
mod render_runtime;
#[allow(dead_code)]
#[path = "../src/vi_render.rs"]
mod vi_render;

use lazuli::Address;
use lazuli::system::vi::{
    Field, ScanoutDimensions, ScanoutLatch, ScanoutPolicy, ScanoutSnapshot, ScanoutWork,
};
use lazuli_abi::{ViFieldParity, ViPresentationMode};
use lzgx_packet::{CopyState, TerminalKind, TerminalState};
use vi_render::{
    MAX_RESIDENT_XFB_COPIES, ViHandoffError, ViRenderAdapter, ViRenderConfigError, ViRenderLimits,
    ViScanoutDeferred, ViScanoutOutcome, ViScanoutRejection, XfbRegistrationError,
};

const BASE: u32 = 0x0020_0000;
const WIDTH: u32 = 4;
const HEIGHT: u32 = 4;
const STRIDE: u32 = 8;

fn xfb(destination: u32, generation: u32) -> TerminalState {
    TerminalState {
        kind: TerminalKind::XfbCopy,
        texture_copy_layout_v1: false,
        source_x: 0,
        source_y: 0,
        source_width: WIDTH,
        source_height: HEIGHT,
        output_width: WIDTH,
        output_height: HEIGHT,
        destination,
        stride: STRIDE,
        generation,
        clear: false,
        copy: CopyState::default(),
    }
}

fn dimensions(policy: ScanoutPolicy) -> ScanoutDimensions {
    match policy {
        ScanoutPolicy::Direct => ScanoutDimensions {
            picture_configuration: 0,
            words_per_line: 0,
            standard_words_per_line: 0,
            active_lines: HEIGHT as u16,
            width: WIDTH as u16,
            field_stride_bytes: STRIDE,
            field_height: HEIGHT as u16,
            row_repeat: 1,
            height: HEIGHT as u16,
            policy,
        },
        ScanoutPolicy::Bob => ScanoutDimensions {
            picture_configuration: 0,
            words_per_line: 0,
            standard_words_per_line: 0,
            active_lines: (HEIGHT / 2) as u16,
            width: WIDTH as u16,
            field_stride_bytes: STRIDE * 2,
            field_height: (HEIGHT / 2) as u16,
            row_repeat: 2,
            height: HEIGHT as u16,
            policy,
        },
    }
}

fn snapshot(picture_latch_serial: u64) -> ScanoutSnapshot {
    let picture = (picture_latch_serial != 0).then_some(ScanoutLatch {
        value: 0,
        write_cycle: 0,
        write_serial: 0,
        field: Field::Top,
        latched_at_cycle: 0,
        latch_serial: picture_latch_serial,
        page_offset_raw: None,
        display_config: None,
        active_lines: None,
        top_vertical_timing: None,
    });
    ScanoutSnapshot {
        picture,
        ..ScanoutSnapshot::default()
    }
}

fn work(
    scheduled_cycle: u64,
    observed_cycle: u64,
    field: Field,
    address: Option<u32>,
    policy: ScanoutPolicy,
    picture_latch_serial: u64,
) -> ScanoutWork {
    ScanoutWork {
        scheduled_cycle,
        observed_cycle,
        cycles_late: observed_cycle - scheduled_cycle,
        field,
        address: address.map(Address),
        dimensions: dimensions(policy),
        snapshot: snapshot(picture_latch_serial),
    }
}

fn accept_ready(adapter: &mut ViRenderAdapter, outcome: ViScanoutOutcome) {
    let ViScanoutOutcome::Ready(handoff) = outcome else {
        panic!("scanout was not ready: {outcome:?}");
    };
    let (identity, _) = handoff.into_parts();
    adapter.accept_handoff(&identity).unwrap();
}

#[test]
fn address_zero_and_direct_fields_are_exact_immediate_units() {
    let mut adapter = ViRenderAdapter::new();
    adapter
        .record_authenticated_xfb_completion(xfb(0, 1))
        .unwrap();

    let first_work = work(10, 10, Field::Top, Some(0), ScanoutPolicy::Direct, 0);
    let ViScanoutOutcome::Ready(first) = adapter.prepare_scanout(first_work) else {
        panic!("address zero must resolve as an exact XFB destination");
    };
    let plan = first.plan();
    assert_eq!(plan.selected_address(), 0);
    assert_eq!(plan.selected_row(), 0);
    assert_eq!(plan.expected_generation(), 1);
    assert_eq!(plan.mode(), ViPresentationMode::SingleField);
    assert_eq!(plan.parity(), ViFieldParity::Top);
    assert_eq!(plan.pair_epoch(), 1);
    assert!(plan.pair_completing());
    let (first_identity, _) = first.into_parts();

    assert_eq!(
        adapter.prepare_scanout(work(
            20,
            20,
            Field::Bottom,
            Some(0),
            ScanoutPolicy::Direct,
            0,
        )),
        ViScanoutOutcome::Rejected(ViScanoutRejection::SubmissionInProgress)
    );
    adapter.cancel_handoff(&first_identity).unwrap();

    let ViScanoutOutcome::Ready(retry) = adapter.prepare_scanout(first_work) else {
        panic!("cancelled handoff must remain retryable");
    };
    assert_eq!(retry.plan().pair_epoch(), 1);
    let (retry_identity, _) = retry.into_parts();
    adapter.accept_handoff(&retry_identity).unwrap();
    assert_eq!(
        adapter.accept_handoff(&retry_identity),
        Err(ViHandoffError::NoPreparedHandoff)
    );

    let ViScanoutOutcome::Ready(second) = adapter.prepare_scanout(work(
        20,
        20,
        Field::Bottom,
        Some(0),
        ScanoutPolicy::Direct,
        0,
    )) else {
        panic!("direct bottom field must be ready");
    };
    assert_eq!(second.plan().selected_row(), 0);
    assert_eq!(second.plan().parity(), ViFieldParity::Bottom);
    assert_eq!(second.plan().pair_epoch(), 2);
    assert!(second.plan().pair_completing());
    let (second_identity, _) = second.into_parts();
    adapter.accept_handoff(&second_identity).unwrap();

    assert_eq!(
        adapter.prepare_scanout(first_work),
        ViScanoutOutcome::Rejected(ViScanoutRejection::StaleScanout {
            scheduled_cycle: 10,
            last_accepted_cycle: 20,
        })
    );
}

#[test]
fn bob_fields_pair_only_across_opposite_matching_signatures() {
    let mut adapter = ViRenderAdapter::new();
    adapter
        .record_authenticated_xfb_completion(xfb(BASE, 1))
        .unwrap();

    let top = work(10, 10, Field::Top, Some(BASE), ScanoutPolicy::Bob, 7);
    let ViScanoutOutcome::Ready(top_handoff) = adapter.prepare_scanout(top) else {
        panic!("top field must prepare");
    };
    assert_eq!(top_handoff.plan().mode(), ViPresentationMode::Interlaced);
    assert_eq!(top_handoff.plan().pair_epoch(), 1);
    assert!(!top_handoff.plan().pair_completing());
    let (identity, _) = top_handoff.into_parts();
    adapter.accept_handoff(&identity).unwrap();

    let bottom = work(
        20,
        20,
        Field::Bottom,
        Some(BASE + STRIDE),
        ScanoutPolicy::Bob,
        7,
    );
    let ViScanoutOutcome::Ready(bottom_handoff) = adapter.prepare_scanout(bottom) else {
        panic!("bottom field must prepare");
    };
    assert_eq!(bottom_handoff.plan().selected_row(), 1);
    assert_eq!(bottom_handoff.plan().pair_epoch(), 1);
    assert!(bottom_handoff.plan().pair_completing());
    let (identity, _) = bottom_handoff.into_parts();
    adapter.accept_handoff(&identity).unwrap();

    let duplicate_bottom = work(
        30,
        30,
        Field::Bottom,
        Some(BASE + STRIDE),
        ScanoutPolicy::Bob,
        7,
    );
    let ViScanoutOutcome::Ready(duplicate) = adapter.prepare_scanout(duplicate_bottom) else {
        panic!("a new same-parity field must open a new epoch");
    };
    assert_eq!(duplicate.plan().pair_epoch(), 2);
    assert!(!duplicate.plan().pair_completing());
    let (identity, _) = duplicate.into_parts();
    adapter.accept_handoff(&identity).unwrap();

    let mismatched_top = work(40, 40, Field::Top, Some(BASE), ScanoutPolicy::Bob, 8);
    let ViScanoutOutcome::Ready(mismatch) = adapter.prepare_scanout(mismatched_top) else {
        panic!("signature mismatch must supersede rather than cross-pair");
    };
    assert_eq!(mismatch.plan().pair_epoch(), 3);
    assert!(!mismatch.plan().pair_completing());
    let (identity, _) = mismatch.into_parts();
    adapter.accept_handoff(&identity).unwrap();

    let matching_bottom = work(
        50,
        50,
        Field::Bottom,
        Some(BASE + STRIDE),
        ScanoutPolicy::Bob,
        8,
    );
    let ViScanoutOutcome::Ready(completing) = adapter.prepare_scanout(matching_bottom) else {
        panic!("matching opposite parity must complete the retained pair");
    };
    assert_eq!(completing.plan().pair_epoch(), 3);
    assert!(completing.plan().pair_completing());
}

#[test]
fn registry_is_bounded_strictly_ordered_and_prefers_exact_destinations() {
    let mut adapter = ViRenderAdapter::try_new(
        ViRenderLimits {
            maximum_xfb_copies: 2,
        },
        1,
    )
    .unwrap();
    let exact = adapter
        .record_authenticated_xfb_completion(xfb(BASE + STRIDE, 1))
        .unwrap();
    assert_eq!(exact.evicted, None);
    adapter
        .record_authenticated_xfb_completion(xfb(BASE, 2))
        .unwrap();
    assert_eq!(adapter.resident_xfb_count(), 2);

    let ViScanoutOutcome::Ready(selected) = adapter.prepare_scanout(work(
        10,
        10,
        Field::Top,
        Some(BASE + STRIDE),
        ScanoutPolicy::Direct,
        0,
    )) else {
        panic!("exact destination must resolve");
    };
    assert_eq!(selected.plan().expected_generation(), 1);
    assert_eq!(selected.plan().selected_row(), 0);
    let (identity, _) = selected.into_parts();
    adapter.accept_handoff(&identity).unwrap();

    assert_eq!(
        adapter.record_authenticated_xfb_completion(xfb(BASE + 0x1000, 2)),
        Err(XfbRegistrationError::StaleGeneration {
            observed: 2,
            newest: 2,
        })
    );
    let update = adapter
        .record_authenticated_xfb_completion(xfb(BASE + 0x2000, 3))
        .unwrap();
    assert_eq!(update.evicted.map(|xfb| xfb.generation()), Some(1));
    assert_eq!(adapter.resident_xfb_count(), 2);

    let alias_outcome = adapter.prepare_scanout(work(
        20,
        20,
        Field::Bottom,
        Some(BASE + STRIDE),
        ScanoutPolicy::Bob,
        0,
    ));
    let ViScanoutOutcome::Ready(alias) = alias_outcome else {
        panic!(
            "evicted exact destination must fall back to retained adjacent alias: {alias_outcome:?}"
        );
    };
    assert_eq!(alias.plan().expected_generation(), 2);
    assert_eq!(alias.plan().selected_row(), 1);
    let (identity, _) = alias.into_parts();
    adapter.accept_handoff(&identity).unwrap();

    let replacement = adapter
        .record_authenticated_xfb_completion(xfb(BASE, 4))
        .unwrap();
    assert_eq!(replacement.replaced.map(|xfb| xfb.generation()), Some(2));
    assert_eq!(replacement.evicted, None);
    assert_eq!(adapter.resident_xfb_count(), 2);
}

#[test]
fn unavailable_xfb_defers_without_consuming_epoch_and_bad_geometry_rejects() {
    let mut adapter = ViRenderAdapter::new();
    let late_work = work(10, 17, Field::Top, Some(BASE), ScanoutPolicy::Direct, 0);
    assert_eq!(
        adapter.prepare_scanout(late_work),
        ViScanoutOutcome::Deferred(ViScanoutDeferred::XfbNotCompleted {
            address: BASE,
            cycles_late: 7,
            newest_generation: None,
        })
    );
    adapter
        .record_authenticated_xfb_completion(xfb(BASE, 1))
        .unwrap();
    let ViScanoutOutcome::Ready(retried) = adapter.prepare_scanout(late_work) else {
        panic!("authenticated completion must make deferred work retryable");
    };
    assert_eq!(retried.plan().pair_epoch(), 1);
    let (identity, _) = retried.into_parts();
    adapter.accept_handoff(&identity).unwrap();

    assert_eq!(
        adapter.prepare_scanout(work(20, 20, Field::Bottom, None, ScanoutPolicy::Direct, 0,)),
        ViScanoutOutcome::Rejected(ViScanoutRejection::MissingAddress)
    );

    let mut wrong_width = xfb(BASE + 0x1000, 2);
    wrong_width.output_width = WIDTH + 1;
    adapter
        .record_authenticated_xfb_completion(wrong_width)
        .unwrap();
    assert_eq!(
        adapter.prepare_scanout(work(
            30,
            30,
            Field::Top,
            Some(BASE + 0x1000),
            ScanoutPolicy::Direct,
            0,
        )),
        ViScanoutOutcome::Rejected(ViScanoutRejection::XfbWidthMismatch {
            scanout_width: WIDTH,
            xfb_width: WIDTH + 1,
        })
    );

    let mut bad_stride_work = work(40, 40, Field::Top, Some(BASE), ScanoutPolicy::Direct, 0);
    bad_stride_work.dimensions.field_stride_bytes = STRIDE + 4;
    assert_eq!(
        adapter.prepare_scanout(bad_stride_work),
        ViScanoutOutcome::Rejected(ViScanoutRejection::XfbStrideMismatch {
            field_stride_bytes: STRIDE + 4,
            xfb_stride: STRIDE,
        })
    );

    let mut too_tall = work(50, 50, Field::Top, Some(BASE), ScanoutPolicy::Bob, 0);
    too_tall.dimensions.field_height = 3;
    too_tall.dimensions.height = 6;
    assert_eq!(
        adapter.prepare_scanout(too_tall),
        ViScanoutOutcome::Rejected(ViScanoutRejection::XfbRowsOutOfRange)
    );
}

#[test]
fn malformed_xfb_metadata_and_adapter_limits_fail_closed() {
    assert!(matches!(
        ViRenderAdapter::try_new(
            ViRenderLimits {
                maximum_xfb_copies: 0,
            },
            1,
        ),
        Err(ViRenderConfigError::InvalidXfbCapacity)
    ));
    assert!(matches!(
        ViRenderAdapter::try_new(
            ViRenderLimits {
                maximum_xfb_copies: MAX_RESIDENT_XFB_COPIES + 1,
            },
            1,
        ),
        Err(ViRenderConfigError::InvalidXfbCapacity)
    ));
    assert!(matches!(
        ViRenderAdapter::try_new(ViRenderLimits::default(), 0),
        Err(ViRenderConfigError::InvalidNextPairEpoch)
    ));

    let mut adapter = ViRenderAdapter::new();
    let mut wrong_kind = xfb(BASE, 1);
    wrong_kind.kind = TerminalKind::TextureCopy;
    assert_eq!(
        adapter.record_authenticated_xfb_completion(wrong_kind),
        Err(XfbRegistrationError::WrongTerminalKind)
    );
    assert_eq!(
        adapter.record_authenticated_xfb_completion(xfb(BASE, 0)),
        Err(XfbRegistrationError::ZeroGeneration)
    );
    let mut degenerate = xfb(BASE, 1);
    degenerate.stride = 0;
    assert_eq!(
        adapter.record_authenticated_xfb_completion(degenerate),
        Err(XfbRegistrationError::InvalidGeometry)
    );
    let mut overflowing = xfb(u32::MAX - 3, 1);
    overflowing.output_height = 2;
    overflowing.stride = 8;
    assert_eq!(
        adapter.record_authenticated_xfb_completion(overflowing),
        Err(XfbRegistrationError::AddressRangeOverflow)
    );
    assert_eq!(adapter.resident_xfb_count(), 0);
}

#[test]
fn pair_epoch_exhaustion_and_handoff_authentication_are_fail_closed() {
    let mut exhausted = ViRenderAdapter::try_new(ViRenderLimits::default(), u32::MAX).unwrap();
    exhausted
        .record_authenticated_xfb_completion(xfb(BASE, 1))
        .unwrap();
    let final_epoch = exhausted.prepare_scanout(work(
        10,
        10,
        Field::Top,
        Some(BASE),
        ScanoutPolicy::Direct,
        0,
    ));
    let ViScanoutOutcome::Ready(final_epoch) = final_epoch else {
        panic!("u32::MAX is a valid final nonzero epoch");
    };
    assert_eq!(final_epoch.plan().pair_epoch(), u32::MAX);
    let (identity, _) = final_epoch.into_parts();
    exhausted.accept_handoff(&identity).unwrap();
    assert_eq!(
        exhausted.prepare_scanout(work(
            20,
            20,
            Field::Bottom,
            Some(BASE),
            ScanoutPolicy::Direct,
            0,
        )),
        ViScanoutOutcome::Rejected(ViScanoutRejection::PairEpochExhausted)
    );

    let mut first = ViRenderAdapter::new();
    let mut second = ViRenderAdapter::try_new(ViRenderLimits::default(), 9).unwrap();
    first
        .record_authenticated_xfb_completion(xfb(BASE, 1))
        .unwrap();
    second
        .record_authenticated_xfb_completion(xfb(BASE, 1))
        .unwrap();
    let ViScanoutOutcome::Ready(first_handoff) = first.prepare_scanout(work(
        30,
        30,
        Field::Top,
        Some(BASE),
        ScanoutPolicy::Direct,
        0,
    )) else {
        panic!("first adapter did not prepare");
    };
    let ViScanoutOutcome::Ready(second_handoff) = second.prepare_scanout(work(
        40,
        40,
        Field::Top,
        Some(BASE),
        ScanoutPolicy::Direct,
        0,
    )) else {
        panic!("second adapter did not prepare");
    };
    let (first_identity, _) = first_handoff.into_parts();
    let (second_identity, _) = second_handoff.into_parts();
    assert_eq!(
        first.accept_handoff(&second_identity),
        Err(ViHandoffError::WrongHandoff)
    );
    first.accept_handoff(&first_identity).unwrap();
    second.cancel_handoff(&second_identity).unwrap();
}

#[test]
fn invalid_timing_is_rejected_before_registry_or_pair_state_changes() {
    let mut adapter = ViRenderAdapter::new();
    adapter
        .record_authenticated_xfb_completion(xfb(BASE, 1))
        .unwrap();
    let mut invalid = work(10, 10, Field::Top, Some(BASE), ScanoutPolicy::Direct, 0);
    invalid.observed_cycle = 9;
    invalid.cycles_late = 0;
    assert_eq!(
        adapter.prepare_scanout(invalid),
        ViScanoutOutcome::Rejected(ViScanoutRejection::InvalidTiming)
    );

    let valid = adapter.prepare_scanout(work(
        10,
        10,
        Field::Top,
        Some(BASE),
        ScanoutPolicy::Direct,
        0,
    ));
    let ViScanoutOutcome::Ready(valid) = valid else {
        panic!("invalid timing must not consume the first epoch");
    };
    assert_eq!(valid.plan().pair_epoch(), 1);
}

#[test]
fn helper_accepts_ready_handoff_without_host_state() {
    let mut adapter = ViRenderAdapter::new();
    adapter
        .record_authenticated_xfb_completion(xfb(BASE, 1))
        .unwrap();
    let outcome =
        adapter.prepare_scanout(work(1, 1, Field::Top, Some(BASE), ScanoutPolicy::Direct, 0));
    accept_ready(&mut adapter, outcome);
    assert!(!adapter.has_prepared_handoff());
}
