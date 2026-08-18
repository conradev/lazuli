#[allow(dead_code)]
#[path = "../src/machine_evidence.rs"]
mod machine_evidence;

use lazuli_abi::{
    MACHINE_EVIDENCE_DSP_LLE_VALID, MACHINE_EVIDENCE_HAS_BOOT_IDENTITY,
    MACHINE_EVIDENCE_HAS_SI_PUBLICATION, MACHINE_EVIDENCE_HAS_XFB_VI,
    MACHINE_EVIDENCE_TERMINAL_ERROR, MachineBootFault, MachineBootStatus, MachineDiscFormat,
    MachineEvidenceV1, MachineSiPollSource, RenderPresentationStatus, RunReason, ViFieldParity,
    ViPresentationMode,
};
use machine_evidence::{
    AuthenticatedBootIdentity, AuthenticatedBootState, AuthenticatedSiPublication,
    AuthenticatedViCompletion, AuthenticatedViSelection, AuthenticatedXfbCompletion,
    DeviceCounters, GraphicsCounters, MachineEvidence, MachineEvidenceFault, MachineFault,
    RenderCounters, SchedulerCounters, SiCounters,
};

fn committed_boot(identifier: [u8; 6]) -> AuthenticatedBootState {
    AuthenticatedBootState {
        boot_epoch: 3,
        status: MachineBootStatus::Committed,
        fault: MachineBootFault::None,
        identity: Some(AuthenticatedBootIdentity {
            identifier,
            revision: 0,
            disc_number: 0,
            format: MachineDiscFormat::Ciso,
            logical_bytes: 889_225_792,
        }),
    }
}

fn scheduler(cycle: u64) -> SchedulerCounters {
    SchedulerCounters {
        canonical_cycle: cycle,
        executed_cycles: cycle - 100,
        executed_instructions: 50_000,
        address_space_generation: 7,
        retired_blocks: 1_200,
        completed_outer_slices: 12,
        semantic_idle_cycles: 0,
        semantic_idle_jumps: 0,
        pc: 0x8000_3100,
        machine_fault: None,
    }
}

#[test]
fn accepted_rust_chronology_issues_exact_address_free_snapshot() {
    let mut evidence = MachineEvidence::try_new(0x1122_3344_5566_7788).unwrap();
    evidence
        .accept_boot_state(committed_boot(*b"GZWE01"))
        .unwrap();
    evidence.accept_scheduler_commit(scheduler(1_000)).unwrap();
    evidence
        .accept_device_counters(DeviceCounters {
            raw_disk_reads: 24,
            vi_fields: 120,
            dsp_lle_steps: 64,
            dsp_lle_valid: true,
            ..DeviceCounters::default()
        })
        .unwrap();
    evidence
        .accept_graphics_counters(GraphicsCounters {
            gx_bytes: 4_096,
            gx_drains: 8,
            gx_commands: 32,
            gx_primitives: 12,
            xfb_copies: 1,
            presented_frames: 1,
            ..GraphicsCounters::default()
        })
        .unwrap();
    evidence
        .accept_renderer_counters(RenderCounters {
            render_requests_issued: 1,
            render_completions_authenticated: 1,
            render_high_water: 1,
            ..RenderCounters::default()
        })
        .unwrap();
    evidence
        .accept_authenticated_xfb(AuthenticatedXfbCompletion {
            completion_cycle: 700,
            generation: 5,
            width: 640,
            height: 448,
            stride: 1_280,
        })
        .unwrap();
    evidence
        .accept_renderer_counters(RenderCounters {
            render_requests_issued: 2,
            render_completions_authenticated: 1,
            render_pending: 1,
            render_high_water: 1,
            ..RenderCounters::default()
        })
        .unwrap();
    evidence
        .accept_vi_selection(AuthenticatedViSelection {
            selection_cycle: 800,
            render_sequence: 2,
            xfb_generation: 5,
            selected_row: 0,
            mode: ViPresentationMode::Progressive,
            parity: ViFieldParity::Top,
            pair_epoch: 9,
            output_width: 640,
            output_height: 448,
            field_stride_bytes: 1_280,
            field_height: 448,
            row_repeat: 1,
            pair_completing: true,
        })
        .unwrap();
    evidence
        .accept_renderer_counters(RenderCounters {
            render_requests_issued: 2,
            render_completions_authenticated: 2,
            render_high_water: 1,
            ..RenderCounters::default()
        })
        .unwrap();
    evidence
        .accept_vi_completion(AuthenticatedViCompletion {
            completion_cycle: 900,
            render_sequence: 2,
            presentation_status: RenderPresentationStatus::Presented,
            presentation_epoch: 9,
            presentation_width: 640,
            presentation_height: 448,
            presentation_serial: 11,
        })
        .unwrap();

    let left_packet = [0x00, 0x81, 0x00, 0x80, 0x80, 0x80, 0x00, 0x00];
    evidence
        .accept_si_counters(SiCounters {
            queue_depth: 0,
            last_received_sequence: 17,
            periodic_polls: 1,
            direct_polls: 0,
            backpressured_polls: 0,
            publication: Some(AuthenticatedSiPublication {
                source: MachineSiPollSource::Periodic,
                poll_index: 1,
                scheduled_cycle: 850,
                observed_cycle: 851,
                applied_sequence: 17,
                packet: left_packet,
            }),
        })
        .unwrap();

    let snapshot = evidence.snapshot().unwrap();
    assert_eq!(snapshot.header.byte_len, 816);
    assert_eq!(snapshot.boot.identifier(), *b"GZWE01");
    assert_eq!(snapshot.boot.logical_bytes.get(), 889_225_792);
    assert_eq!(snapshot.scheduler.pc, 0x8000_3100);
    assert_eq!(snapshot.scheduler.address_space_generation.get(), 7);
    assert_eq!(snapshot.scheduler.retired_blocks.get(), 1_200);
    assert_eq!(snapshot.scheduler.completed_outer_slices.get(), 12);
    assert_eq!(snapshot.si.packet(), left_packet);
    assert_eq!(snapshot.si.queue_depth, 0);
    assert_eq!(snapshot.si.last_received_sequence.get(), 17);
    assert_eq!(snapshot.si.applied_sequence.get(), 17);
    assert_eq!(snapshot.si.periodic_polls.get(), 1);
    assert_eq!(snapshot.xfb_vi.xfb_generation, 5);
    assert_eq!(snapshot.xfb_vi.selected_row, 0);
    assert_eq!(snapshot.xfb_vi.render_sequence.get(), 2);
    assert_eq!(snapshot.xfb_vi.presentation_serial.get(), 11);
    assert_eq!(
        snapshot.flags
            & (MACHINE_EVIDENCE_HAS_BOOT_IDENTITY
                | MACHINE_EVIDENCE_HAS_SI_PUBLICATION
                | MACHINE_EVIDENCE_HAS_XFB_VI),
        MACHINE_EVIDENCE_HAS_BOOT_IDENTITY
            | MACHINE_EVIDENCE_HAS_SI_PUBLICATION
            | MACHINE_EVIDENCE_HAS_XFB_VI
    );

    let mut bytes = [0_u8; MachineEvidenceV1::BYTE_LEN];
    assert!(snapshot.encode_le(&mut bytes));
    assert_eq!(MachineEvidenceV1::decode_le(&bytes), Some(snapshot));
    assert_eq!(evidence.snapshot().unwrap().snapshot_serial.get(), 2);
}

#[test]
fn counter_regression_poisons_all_later_snapshots() {
    let mut evidence = MachineEvidence::try_new(9).unwrap();
    evidence.accept_scheduler_commit(scheduler(1_000)).unwrap();
    let mut regressed = scheduler(999);
    regressed.executed_cycles = 899;
    assert_eq!(
        evidence.accept_scheduler_commit(regressed),
        Err(MachineEvidenceFault::SchedulerRegression)
    );
    assert_eq!(
        evidence.fault(),
        Some(MachineEvidenceFault::SchedulerRegression)
    );
    assert_eq!(evidence.snapshot(), Err(MachineEvidenceFault::Poisoned));
}

#[test]
fn one_si_service_batch_can_commit_periodic_then_direct_publications_in_order() {
    let mut evidence = MachineEvidence::try_new(11).unwrap();
    evidence.accept_scheduler_commit(scheduler(1_000)).unwrap();
    evidence
        .accept_si_counters(SiCounters {
            queue_depth: 1,
            last_received_sequence: 2,
            periodic_polls: 1,
            direct_polls: 0,
            backpressured_polls: 0,
            publication: Some(AuthenticatedSiPublication {
                source: MachineSiPollSource::Periodic,
                poll_index: 1,
                scheduled_cycle: 900,
                observed_cycle: 901,
                applied_sequence: 1,
                packet: [0x00, 0x80, 0x80, 0x80, 0x80, 0x80, 0, 0],
            }),
        })
        .unwrap();
    let direct_packet = [0x00, 0x81, 0x00, 0x80, 0x80, 0x80, 0, 0];
    evidence
        .accept_si_counters(SiCounters {
            queue_depth: 0,
            last_received_sequence: 2,
            periodic_polls: 1,
            direct_polls: 1,
            backpressured_polls: 0,
            publication: Some(AuthenticatedSiPublication {
                source: MachineSiPollSource::Direct,
                poll_index: 2,
                scheduled_cycle: 901,
                observed_cycle: 901,
                applied_sequence: 2,
                packet: direct_packet,
            }),
        })
        .unwrap();
    let snapshot = evidence.snapshot().unwrap();
    assert_eq!(snapshot.si.periodic_polls.get(), 1);
    assert_eq!(snapshot.si.direct_polls.get(), 1);
    assert_eq!(snapshot.si.backpressured_polls.get(), 0);
    assert_eq!(snapshot.si.poll_index.get(), 2);
    assert_eq!(snapshot.si.packet(), direct_packet);
    assert_eq!(snapshot.si.source(), Ok(MachineSiPollSource::Direct));
}

#[test]
fn boot_identity_is_immutable_within_an_authenticated_epoch() {
    let mut evidence = MachineEvidence::try_new(4).unwrap();
    evidence
        .accept_boot_state(committed_boot(*b"GZWE01"))
        .unwrap();
    assert_eq!(
        evidence.accept_boot_state(committed_boot(*b"GLME01")),
        Err(MachineEvidenceFault::BootRegression)
    );
    assert_eq!(evidence.snapshot(), Err(MachineEvidenceFault::Poisoned));
}

#[test]
fn failed_and_cancelled_boot_epochs_follow_the_live_boot_state_lifecycle() {
    let mut exhausted = MachineEvidence::try_new(12).unwrap();
    exhausted
        .accept_boot_state(AuthenticatedBootState {
            boot_epoch: 0,
            status: MachineBootStatus::Failed,
            fault: MachineBootFault::EpochExhausted,
            identity: None,
        })
        .unwrap();
    assert!(exhausted.snapshot().unwrap().has_canonical_shape());

    let mut cancelled = MachineEvidence::try_new(13).unwrap();
    cancelled
        .accept_boot_state(AuthenticatedBootState {
            boot_epoch: 0,
            status: MachineBootStatus::Cancelled,
            fault: MachineBootFault::None,
            identity: None,
        })
        .unwrap();
    assert!(cancelled.snapshot().unwrap().has_canonical_shape());

    let mut malformed = MachineEvidence::try_new(14).unwrap();
    assert_eq!(
        malformed.accept_boot_state(AuthenticatedBootState {
            boot_epoch: 0,
            status: MachineBootStatus::Failed,
            fault: MachineBootFault::Planning,
            identity: None,
        }),
        Err(MachineEvidenceFault::BootInvariant)
    );
}

#[test]
fn machine_fault_reason_and_detail_survive_without_collapsing_to_a_flag() {
    let mut evidence = MachineEvidence::try_new(5).unwrap();
    let mut counters = scheduler(1_000);
    counters.machine_fault = Some(MachineFault {
        reason: RunReason::Fault,
        detail: 18,
    });
    evidence.accept_scheduler_commit(counters).unwrap();
    let snapshot = evidence.snapshot().unwrap();
    assert_ne!(snapshot.flags & MACHINE_EVIDENCE_TERMINAL_ERROR, 0);
    assert_eq!(
        snapshot.scheduler.machine_fault_reason_raw,
        RunReason::Fault as u32
    );
    assert_eq!(snapshot.scheduler.machine_fault_detail, 18);
}

#[test]
fn renderer_failures_are_evidence_but_impossible_accounting_poisons() {
    let mut failed_run = MachineEvidence::try_new(6).unwrap();
    failed_run
        .accept_renderer_counters(RenderCounters {
            render_requests_issued: 1,
            render_completions_authenticated: 1,
            render_host_failures: 1,
            render_high_water: 1,
            ..RenderCounters::default()
        })
        .unwrap();
    let snapshot = failed_run.snapshot().unwrap();
    assert_eq!(snapshot.renderer.render_host_failures.get(), 1);

    let mut impossible = MachineEvidence::try_new(7).unwrap();
    assert_eq!(
        impossible.accept_renderer_counters(RenderCounters {
            render_requests_issued: 1,
            render_completions_authenticated: 0,
            render_pending: 0,
            render_high_water: 1,
            ..RenderCounters::default()
        }),
        Err(MachineEvidenceFault::RenderInvariant)
    );
    assert_eq!(impossible.snapshot(), Err(MachineEvidenceFault::Poisoned));

    let mut over_capacity = MachineEvidence::try_new(15).unwrap();
    assert_eq!(
        over_capacity.accept_renderer_counters(RenderCounters {
            render_requests_issued: 9,
            render_pending: 9,
            render_high_water: 9,
            ..RenderCounters::default()
        }),
        Err(MachineEvidenceFault::RenderInvariant)
    );
}

#[test]
fn canonical_bytes_have_no_xfb_address_or_pixel_payload_slot() {
    let forbidden_xfb_address = 0xdeca_fbadu32.to_le_bytes();
    let forbidden_pixels = [
        0xf1, 0xe2, 0xd3, 0xc4, 0xb5, 0xa6, 0x97, 0x88, 0x79, 0x6a, 0x5b, 0x4c, 0x3d, 0x2e, 0x1f,
        0x0f,
    ];
    let mut evidence = MachineEvidence::try_new(16).unwrap();
    evidence.accept_scheduler_commit(scheduler(1_000)).unwrap();
    let snapshot = evidence.snapshot().unwrap();
    let mut bytes = [0_u8; MachineEvidenceV1::BYTE_LEN];
    assert!(snapshot.encode_le(&mut bytes));
    assert!(
        !bytes
            .windows(4)
            .any(|window| window == forbidden_xfb_address)
    );
    assert!(
        !bytes
            .windows(forbidden_pixels.len())
            .any(|window| window == forbidden_pixels)
    );
}

#[test]
fn unknown_xfb_generation_and_snapshot_serial_wrap_fail_closed() {
    let mut chronology = MachineEvidence::try_new(8).unwrap();
    chronology
        .accept_scheduler_commit(scheduler(1_000))
        .unwrap();
    chronology
        .accept_renderer_counters(RenderCounters {
            render_requests_issued: 1,
            render_pending: 1,
            render_high_water: 1,
            ..RenderCounters::default()
        })
        .unwrap();
    assert_eq!(
        chronology.accept_vi_selection(AuthenticatedViSelection {
            selection_cycle: 800,
            render_sequence: 1,
            xfb_generation: 99,
            selected_row: 0,
            mode: ViPresentationMode::Progressive,
            parity: ViFieldParity::Top,
            pair_epoch: 1,
            output_width: 640,
            output_height: 448,
            field_stride_bytes: 1_280,
            field_height: 448,
            row_repeat: 1,
            pair_completing: true,
        }),
        Err(MachineEvidenceFault::UnknownXfbGeneration)
    );

    let mut serial = MachineEvidence::try_new(10).unwrap();
    serial.set_snapshot_serial_for_test(u64::MAX);
    assert_eq!(
        serial.snapshot(),
        Err(MachineEvidenceFault::SnapshotSerialOverflow)
    );
    assert_eq!(serial.snapshot(), Err(MachineEvidenceFault::Poisoned));
}

#[test]
fn address_space_generation_can_reenter_an_authenticated_namespace_but_never_zero() {
    let mut evidence = MachineEvidence::try_new(17).unwrap();
    let mut generation_a = scheduler(1_000);
    generation_a.address_space_generation = 1;
    evidence.accept_scheduler_commit(generation_a).unwrap();

    let mut generation_b = scheduler(1_001);
    generation_b.address_space_generation = 2;
    evidence.accept_scheduler_commit(generation_b).unwrap();

    let mut generation_a_again = scheduler(1_002);
    generation_a_again.address_space_generation = 1;
    evidence
        .accept_scheduler_commit(generation_a_again)
        .unwrap();
    assert_eq!(
        evidence
            .snapshot()
            .unwrap()
            .scheduler
            .address_space_generation
            .get(),
        1
    );

    let mut zero = scheduler(1_003);
    zero.address_space_generation = 0;
    assert_eq!(
        evidence.accept_scheduler_commit(zero),
        Err(MachineEvidenceFault::SchedulerInvariant)
    );
    assert_eq!(evidence.snapshot(), Err(MachineEvidenceFault::Poisoned));
}

#[test]
fn fatal_dsp_lle_state_clears_validity_and_cannot_be_revived() {
    let mut evidence = MachineEvidence::try_new(18).unwrap();
    evidence
        .accept_device_counters(DeviceCounters {
            dsp_lle_steps: 9,
            dsp_lle_valid: true,
            ..DeviceCounters::default()
        })
        .unwrap();
    evidence
        .accept_device_counters(DeviceCounters {
            dsp_lle_steps: 10,
            dsp_lle_valid: false,
            ..DeviceCounters::default()
        })
        .unwrap();
    assert_eq!(
        evidence.snapshot().unwrap().flags & MACHINE_EVIDENCE_DSP_LLE_VALID,
        0
    );
    assert_eq!(
        evidence.accept_device_counters(DeviceCounters {
            dsp_lle_steps: 10,
            dsp_lle_valid: true,
            ..DeviceCounters::default()
        }),
        Err(MachineEvidenceFault::DeviceRegression)
    );
}
