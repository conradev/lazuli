#[path = "../src/render_runtime.rs"]
mod render_runtime;

use lazuli_abi::{
    HostCompletion, HostCompletionStatus, HostRequest, RENDER_RECEIPT_HAS_EFB_VALUE,
    RENDER_RECEIPT_HAS_PRESENTATION, RENDER_REQUEST_VI_PRESENT, RecordHeader,
    RenderPresentationStatus, RenderReceipt, RenderReceiptKind, RenderReceiptStatus, SharedPtr,
    ViFieldParity, ViPresentationMode,
};
use lzgx_packet::{CopyState, PacketInput, PacketVersion, TerminalKind, TerminalState, encode};
use render_runtime::{
    MAX_PENDING_RENDER_BYTES, MAX_PENDING_RENDER_REQUESTS, RenderCommitPlan,
    RenderCommitSupplement, RenderCompletion, RenderCompletionError, RenderCounter, RenderRuntime,
    RenderSubmitError, TextureCopyMaterialization, ViPresentationCommitPlan,
};

fn gx_packet(kind: TerminalKind, generation: u32) -> Vec<u8> {
    let (texture_layout, output_width, output_height, destination, stride, copy_command) =
        match kind {
            TerminalKind::TextureCopy => (true, 4, 4, 0x0010_0000, 32, 0),
            TerminalKind::XfbCopy => (false, 320, 240, 0x0020_0000, 640, 0x4000),
            TerminalKind::EfbPeek => (false, 0, 0, 1, 2, 0),
        };
    encode(&PacketInput {
        version: PacketVersion::V4,
        terminal: TerminalState {
            kind,
            texture_copy_layout_v1: texture_layout,
            source_x: if kind == TerminalKind::EfbPeek { 17 } else { 0 },
            source_y: if kind == TerminalKind::EfbPeek { 23 } else { 0 },
            source_width: if kind == TerminalKind::EfbPeek { 1 } else { 4 },
            source_height: if kind == TerminalKind::EfbPeek { 1 } else { 4 },
            output_width,
            output_height,
            destination,
            stride,
            generation,
            clear: false,
            copy: CopyState {
                copy_command,
                ..CopyState::default()
            },
        },
        draws: &[],
        textures: &[],
    })
    .unwrap()
}

fn submit_gx(
    runtime: &mut RenderRuntime,
    kind: TerminalKind,
    generation: u32,
    slot: u32,
) -> HostRequest {
    let supplement = match kind {
        TerminalKind::TextureCopy => RenderCommitSupplement::TextureCopy(Some(
            TextureCopyMaterialization::new(32, 2, 6, 3).unwrap(),
        )),
        TerminalKind::XfbCopy => RenderCommitSupplement::XfbCopy,
        TerminalKind::EfbPeek => RenderCommitSupplement::EfbPeek,
    };
    let base = 0x0010_0000 + slot * 0x0001_0000;
    runtime
        .submit_at(
            gx_packet(kind, generation),
            supplement,
            SharedPtr(base),
            SharedPtr(base + 0x8000),
        )
        .unwrap()
}

fn sequence(request: HostRequest) -> u64 {
    u64::from(request.arg0) | (u64::from(request.arg1) << 32)
}

fn host_completion(
    request: HostRequest,
    status: HostCompletionStatus,
    filled_len: u32,
) -> HostCompletion {
    HostCompletion {
        header: RecordHeader::for_record::<HostCompletion>(),
        request_id: request.request_id,
        request_nonce_lo: request.request_nonce_lo,
        request_nonce_hi: request.request_nonce_hi,
        status_raw: status as u32,
        filled_len,
        reserved: 0,
        value_lo: 0,
        value_hi: 0,
    }
}

fn stage_receipt(
    runtime: &mut RenderRuntime,
    request: HostRequest,
    receipt: RenderReceipt,
    payload: &[u8],
) -> u32 {
    let staging = runtime.receipt_staging_mut(request).unwrap();
    assert!(receipt.encode_le(staging));
    staging[RenderReceipt::BYTE_LEN..RenderReceipt::BYTE_LEN + payload.len()]
        .copy_from_slice(payload);
    u32::try_from(RenderReceipt::BYTE_LEN + payload.len()).unwrap()
}

fn completed_receipt(
    request: HostRequest,
    kind: RenderReceiptKind,
    generation: u32,
) -> RenderReceipt {
    RenderReceipt::new(
        sequence(request),
        kind,
        RenderReceiptStatus::Completed,
        generation,
    )
}

fn vi_plan(
    mode: ViPresentationMode,
    pair_completing: bool,
    address: u32,
) -> ViPresentationCommitPlan {
    ViPresentationCommitPlan::new(
        address,
        41,
        3,
        mode,
        ViFieldParity::Bottom,
        19,
        640,
        448,
        1280,
        224,
        2,
        pair_completing,
    )
    .unwrap()
}

#[test]
fn authentic_texture_xfb_and_efb_receipts_retain_private_commit_plans() {
    let mut runtime = RenderRuntime::new(0x1122_3344_5566_7788).unwrap();

    let texture = submit_gx(&mut runtime, TerminalKind::TextureCopy, 7, 0);
    let texture_payload = (0..64).map(|byte| byte ^ 0x5a).collect::<Vec<_>>();
    let mut receipt = completed_receipt(texture, RenderReceiptKind::TextureCopy, 7);
    receipt.payload_len = u32::try_from(texture_payload.len()).unwrap();
    let filled = stage_receipt(&mut runtime, texture, receipt, &texture_payload);
    let retained_before = runtime.pending_bytes();
    {
        let result = runtime
            .complete(
                texture,
                host_completion(texture, HostCompletionStatus::Ok, filled),
            )
            .unwrap();
        let RenderCompletion::Committed(committed) = result else {
            panic!("texture copy must commit");
        };
        assert_eq!(committed.sequence(), 1);
        assert_eq!(committed.retained_bytes(), Some(retained_before));
        assert_eq!(
            committed.texture_copy_bytes(),
            Some(texture_payload.as_slice())
        );
        let RenderCommitPlan::TextureCopy {
            terminal,
            materialization: Some(materialization),
        } = committed.plan().unwrap()
        else {
            panic!("private texture plan must survive");
        };
        assert_eq!(terminal.destination, 0x0010_0000);
        assert_eq!(materialization.row_bytes(), 32);
        assert_eq!(materialization.copy_format(), 6);
        assert_eq!(materialization.base_format(), 3);
    }
    assert_eq!(
        retained_before,
        gx_packet(TerminalKind::TextureCopy, 7).len() + 144
    );
    assert_eq!(runtime.pending_bytes(), 0);

    let xfb = submit_gx(&mut runtime, TerminalKind::XfbCopy, 8, 1);
    let receipt = completed_receipt(xfb, RenderReceiptKind::XfbCopy, 8);
    let filled = stage_receipt(&mut runtime, xfb, receipt, &[]);
    {
        let result = runtime
            .complete(xfb, host_completion(xfb, HostCompletionStatus::Ok, filled))
            .unwrap();
        match result {
            RenderCompletion::Committed(committed) => {
                assert!(matches!(
                    committed.plan(),
                    Some(RenderCommitPlan::XfbCopy { .. })
                ));
                assert_eq!(committed.presentation(), None);
            }
            RenderCompletion::Failed { .. } => panic!("XFB copy must commit"),
        }
    }

    let efb = submit_gx(&mut runtime, TerminalKind::EfbPeek, 9, 2);
    let mut receipt = completed_receipt(efb, RenderReceiptKind::EfbPeek, 9);
    receipt.flags = RENDER_RECEIPT_HAS_EFB_VALUE;
    receipt.efb_value = 0xa1b2_c3d4;
    let filled = stage_receipt(&mut runtime, efb, receipt, &[]);
    let result = runtime
        .complete(efb, host_completion(efb, HostCompletionStatus::Ok, filled))
        .unwrap();
    let RenderCompletion::Committed(committed) = result else {
        panic!("EFB peek must commit");
    };
    assert_eq!(committed.efb_value(), Some(0xa1b2_c3d4));
}

#[test]
fn vi_presentation_is_distinct_and_checks_staged_presented_and_rejected_outcomes() {
    let mut runtime = RenderRuntime::new(0x100).unwrap();

    let staged_plan = vi_plan(ViPresentationMode::Interlaced, false, 0);
    let staged = runtime
        .submit_vi_at(staged_plan, SharedPtr(0x3000), SharedPtr(0x4000))
        .unwrap();
    assert_eq!(staged.flags, RENDER_REQUEST_VI_PRESENT);
    assert_eq!(
        staged.length as usize,
        lazuli_abi::ViPresentationRequest::BYTE_LEN
    );
    assert_eq!(
        &runtime.packet_bytes(staged).unwrap()[16..20],
        &0u32.to_le_bytes()
    );
    let mut receipt = completed_receipt(staged, RenderReceiptKind::ViPresent, 41);
    receipt.flags = RENDER_RECEIPT_HAS_PRESENTATION;
    receipt.presentation_status_raw = RenderPresentationStatus::Staged as u32;
    receipt.presentation_epoch = 19;
    receipt.presentation_width = 640;
    receipt.presentation_height = 448;
    let filled = stage_receipt(&mut runtime, staged, receipt, &[]);
    {
        let result = runtime
            .complete(
                staged,
                host_completion(staged, HostCompletionStatus::Ok, filled),
            )
            .unwrap();
        match result {
            RenderCompletion::Committed(committed) => {
                assert_eq!(
                    committed.presentation().unwrap().status,
                    RenderPresentationStatus::Staged
                );
                assert_eq!(committed.presentation().unwrap().serial, 0);
                let plan = committed.plan().unwrap().vi_presentation().unwrap();
                assert_eq!(plan.selected_address(), 0);
                assert_eq!(plan.expected_generation(), 41);
                assert_eq!(plan.selected_row(), 3);
                assert_eq!(plan.mode(), ViPresentationMode::Interlaced);
                assert_eq!(plan.parity(), ViFieldParity::Bottom);
                assert_eq!(plan.output_width(), 640);
                assert_eq!(plan.output_height(), 448);
                assert_eq!(plan.field_stride_bytes(), 1280);
                assert_eq!(plan.field_height(), 224);
                assert_eq!(plan.row_repeat(), 2);
                assert!(!plan.pair_completing());
                assert_eq!(plan.pair_epoch(), 19);
                assert_eq!(committed.plan().unwrap().terminal(), None);
            }
            RenderCompletion::Failed { .. } => panic!("staged VI field must commit"),
        }
    }

    let presented_plan = vi_plan(ViPresentationMode::Interlaced, true, 0x0020_0000);
    let presented = runtime
        .submit_vi_at(presented_plan, SharedPtr(0x5000), SharedPtr(0x6000))
        .unwrap();
    let mut receipt = completed_receipt(presented, RenderReceiptKind::ViPresent, 41);
    receipt.flags = RENDER_RECEIPT_HAS_PRESENTATION;
    receipt.presentation_status_raw = RenderPresentationStatus::Presented as u32;
    receipt.presentation_epoch = 19;
    receipt.presentation_width = 640;
    receipt.presentation_height = 448;
    receipt.presentation_serial_lo = 73;
    let filled = stage_receipt(&mut runtime, presented, receipt, &[]);
    {
        let result = runtime
            .complete(
                presented,
                host_completion(presented, HostCompletionStatus::Ok, filled),
            )
            .unwrap();
        match result {
            RenderCompletion::Committed(committed) => {
                assert_eq!(committed.presentation().unwrap().serial, 73);
            }
            RenderCompletion::Failed { .. } => panic!("presented VI field must commit"),
        }
    }

    let rejected_plan = vi_plan(ViPresentationMode::Progressive, true, 0);
    let rejected = runtime
        .submit_vi_at(rejected_plan, SharedPtr(0x7000), SharedPtr(0x8000))
        .unwrap();
    let mut receipt = completed_receipt(rejected, RenderReceiptKind::ViPresent, 41);
    receipt.flags = RENDER_RECEIPT_HAS_PRESENTATION;
    receipt.presentation_status_raw = RenderPresentationStatus::Rejected as u32;
    receipt.presentation_epoch = 19;
    let filled = stage_receipt(&mut runtime, rejected, receipt, &[]);
    let result = runtime
        .complete(
            rejected,
            host_completion(rejected, HostCompletionStatus::Ok, filled),
        )
        .unwrap();
    let RenderCompletion::Committed(committed) = result else {
        panic!("rejected VI observation must commit its typed outcome");
    };
    assert_eq!(
        committed.presentation().unwrap().status,
        RenderPresentationStatus::Rejected
    );
}

#[test]
fn stale_duplicate_mutated_and_reordered_requests_never_apply_commits() {
    let mut runtime = RenderRuntime::new(91).unwrap();
    let first = submit_gx(&mut runtime, TerminalKind::EfbPeek, 11, 0);
    let second = submit_gx(&mut runtime, TerminalKind::EfbPeek, 12, 1);

    let mut mutated = first;
    mutated.flags = 1;
    assert_eq!(
        runtime.receipt_staging_mut(mutated).unwrap_err(),
        RenderCompletionError::MutatedRequestRecord
    );
    assert_eq!(
        runtime
            .complete(
                mutated,
                host_completion(mutated, HostCompletionStatus::HostError, 0),
            )
            .unwrap_err(),
        RenderCompletionError::MutatedRequestRecord
    );
    assert_eq!(runtime.pending_count(), 2);
    let mut stale = first;
    stale.request_nonce_hi ^= 0x8000_0000;
    assert_eq!(
        runtime.packet_bytes(stale).unwrap_err(),
        RenderCompletionError::StaleRequest
    );

    for (request, generation) in [(first, 11), (second, 12)] {
        let mut receipt = completed_receipt(request, RenderReceiptKind::EfbPeek, generation);
        receipt.flags = RENDER_RECEIPT_HAS_EFB_VALUE;
        receipt.efb_value = generation;
        stage_receipt(&mut runtime, request, receipt, &[]);
    }
    assert_eq!(
        runtime
            .complete(
                second,
                host_completion(
                    second,
                    HostCompletionStatus::Ok,
                    RenderReceipt::BYTE_LEN as u32,
                ),
            )
            .unwrap_err(),
        RenderCompletionError::ReorderedReceipt {
            expected_sequence: sequence(first),
            observed_sequence: sequence(second),
        }
    );
    assert_eq!(runtime.pending_count(), 2);

    for request in [first, second] {
        let result = runtime
            .complete(
                request,
                host_completion(
                    request,
                    HostCompletionStatus::Ok,
                    RenderReceipt::BYTE_LEN as u32,
                ),
            )
            .unwrap();
        assert!(matches!(result, RenderCompletion::Committed(_)));
        drop(result);
    }
    assert_eq!(runtime.pending_count(), 0);
    assert_eq!(
        runtime
            .complete(
                first,
                host_completion(
                    first,
                    HostCompletionStatus::Ok,
                    RenderReceipt::BYTE_LEN as u32,
                ),
            )
            .unwrap_err(),
        RenderCompletionError::DuplicateRequest
    );
}

#[test]
fn malformed_receipts_and_packet_mutation_consume_without_committing() {
    fn rejected_receipt(mutate: impl FnOnce(&mut RenderReceipt), expected: RenderCompletionError) {
        let mut runtime = RenderRuntime::new(37).unwrap();
        let request = submit_gx(&mut runtime, TerminalKind::EfbPeek, 13, 0);
        let mut receipt = completed_receipt(request, RenderReceiptKind::EfbPeek, 13);
        receipt.flags = RENDER_RECEIPT_HAS_EFB_VALUE;
        mutate(&mut receipt);
        let filled = stage_receipt(&mut runtime, request, receipt, &[]);
        assert_eq!(
            runtime
                .complete(
                    request,
                    host_completion(request, HostCompletionStatus::Ok, filled),
                )
                .unwrap_err(),
            expected
        );
        assert_eq!(runtime.pending_count(), 0);
    }

    rejected_receipt(
        |receipt| receipt.sequence_lo ^= 1,
        RenderCompletionError::WrongSequence,
    );
    rejected_receipt(
        |receipt| receipt.kind_raw = RenderReceiptKind::XfbCopy as u32,
        RenderCompletionError::WrongKind,
    );
    rejected_receipt(
        |receipt| receipt.generation += 1,
        RenderCompletionError::WrongGeneration,
    );
    rejected_receipt(
        |receipt| receipt.kind_raw = u32::MAX,
        RenderCompletionError::MalformedReceipt,
    );
    rejected_receipt(
        |receipt| receipt.reserved[0] = 1,
        RenderCompletionError::MalformedReceipt,
    );

    let mut runtime = RenderRuntime::new(41).unwrap();
    let request = submit_gx(&mut runtime, TerminalKind::EfbPeek, 14, 0);
    assert_eq!(
        runtime
            .complete(
                request,
                HostCompletion {
                    status_raw: u32::MAX,
                    ..host_completion(request, HostCompletionStatus::Ok, 0)
                },
            )
            .unwrap_err(),
        RenderCompletionError::UnknownHostStatus(u32::MAX)
    );
    assert_eq!(runtime.pending_count(), 0);

    let mut runtime = RenderRuntime::new(42).unwrap();
    let request = submit_gx(&mut runtime, TerminalKind::EfbPeek, 15, 0);
    let oversized = request.payload.len + 1;
    assert_eq!(
        runtime
            .complete(
                request,
                host_completion(request, HostCompletionStatus::Ok, oversized),
            )
            .unwrap_err(),
        RenderCompletionError::InvalidFilledLength
    );

    let mut runtime = RenderRuntime::new(43).unwrap();
    let request = submit_gx(&mut runtime, TerminalKind::EfbPeek, 16, 0);
    let mut receipt = completed_receipt(request, RenderReceiptKind::EfbPeek, 16);
    receipt.flags = RENDER_RECEIPT_HAS_EFB_VALUE;
    stage_receipt(&mut runtime, request, receipt, &[]);
    runtime.packet_mut_for_test(request).unwrap()[0] ^= 1;
    assert_eq!(
        runtime
            .complete(
                request,
                host_completion(
                    request,
                    HostCompletionStatus::Ok,
                    RenderReceipt::BYTE_LEN as u32,
                ),
            )
            .unwrap_err(),
        RenderCompletionError::PacketMutated
    );
    assert_eq!(runtime.pending_count(), 0);

    let mut runtime = RenderRuntime::new(44).unwrap();
    let request = submit_gx(&mut runtime, TerminalKind::EfbPeek, 17, 0);
    runtime.packet_mut_for_test(request).unwrap()[1] ^= 1;
    assert_eq!(
        runtime
            .complete(
                request,
                host_completion(request, HostCompletionStatus::HostError, 0),
            )
            .unwrap_err(),
        RenderCompletionError::PacketMutated
    );
    assert_eq!(runtime.pending_count(), 0);
}

#[test]
fn reacquisition_survives_queue_growth_and_queue_backpressure_is_exact() {
    let mut runtime = RenderRuntime::new(0x900).unwrap();
    let first = submit_gx(&mut runtime, TerminalKind::EfbPeek, 21, 0);
    let original_request = first;
    let original_native_staging = runtime.receipt_staging_mut(first).unwrap().as_ptr();
    for slot in 1..MAX_PENDING_RENDER_REQUESTS {
        submit_gx(
            &mut runtime,
            TerminalKind::EfbPeek,
            21 + u32::try_from(slot).unwrap(),
            u32::try_from(slot).unwrap(),
        );
    }
    assert_eq!(runtime.request(0), Some(original_request));
    assert_eq!(
        runtime.receipt_staging_mut(first).unwrap().as_ptr(),
        original_native_staging
    );
    assert_eq!(
        runtime
            .submit_at(
                gx_packet(TerminalKind::EfbPeek, 99),
                RenderCommitSupplement::EfbPeek,
                SharedPtr(0x00f0_0000),
                SharedPtr(0x00f0_8000),
            )
            .unwrap_err(),
        RenderSubmitError::PendingQueueFull
    );

    let mut receipt = completed_receipt(first, RenderReceiptKind::EfbPeek, 21);
    receipt.flags = RENDER_RECEIPT_HAS_EFB_VALUE;
    stage_receipt(&mut runtime, first, receipt, &[]);
    let result = runtime
        .complete(
            first,
            host_completion(
                first,
                HostCompletionStatus::Ok,
                RenderReceipt::BYTE_LEN as u32,
            ),
        )
        .unwrap();
    assert!(matches!(result, RenderCompletion::Committed(_)));
    drop(result);
    assert_eq!(runtime.pending_count(), MAX_PENDING_RENDER_REQUESTS - 1);
}

#[test]
fn overcapacity_packet_is_rejected_atomically_even_when_its_length_is_small() {
    let mut runtime = RenderRuntime::new(0x901).unwrap();
    let canonical = gx_packet(TerminalKind::EfbPeek, 22);
    let mut packet = Vec::with_capacity(MAX_PENDING_RENDER_BYTES + 1);
    packet.extend_from_slice(&canonical);
    assert_eq!(packet.len(), canonical.len());
    assert!(packet.capacity() > MAX_PENDING_RENDER_BYTES);

    assert_eq!(
        runtime
            .submit_at(
                packet,
                RenderCommitSupplement::EfbPeek,
                SharedPtr(0x0100_0000),
                SharedPtr(0x0100_8000),
            )
            .unwrap_err(),
        RenderSubmitError::PendingByteBudget
    );
    assert_eq!(runtime.pending_count(), 0);
    assert_eq!(runtime.pending_bytes(), 0);

    // Rejection cannot consume any one-use identity or sequence.
    let accepted = submit_gx(&mut runtime, TerminalKind::EfbPeek, 23, 0);
    assert_eq!(accepted.request_id, 1);
    assert_eq!(accepted.request_nonce(), 0x901);
    assert_eq!(sequence(accepted), 1);
}

#[test]
fn request_id_nonce_and_sequence_overflow_fail_before_publication() {
    for (request_id, nonce, sequence_value, expected) in [
        (
            u32::MAX,
            1,
            1,
            RenderSubmitError::CounterOverflow(RenderCounter::RequestId),
        ),
        (
            1,
            u64::MAX,
            1,
            RenderSubmitError::CounterOverflow(RenderCounter::RequestNonce),
        ),
        (
            1,
            1,
            u64::MAX,
            RenderSubmitError::CounterOverflow(RenderCounter::Sequence),
        ),
    ] {
        let mut runtime = RenderRuntime::new(1).unwrap();
        runtime.set_counters_for_test(request_id, nonce, sequence_value);
        assert_eq!(
            runtime
                .submit_at(
                    gx_packet(TerminalKind::EfbPeek, 31),
                    RenderCommitSupplement::EfbPeek,
                    SharedPtr(0x1000),
                    SharedPtr(0x2000),
                )
                .unwrap_err(),
            expected
        );
        assert_eq!(runtime.pending_count(), 0);
        assert_eq!(runtime.pending_bytes(), 0);
    }
}

#[test]
fn an_unfinished_commit_lease_blocks_submit_and_later_completion() {
    let mut runtime = RenderRuntime::new(0x700).unwrap();
    let first = submit_gx(&mut runtime, TerminalKind::EfbPeek, 35, 0);
    let second = submit_gx(&mut runtime, TerminalKind::EfbPeek, 36, 1);
    let mut receipt = completed_receipt(first, RenderReceiptKind::EfbPeek, 35);
    receipt.flags = RENDER_RECEIPT_HAS_EFB_VALUE;
    stage_receipt(&mut runtime, first, receipt, &[]);
    match runtime
        .complete(
            first,
            host_completion(
                first,
                HostCompletionStatus::Ok,
                RenderReceipt::BYTE_LEN as u32,
            ),
        )
        .unwrap()
    {
        RenderCompletion::Committed(committed) => std::mem::forget(committed),
        RenderCompletion::Failed { .. } => panic!("first request must enter its commit lease"),
    }

    assert_eq!(runtime.pending_count(), 2);
    assert_eq!(
        runtime
            .submit_at(
                gx_packet(TerminalKind::EfbPeek, 37),
                RenderCommitSupplement::EfbPeek,
                SharedPtr(0xd000),
                SharedPtr(0xe000),
            )
            .unwrap_err(),
        RenderSubmitError::CommitInProgress
    );
    assert_eq!(
        runtime
            .complete(
                second,
                host_completion(second, HostCompletionStatus::HostError, 0),
            )
            .unwrap_err(),
        RenderCompletionError::CommitInProgress
    );
}

#[test]
fn invalid_vi_outcome_and_host_failure_do_not_publish_semantic_commits() {
    let mut runtime = RenderRuntime::new(51).unwrap();
    let plan = vi_plan(ViPresentationMode::Progressive, true, 0);
    let request = runtime
        .submit_vi_at(plan, SharedPtr(0x9000), SharedPtr(0xa000))
        .unwrap();
    let mut receipt = completed_receipt(request, RenderReceiptKind::ViPresent, 41);
    receipt.flags = RENDER_RECEIPT_HAS_PRESENTATION;
    receipt.presentation_status_raw = RenderPresentationStatus::Staged as u32;
    receipt.presentation_epoch = 19;
    receipt.presentation_width = 640;
    receipt.presentation_height = 448;
    let filled = stage_receipt(&mut runtime, request, receipt, &[]);
    assert_eq!(
        runtime
            .complete(
                request,
                host_completion(request, HostCompletionStatus::Ok, filled),
            )
            .unwrap_err(),
        RenderCompletionError::WrongReceiptOptionals
    );

    let request = runtime
        .submit_vi_at(plan, SharedPtr(0xb000), SharedPtr(0xc000))
        .unwrap();
    {
        let result = runtime
            .complete(
                request,
                host_completion(request, HostCompletionStatus::HostError, 0),
            )
            .unwrap();
        match result {
            RenderCompletion::Failed {
                sequence: completed_sequence,
                failure: render_runtime::RenderFailure::Host(HostCompletionStatus::HostError),
            } => assert_eq!(completed_sequence, sequence(request)),
            _ => panic!("host failure must be typed and consume once"),
        }
    }

    let renderer_failed = submit_gx(&mut runtime, TerminalKind::EfbPeek, 52, 3);
    let receipt = RenderReceipt::new(
        sequence(renderer_failed),
        RenderReceiptKind::EfbPeek,
        RenderReceiptStatus::DeviceLost,
        52,
    );
    let filled = stage_receipt(&mut runtime, renderer_failed, receipt, &[]);
    let result = runtime
        .complete(
            renderer_failed,
            host_completion(renderer_failed, HostCompletionStatus::Ok, filled),
        )
        .unwrap();
    assert!(matches!(
        result,
        RenderCompletion::Failed {
            failure: render_runtime::RenderFailure::Renderer(RenderReceiptStatus::DeviceLost),
            ..
        }
    ));
}
