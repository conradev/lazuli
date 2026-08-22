//! Default-off attribution for synchronous resident-renderer work.
//!
//! The probe ABI is deliberately numeric and fixed-width. Rust owns every stage and counter;
//! the development harness may only relay the six `u32` fields. The imported hook must be a
//! total, nonthrowing JavaScript function because probe observation must not change renderer
//! behavior.

use std::cell::Cell;
#[cfg(test)]
use std::cell::RefCell;

#[cfg(all(feature = "resident-render-probe", target_arch = "wasm32"))]
use wasm_bindgen::prelude::*;

#[cfg(test)]
const GLOBAL_HOOK_NAME: &str = "__lazuliResidentRenderProbe";
#[cfg(test)]
const MAX_SPARSE_PROGRESS_EVENTS: usize = 65;
#[cfg(test)]
const MAX_GX_SYNC_PROBE_EVENTS: usize = 8
    + MAX_SPARSE_PROGRESS_EVENTS
    + (1 + MAX_SPARSE_PROGRESS_EVENTS)
    + (1 + MAX_SPARSE_PROGRESS_EVENTS)
    + (2 * MAX_SPARSE_PROGRESS_EVENTS)
    + MAX_SPARSE_PROGRESS_EVENTS
    + 2;

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ResidentRenderProbeStage {
    RequestEntry        = 1,
    ReceiptParseBegin   = 2,
    ReceiptParseEnd     = 3,
    ExecutionParseBegin = 4,
    ExecutionParseEnd   = 5,
    ExactPreparationProgress = 6,
    WorkEstimate        = 7,
    TexturePreflightProgress = 8,
    DrawExecutionProgress = 9,
    FlushBegin          = 10,
    PipelineCreationProgress = 11,
    PrimitiveEmissionProgress = 12,
    QueueSubmitBegin    = 13,
    QueueSubmitEnd      = 14,
    PromiseConstructed  = 15,
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ResidentRenderProbeWork {
    #[default]
    Unknown     = 0,
    ViPresent   = 1,
    TextureCopy = 2,
    XfbCopy     = 3,
    EfbPeek     = 4,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ProbeContext {
    active: bool,
    sequence_lo: u32,
    sequence_hi: u32,
    work: ResidentRenderProbeWork,
    queue_submissions: u64,
}

thread_local! {
    static CONTEXT: Cell<ProbeContext> = Cell::new(ProbeContext::default());
    #[cfg(test)]
    static TEST_EVENTS: RefCell<Vec<[u32; 6]>> = const { RefCell::new(Vec::new()) };
}

#[cfg(all(feature = "resident-render-probe", target_arch = "wasm32"))]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = globalThis, js_name = __lazuliResidentRenderProbe)]
    fn host_resident_render_probe(
        stage: u32,
        sequence_lo: u32,
        sequence_hi: u32,
        work0: u32,
        work1: u32,
        work2: u32,
    );
}

pub(crate) const fn saturating_u32(value: u64) -> u32 {
    if value > u32::MAX as u64 {
        u32::MAX
    } else {
        value as u32
    }
}

pub(crate) fn saturating_usize_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// Sample the first, every power-of-two, and the terminal progress ordinal.
///
/// This produces at most 65 callbacks for any `u64`-bounded loop, including the terminal sample.
pub(crate) const fn should_sample_progress(completed: u64, total: u64) -> bool {
    completed != 0 && (completed.is_power_of_two() || completed == total)
}

pub(crate) const fn primitive_ordered_gpu_draws(
    expanded_vertices: u64,
    primitive_vertex_width: u64,
) -> u64 {
    if primitive_vertex_width == 0 {
        return u64::MAX;
    }
    (expanded_vertices / primitive_vertex_width).saturating_mul(2)
}

fn emit_with_context(
    context: ProbeContext,
    stage: ResidentRenderProbeStage,
    work0: u32,
    work1: u32,
    work2: u32,
) {
    if !context.active {
        return;
    }
    #[cfg(test)]
    TEST_EVENTS.with(|events| {
        events.borrow_mut().push([
            stage as u32,
            context.sequence_lo,
            context.sequence_hi,
            work0,
            work1,
            work2,
        ]);
    });
    #[cfg(all(feature = "resident-render-probe", target_arch = "wasm32"))]
    host_resident_render_probe(
        stage as u32,
        context.sequence_lo,
        context.sequence_hi,
        work0,
        work1,
        work2,
    );
    #[cfg(not(all(feature = "resident-render-probe", target_arch = "wasm32")))]
    let _ = (stage, work0, work1, work2);
}

pub(crate) fn begin(sequence_lo: u32, sequence_hi: u32, request_bytes: usize, request_flags: u32) {
    let context = ProbeContext {
        active: true,
        sequence_lo,
        sequence_hi,
        ..ProbeContext::default()
    };
    CONTEXT.set(context);
    emit_with_context(
        context,
        ResidentRenderProbeStage::RequestEntry,
        saturating_usize_u32(request_bytes),
        request_flags,
        0,
    );
}

pub(crate) fn event(stage: ResidentRenderProbeStage, work0: u32, work1: u32, work2: u32) {
    emit_with_context(CONTEXT.get(), stage, work0, work1, work2);
}

pub(crate) fn set_work(work: ResidentRenderProbeWork) {
    let mut context = CONTEXT.get();
    context.work = work;
    CONTEXT.set(context);
}

pub(crate) fn queue_submit_begin() -> u64 {
    let mut context = CONTEXT.get();
    context.queue_submissions = context.queue_submissions.saturating_add(1);
    CONTEXT.set(context);
    emit_with_context(
        context,
        ResidentRenderProbeStage::QueueSubmitBegin,
        saturating_u32(context.queue_submissions),
        context.work as u32,
        0,
    );
    context.queue_submissions
}

pub(crate) fn queue_submit_end(ordinal: u64) {
    let context = CONTEXT.get();
    emit_with_context(
        context,
        ResidentRenderProbeStage::QueueSubmitEnd,
        saturating_u32(ordinal),
        context.work as u32,
        0,
    );
}

pub(crate) fn finish_sync_prefix() {
    let mut context = CONTEXT.get();
    emit_with_context(
        context,
        ResidentRenderProbeStage::PromiseConstructed,
        context.work as u32,
        saturating_u32(context.queue_submissions),
        0,
    );
    context.active = false;
    CONTEXT.set(context);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_and_work_codes_are_stable() {
        assert_eq!(GLOBAL_HOOK_NAME, "__lazuliResidentRenderProbe");
        assert_eq!(ResidentRenderProbeStage::RequestEntry as u32, 1);
        assert_eq!(ResidentRenderProbeStage::ReceiptParseBegin as u32, 2);
        assert_eq!(ResidentRenderProbeStage::ReceiptParseEnd as u32, 3);
        assert_eq!(ResidentRenderProbeStage::ExecutionParseBegin as u32, 4);
        assert_eq!(ResidentRenderProbeStage::ExecutionParseEnd as u32, 5);
        assert_eq!(ResidentRenderProbeStage::ExactPreparationProgress as u32, 6);
        assert_eq!(ResidentRenderProbeStage::WorkEstimate as u32, 7);
        assert_eq!(ResidentRenderProbeStage::TexturePreflightProgress as u32, 8);
        assert_eq!(ResidentRenderProbeStage::DrawExecutionProgress as u32, 9);
        assert_eq!(ResidentRenderProbeStage::FlushBegin as u32, 10);
        assert_eq!(
            ResidentRenderProbeStage::PipelineCreationProgress as u32,
            11
        );
        assert_eq!(
            ResidentRenderProbeStage::PrimitiveEmissionProgress as u32,
            12
        );
        assert_eq!(ResidentRenderProbeStage::QueueSubmitBegin as u32, 13);
        assert_eq!(ResidentRenderProbeStage::QueueSubmitEnd as u32, 14);
        assert_eq!(ResidentRenderProbeStage::PromiseConstructed as u32, 15);
        assert_eq!(ResidentRenderProbeWork::Unknown as u32, 0);
        assert_eq!(ResidentRenderProbeWork::ViPresent as u32, 1);
        assert_eq!(ResidentRenderProbeWork::TextureCopy as u32, 2);
        assert_eq!(ResidentRenderProbeWork::XfbCopy as u32, 3);
        assert_eq!(ResidentRenderProbeWork::EfbPeek as u32, 4);
    }

    #[test]
    fn work_counters_saturate_to_the_fixed_u32_abi() {
        assert_eq!(saturating_u32(0), 0);
        assert_eq!(saturating_u32(u64::from(u32::MAX)), u32::MAX);
        assert_eq!(saturating_u32(u64::from(u32::MAX) + 1), u32::MAX);
        assert_eq!(saturating_u32(u64::MAX), u32::MAX);
        assert_eq!(saturating_usize_u32(17), 17);
        if usize::BITS > u32::BITS {
            assert_eq!(saturating_usize_u32(usize::MAX), u32::MAX);
        }
    }

    #[test]
    fn sparse_sampling_is_deterministic_and_bounded() {
        let samples = (0..=20)
            .filter(|completed| should_sample_progress(*completed, 20))
            .collect::<Vec<_>>();
        assert_eq!(samples, [1, 2, 4, 8, 16, 20]);

        let maximum_samples = (0..64)
            .map(|power| 1_u64 << power)
            .filter(|completed| should_sample_progress(*completed, u64::MAX))
            .count()
            + usize::from(should_sample_progress(u64::MAX, u64::MAX));
        assert_eq!(maximum_samples, MAX_SPARSE_PROGRESS_EVENTS);
        assert_eq!(MAX_GX_SYNC_PROBE_EVENTS, 402);
        assert!(!should_sample_progress(0, 0));
    }

    #[test]
    fn primitive_ordered_estimate_counts_two_gpu_draws_per_primitive() {
        assert_eq!(primitive_ordered_gpu_draws(0, 3), 0);
        assert_eq!(primitive_ordered_gpu_draws(12, 3), 8);
        assert_eq!(primitive_ordered_gpu_draws(196_599, 3), 131_066);
        assert_eq!(primitive_ordered_gpu_draws(u64::MAX, 0), u64::MAX);
    }

    #[test]
    fn context_emits_exact_six_word_events_and_stops_at_the_promise_boundary() {
        TEST_EVENTS.with(|events| events.borrow_mut().clear());
        begin(0x1122_3344, 0x5566_7788, usize::MAX, 0xa5a5_5a5a);
        set_work(ResidentRenderProbeWork::TextureCopy);
        let first = queue_submit_begin();
        queue_submit_end(first);
        let second = queue_submit_begin();
        queue_submit_end(second);
        finish_sync_prefix();
        event(ResidentRenderProbeStage::FlushBegin, 9, 8, 7);

        let events = TEST_EVENTS.with(|events| events.borrow().clone());
        assert_eq!(
            events,
            [
                [
                    ResidentRenderProbeStage::RequestEntry as u32,
                    0x1122_3344,
                    0x5566_7788,
                    u32::MAX,
                    0xa5a5_5a5a,
                    0,
                ],
                [
                    ResidentRenderProbeStage::QueueSubmitBegin as u32,
                    0x1122_3344,
                    0x5566_7788,
                    1,
                    ResidentRenderProbeWork::TextureCopy as u32,
                    0,
                ],
                [
                    ResidentRenderProbeStage::QueueSubmitEnd as u32,
                    0x1122_3344,
                    0x5566_7788,
                    1,
                    ResidentRenderProbeWork::TextureCopy as u32,
                    0,
                ],
                [
                    ResidentRenderProbeStage::QueueSubmitBegin as u32,
                    0x1122_3344,
                    0x5566_7788,
                    2,
                    ResidentRenderProbeWork::TextureCopy as u32,
                    0,
                ],
                [
                    ResidentRenderProbeStage::QueueSubmitEnd as u32,
                    0x1122_3344,
                    0x5566_7788,
                    2,
                    ResidentRenderProbeWork::TextureCopy as u32,
                    0,
                ],
                [
                    ResidentRenderProbeStage::PromiseConstructed as u32,
                    0x1122_3344,
                    0x5566_7788,
                    ResidentRenderProbeWork::TextureCopy as u32,
                    2,
                    0,
                ],
            ]
        );
    }

    #[test]
    fn resident_stage_boundaries_and_queue_submit_brackets_cover_the_sync_prefix() {
        fn between<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
            source
                .split_once(start)
                .unwrap()
                .1
                .split_once(end)
                .unwrap()
                .0
        }

        fn assert_submit_brackets(function: &str, expected_submits: usize) {
            assert_eq!(
                function
                    .matches("self.queue.submit([encoder.finish()])")
                    .count(),
                expected_submits
            );
            assert_eq!(
                function
                    .matches("render_probe::queue_submit_begin()")
                    .count(),
                expected_submits
            );
            assert_eq!(
                function
                    .matches("render_probe::queue_submit_end(probe_queue_ordinal)")
                    .count(),
                expected_submits
            );
        }

        let source = include_str!("web.rs");
        let gx = between(
            source,
            "fn submit_gx_frame_bytes(",
            "fn push_tev_draw_inner(",
        );
        let estimate = gx.find("ResidentRenderProbeStage::WorkEstimate").unwrap();
        let texture = gx
            .find("ResidentRenderProbeStage::TexturePreflightProgress")
            .unwrap();
        let draw = gx
            .find("ResidentRenderProbeStage::DrawExecutionProgress")
            .unwrap();
        let push = gx.find("self.push_tev_draw_inner(").unwrap();
        assert!(estimate < texture && texture < draw && draw < push);

        assert_submit_brackets(
            between(source, "fn peek_efb_inner(", "pub fn copy_texture("),
            1,
        );
        assert_submit_brackets(
            between(source, "fn copy_texture_inner(", "pub fn copy_xfb("),
            2,
        );
        assert_submit_brackets(
            between(source, "fn copy_xfb_inner(", "pub fn present_xfb("),
            2,
        );
        assert_submit_brackets(
            between(
                source,
                "fn present_xfb_typed(",
                "fn xfb_present_bind_group(",
            ),
            1,
        );
    }
}
