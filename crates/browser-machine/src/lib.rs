//! Unified Rust-owned browser machine.
//!
//! This crate is the ownership boundary that replaces the browser's JavaScript machine model.
//! It imports one fixed linear memory, maps the architected storage windows without copying, and
//! owns one complete [`lazuli::System`]. JavaScript is not allowed to answer MMU questions: the
//! resident dispatcher calls [`validate_instruction_page_dependency`] directly in WebAssembly.

pub mod cold_compiler;
pub mod core_run;
pub mod di_runtime;
pub mod disc_boot;
#[cfg(feature = "game-fidelity-probes")]
mod game_fidelity;
#[cfg(feature = "game-fidelity-probes")]
mod game_fidelity_integration;
#[cfg(all(test, feature = "game-fidelity-probes"))]
mod game_fidelity_machine_tests;
pub mod gx_runtime;
mod machine_evidence;
pub mod render_runtime;
pub mod vi_render;

#[cfg(any(target_arch = "wasm32", test))]
use std::cell::UnsafeCell;
use std::collections::VecDeque;
#[cfg(any(target_arch = "wasm32", test))]
use std::mem::MaybeUninit;

#[cfg(any(target_arch = "wasm32", test))]
use cold_compiler::{
    ColdCompileRetirements, InstallableColdBlock, PrepareCurrentPcError, PrepareCurrentPcFailure,
    PreparedCompileRequest, ResidentModule, RustColdBlockCompiler,
};
use core_run::CoreRunCoordinator;
use di_runtime::{
    BrowserDiCallResult, BrowserDiError, BrowserDiLifecycleEvidence, BrowserDiRuntime,
};
use disc_boot::{
    BOOT_LOW_MEMORY_BYTES, BrowserDiscBootError, BrowserDiscBootFaultCode, BrowserDiscBootProgress,
    BrowserDiscBootState, BrowserDiscBootStatus, committed_low_memory,
};
#[cfg(feature = "game-fidelity-probes")]
use game_fidelity::{GAME_FIDELITY_RECORD_BYTES, ProbePhase};
#[cfg(feature = "game-fidelity-probes")]
use game_fidelity_integration::GameFidelityIntegration;
#[cfg(any(target_arch = "wasm32", test))]
use gx_runtime::GxEfbPeekProgress;
use gx_runtime::{
    GxProgressIdentity, GxRuntimeError, GxRuntimeEvent, GxRuntimeLimits, GxRuntimeStats,
    GxTerminalSupplement, PeBpEffect, ResidentGxRuntime,
};
use lazuli::Address;
use lazuli::disks::async_boot::{
    MAX_BOOT_LOAD_CHUNK_BYTES, MAX_COMMITTED_DISC_READ_BYTES, ReadRequest,
};
#[cfg(any(target_arch = "wasm32", test))]
use lazuli::modules::audio::NopAudioModule;
#[cfg(any(target_arch = "wasm32", test))]
use lazuli::modules::debug::NopDebugModule;
#[cfg(any(target_arch = "wasm32", test))]
use lazuli::modules::disk::NopDiskModule;
#[cfg(any(target_arch = "wasm32", test))]
use lazuli::modules::input::NopInputModule;
#[cfg(any(target_arch = "wasm32", test))]
use lazuli::modules::render::NopRenderModule;
#[cfg(any(target_arch = "wasm32", test))]
use lazuli::modules::vertex::NopVertexModule;
#[cfg(any(target_arch = "wasm32", test))]
use lazuli::runtime::TableSlotRetirement;
use lazuli::runtime::{AddressSpaceGeneration, ColdCompileCoordinator};
#[cfg(target_arch = "wasm32")]
use lazuli::runtime::{CompletedCompile, IndexedCachedBlock, SelfInstallError};
#[cfg(any(target_arch = "wasm32", test))]
use lazuli::runtime_hooks::{HookMemoryBoundary, MemoryHookResult, ResidentMemoryRead};
use lazuli::runtime_hooks::{HookOutcome, HookResult, MachineRuntimeHooks};
use lazuli::stream::BinaryStream;
#[cfg(target_arch = "wasm32")]
use lazuli::system::MappedSystemBacking;
use lazuli::system::bus::ResidentMmioError;
use lazuli::system::di::{
    ResidentAudioBufferConfiguration, ResidentCommandKind, ResidentDiLifecycleEvidence,
    ResidentDiLifecycleState, ResidentServiceState,
};
use lazuli::system::dspi::{DspLleServiceError, ResidentDspServiceError};
#[cfg(any(target_arch = "wasm32", test))]
use lazuli::system::gx::resident_fifo::EfbPeekRequest;
use lazuli::system::gx::resident_fifo::{
    DecodeStatus, DecoderStats, EfbPeekAddress, GxMemory, MemoryError as GxMemoryError,
    SemanticRecord, classify_efb_peek_address,
};
use lazuli::system::gx::resident_texture::{TextureCopyReference, materialized_texture_hash};
#[cfg(target_arch = "wasm32")]
use lazuli::system::mem::MappedMemoryBacking;
use lazuli::system::mmu::{TranslationEffect, TranslationSource};
use lazuli::system::scheduler::{
    MachineEventDeadlines, MachineEventKind, MachineServicePhase, RuntimeDeadlinePolicy,
};
#[cfg(any(target_arch = "wasm32", test))]
use lazuli::system::{Config, Modules};
use lazuli::system::{System, pi, si};
pub use lazuli_abi::memory::{
    ARAM_BYTES, ARAM_OFFSET, DISPATCH_ENTRY_CAPACITY, DISPATCH_METADATA_BYTES,
    DISPATCH_METADATA_OFFSET, DISPATCH_RESERVED_END, DISPATCH_SLOT_CAPACITY,
    DISPATCH_SLOT_IDENTITY_BYTES, DISPATCH_SLOT_IDENTITY_OFFSET, IPL_BYTES, IPL_OFFSET, L2C_BYTES,
    L2C_OFFSET, MACHINE_RESERVED_END, MAIN_RAM_BYTES, MAIN_RAM_OFFSET, MMIO_BYTES, MMIO_OFFSET,
    RESIDENT_MEMORY_BYTES, RESIDENT_MEMORY_INITIAL_PAGES, RESIDENT_MEMORY_MAXIMUM_PAGES,
    RESIDENT_RUNTIME_END, RUNTIME_BASE, WASM_PAGE_BYTES,
};
pub use lazuli_abi::{
    ABI_VERSION, DISPATCH_ENTRY_READY, DISPATCH_SLOT_READY, DispatchCacheRecord,
    DispatchDependency, DispatchSlotIdentityRecord, MachineEvidenceV1, RESIDENT_CONTEXT_BYTES,
    RESIDENT_STACK_SCRATCH_BYTES, RESIDENT_STACK_SCRATCH_OFFSET, ResidentBlockInstallIdentity,
    ResidentControl, ResidentInstallStatus, RunOutcome, RunReason,
};
use lazuli_abi::{
    HostCompletion, HostCompletionStatus, HostRequest, MachineDiCommandKind,
    MachineDiLifecycleState, RenderReceipt, SharedPtr,
};
use machine_evidence::{
    AuthenticatedBootIdentity, AuthenticatedBootState, AuthenticatedSiPublication,
    AuthenticatedViCompletion, AuthenticatedViSelection, AuthenticatedXfbCompletion,
    DeviceCounters, DiCounters, GraphicsCounters, MachineEvidence, MachineFault, RenderCounters,
    SchedulerCounters, SiCounters,
};
use render_runtime::{
    MAX_PENDING_RENDER_BYTES, MAX_PENDING_RENDER_REQUESTS, MAX_RENDER_PACKET_BYTES,
    MAX_RENDER_RECEIPT_PAYLOAD_BYTES, RenderCommitPlan, RenderCommitSupplement, RenderCompletion,
    RenderCompletionError, RenderFailure, RenderPresentation, RenderRuntime, RenderSubmitError,
    TextureCopyMaterialization,
};
use vi_render::{CompletedXfb, ViRenderAdapter, ViScanoutOutcome, ViScanoutRejection};

const PAGE_MASK: u32 = 0x0fff;
const CODE_CACHE_SET_COUNT: usize = 1024;
const CP_FIFO_SERVICE_BUDGET_BYTES: usize = 256 * 1024;
const MAX_PENDING_PE_EFFECTS: usize = 65_536;
const FIRST_RENDER_NONCE: u64 = 0x4c5a_4758_0000_0001;
const MACHINE_EVIDENCE_EPOCH: u64 = 1;

#[cfg(feature = "game-fidelity-probes")]
const fn pack_game_fidelity_stick_xy_cxy(state: si::ControllerInputState) -> u32 {
    u32::from_le_bytes([
        state.stick_x,
        state.stick_y,
        state.c_stick_x,
        state.c_stick_y,
    ])
}

#[cfg(feature = "game-fidelity-probes")]
const fn pack_game_fidelity_trigger_lrab(state: si::ControllerInputState) -> u32 {
    u32::from_le_bytes([
        state.trigger_l,
        state.trigger_r,
        state.analog_a,
        state.analog_b,
    ])
}

/// Host-publishable GameCube button bits. PAD_USE_ORIGIN and the unused high bits are generated
/// or reserved by SI and therefore cannot be authored through the browser boundary.
const CONTROLLER_INPUT_BUTTON_MASK: u32 = 0x0000_1f7f;

const _: () = assert!(ARAM_BYTES == lazuli::system::dspi::ARAM_LEN);
const _: () = assert!(MAIN_RAM_BYTES == lazuli::system::mem::RAM_LEN);
const _: () = assert!(L2C_BYTES == lazuli::system::mem::L2C_LEN);
const _: () = assert!(IPL_BYTES == lazuli::system::mem::IPL_LEN);
const _: () = assert!(core::mem::size_of::<MachineEvidenceV1>() == 816);
const _: () = assert!(MachineEvidenceV1::BYTE_LEN == 816);
const _: () = assert!(
    core::mem::size_of::<DispatchCacheRecord>() * DISPATCH_ENTRY_CAPACITY
        == DISPATCH_METADATA_BYTES
);
const _: () = assert!(
    core::mem::size_of::<DispatchSlotIdentityRecord>() * DISPATCH_SLOT_CAPACITY
        == DISPATCH_SLOT_IDENTITY_BYTES
);

#[cfg(any(target_arch = "wasm32", test))]
fn nop_modules() -> Modules {
    Modules {
        audio: Box::new(NopAudioModule),
        debug: Box::new(NopDebugModule),
        disk: Box::new(NopDiskModule),
        input: Box::new(NopInputModule),
        render: Box::new(NopRenderModule),
        vertex: Box::new(NopVertexModule),
    }
}

#[cfg(target_arch = "wasm32")]
fn mapped_system(backing: MappedSystemBacking) -> System {
    System::new_mapped(
        nop_modules(),
        Config {
            ipl_lle: true,
            ipl: None,
            sideload: None,
            perform_efb_copies: false,
            uart_escape: false,
        },
        backing,
    )
}

/// Complete synchronous machine-policy nucleus owned by the unified browser core.
///
/// The dynamic native scheduler still lives inside [`System`] while devices are ported. The fixed
/// deadline state is co-owned here now so the cutover cannot accidentally leave browser timing,
/// translation identity, or cold-code ownership in JavaScript.
#[repr(C, align(16))]
struct ResidentContext {
    control: ResidentControl,
    reserved_and_scratch: [u8; RESIDENT_CONTEXT_BYTES - core::mem::size_of::<ResidentControl>()],
}

impl Default for ResidentContext {
    fn default() -> Self {
        Self {
            control: ResidentControl::default(),
            reserved_and_scratch: [0; RESIDENT_CONTEXT_BYTES
                - core::mem::size_of::<ResidentControl>()],
        }
    }
}

/// A progress allocation stays owned here until each ordered event has either been applied to
/// PE or moved into the independently bounded renderer. `IntoIter` retains the original Vec
/// allocation, so the charge represented by `identity` remains exact while renderer pressure
/// pauses at a non-cloneable terminal.
#[derive(Debug)]
struct PendingGxProgress {
    identity: Option<GxProgressIdentity>,
    status: DecodeStatus,
    events: std::vec::IntoIter<GxRuntimeEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EfbLoadIdentity {
    effective: u32,
    physical: u32,
    observed_cycle: u64,
    alpha_read_mode: u8,
}

impl EfbLoadIdentity {
    #[cfg(any(target_arch = "wasm32", test))]
    const fn matches(self, effective: u32, observed_cycle: u64) -> bool {
        self.effective == effective && self.observed_cycle == observed_cycle
    }
}

/// One translated guest word load remains Rust-owned while earlier renderer work drains or an
/// authenticated EFB receipt is outstanding. Neither retry phase performs another translation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
enum EfbLoadContinuation {
    Ordering {
        identity: EfbLoadIdentity,
    },
    AwaitingReceipt {
        identity: EfbLoadIdentity,
        terminal_sequence: u64,
    },
    Ready {
        identity: EfbLoadIdentity,
        terminal_sequence: u64,
        retry_pc: Address,
        value: u32,
    },
}

impl EfbLoadContinuation {
    #[cfg(any(target_arch = "wasm32", test))]
    const fn identity(self) -> EfbLoadIdentity {
        match self {
            Self::Ordering { identity }
            | Self::AwaitingReceipt { identity, .. }
            | Self::Ready { identity, .. } => identity,
        }
    }
}

#[cfg(any(target_arch = "wasm32", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResidentI32Read {
    Memory {
        result: MemoryHookResult,
        value: i32,
    },
    Complete(i32),
    Yield,
    MachineExit,
}

impl PendingGxProgress {
    fn from_progress(progress: gx_runtime::GxRuntimeProgress) -> Self {
        let (identity, status, events) = progress.into_parts();
        Self {
            identity,
            status,
            events: events.into_iter(),
        }
    }
}

struct ResidentMem1<'memory> {
    bytes: &'memory mut [u8],
}

impl GxMemory for ResidentMem1<'_> {
    fn read_exact(&mut self, address: u32, destination: &mut [u8]) -> Result<(), GxMemoryError> {
        // GX display-list commands retain the CPU pointer supplied by GXCallDisplayList, while
        // array bases may already be physical. Accept exactly MEM1's physical, cached, and
        // uncached aliases before applying the bounded slice check below.
        let physical = if address < MAIN_RAM_BYTES as u32 {
            address
        } else if (0x8000_0000..0x8180_0000).contains(&address) {
            address - 0x8000_0000
        } else if (0xc000_0000..0xc180_0000).contains(&address) {
            address - 0xc000_0000
        } else {
            return Err(GxMemoryError::Unmapped);
        };
        let start = usize::try_from(physical).map_err(|_| GxMemoryError::OutOfBounds)?;
        let end = start
            .checked_add(destination.len())
            .ok_or(GxMemoryError::OutOfBounds)?;
        let source = self.bytes.get(start..end).ok_or(GxMemoryError::Unmapped)?;
        destination.copy_from_slice(source);
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserRenderCompletion {
    Committed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserRenderError {
    Completion(RenderCompletionError),
    MachineRejected,
}

/// Stable result vocabulary for the integer-only controller publication ABI.
///
/// Rejection deliberately does not expose SI queue policy. In particular, a full queue rejects
/// without advancing the accepted sequence, so the adapter may retry the same publication after
/// Rust services input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum BrowserInputPublication {
    Rejected   = 0,
    Queued     = 1,
    Coalesced  = 2,
    Equivalent = 3,
}

const CAPTURE_AUTHORITY_MAGIC: u32 = u32::from_be_bytes(*b"LZCA");

/// Atomic, Rust-authenticated scheduler/SI snapshot for browser capture policy.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
struct CaptureAuthorityV2 {
    magic: u32,
    version: u32,
    bytes: u32,
    canonical_cycle_lo: u32,
    canonical_cycle_hi: u32,
    executed_cycles_lo: u32,
    executed_cycles_hi: u32,
    executed_instructions_lo: u32,
    executed_instructions_hi: u32,
    retired_blocks_lo: u32,
    retired_blocks_hi: u32,
    si_poll_index_lo: u32,
    si_poll_index_hi: u32,
    si_scheduled_cycle_lo: u32,
    si_scheduled_cycle_hi: u32,
    si_observed_cycle_lo: u32,
    si_observed_cycle_hi: u32,
    si_applied_sequence_lo: u32,
    si_applied_sequence_hi: u32,
    si_packet_word_0: u32,
    si_packet_word_1: u32,
    si_source: u32,
    si_controller_mode: u32,
    si_buttons: u32,
    si_stick_xy_cxy: u32,
    si_trigger_lrab: u32,
    reserved: u32,
}

const _: [(); 108] = [(); core::mem::size_of::<CaptureAuthorityV2>()];

const fn split_u64(value: u64) -> [u32; 2] {
    [value as u32, (value >> 32) as u32]
}

pub struct BrowserMachine {
    resident_context: ResidentContext,
    system: System,
    disc_boot: BrowserDiscBootState,
    di_runtime: BrowserDiRuntime,
    gx_runtime: ResidentGxRuntime,
    pending_gx_progress: Option<PendingGxProgress>,
    pending_efb_load: Option<EfbLoadContinuation>,
    pending_pe_effects: VecDeque<PeBpEffect>,
    render_runtime: RenderRuntime,
    vi_render: ViRenderAdapter,
    pending_vi_work: Option<lazuli::system::vi::ScanoutWork>,
    runtime_hooks: MachineRuntimeHooks,
    #[cfg(any(target_arch = "wasm32", test))]
    cold_block_compiler: RustColdBlockCompiler,
    cold_compile: ColdCompileCoordinator,
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    run_coordinator: CoreRunCoordinator,
    #[cfg(any(target_arch = "wasm32", test))]
    resident_idle_witness: Option<ResidentIdleWitness>,
    #[cfg(any(target_arch = "wasm32", test))]
    pending_installable: Option<InstallableColdBlock>,
    #[cfg(target_arch = "wasm32")]
    host_compile_request: Option<lazuli_abi::CompileRequest>,
    #[cfg(target_arch = "wasm32")]
    last_compile_status: u32,
    event_deadlines: MachineEventDeadlines,
    #[cfg(any(target_arch = "wasm32", test))]
    render_wait_outcome: RunOutcome,
    #[cfg(any(target_arch = "wasm32", test))]
    host_render_request: Option<HostRequest>,
    #[cfg(any(target_arch = "wasm32", test))]
    disc_boot_wait_outcome: RunOutcome,
    machine_evidence: MachineEvidenceIntegration,
    capture_authority_snapshot: CaptureAuthorityV2,
    /// SI evidence completed at an observed MMIO instruction cycle but not yet covered by the
    /// authenticated dispatcher report. `si::service_due` drains all work due at that cycle, so
    /// later hooks in the same instruction may only contribute evidence-empty summaries.
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    pending_resident_si_summary: Option<si::SerialServiceSummary>,
    #[cfg(feature = "game-fidelity-probes")]
    game_fidelity: GameFidelityIntegration,
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    machine_evidence_outer_active: bool,
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    machine_exit: Option<RunOutcome>,
}

#[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResidentEventService {
    Complete,
    Deferred,
    MachineExit,
}

/// Collision-free Rust-owned stability witness for one exact installed semantic-idle block.
#[cfg(any(target_arch = "wasm32", test))]
#[derive(Debug, Clone)]
struct ResidentIdleWitness {
    identity: core_run::IdleProbeIdentity,
    cpu: lazuli::gekko::Cpu,
    stable_transitions: u8,
}

#[cfg(any(target_arch = "wasm32", test))]
fn resident_idle_cpu_stable(left: &lazuli::gekko::Cpu, right: &lazuli::gekko::Cpu) -> bool {
    left.pc == right.pc
        && left.user.gpr == right.user.gpr
        && left.user.fpr.iter().zip(&right.user.fpr).all(|(a, b)| {
            a.0.iter()
                .zip(b.0.iter())
                .all(|(a, b)| a.to_bits() == b.to_bits())
        })
        && left.user.cr == right.user.cr
        && left.user.fpscr == right.user.fpscr
        && left.user.xer == right.user.xer
        && left.user.lr == right.user.lr
        && left.user.ctr == right.user.ctr
        && left.supervisor == right.supervisor
        && left.reservation == right.reservation
}

/// Completes one resident `isync` boundary without discarding compiled blocks.
///
/// The translated block terminates synchronously at `isync`, and the resident `Always` boundary
/// forces a dispatcher hook exit before another block lookup. The resident machine has no separate
/// instruction-fetch cache to flush, and compiled blocks retain exact instruction-page
/// dependencies that are validated by the dispatcher before execution. Explicit `icbi` and disc
/// boot executable handoff paths continue to own their respective invalidation scopes.
#[cfg(any(target_arch = "wasm32", test))]
const fn synchronize_resident_instruction_stream() -> HookResult {
    HookResult::COMPLETE
}

/// Stable machine-owned fault details returned without browser policy intervention.
#[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
enum ResidentMachineExitDetail {
    DspFatalStop         = 8,
    DspServiceError      = 9,
    HookObservationRejected = 10,
    SchedulerAdvanceRejected = 11,
    HookScheduleRejected = 12,
    VideoServiceError    = 13,
    SerialServiceError   = 14,
    DiskServiceError     = 15,
    DiskAdapterError     = 16,
    GxRuntimeError       = 17,
    RenderRuntimeError   = 18,
    PixelEngineError     = 19,
    ViRenderError        = 20,
    IdleAdvanceRejected  = 21,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthenticatedRenderCommit {
    Other,
    TextureCopy,
    Xfb(CompletedXfb),
    Vi {
        render_sequence: u64,
        presentation: RenderPresentation,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthenticatedRenderCompletion {
    None,
    AuthenticatedOnly,
    HostFailure,
    RendererFailure,
    Commit(AuthenticatedRenderCommit),
}

fn machine_di_lifecycle_state(state: ResidentDiLifecycleState) -> MachineDiLifecycleState {
    match state {
        ResidentDiLifecycleState::Idle => MachineDiLifecycleState::Idle,
        ResidentDiLifecycleState::StartPending => MachineDiLifecycleState::StartPending,
        ResidentDiLifecycleState::AwaitingDeadline => MachineDiLifecycleState::AwaitingDeadline,
        ResidentDiLifecycleState::AwaitingHost => MachineDiLifecycleState::AwaitingHost,
        ResidentDiLifecycleState::ReadReady => MachineDiLifecycleState::ReadReady,
    }
}

fn machine_di_command_kind(kind: Option<ResidentCommandKind>) -> MachineDiCommandKind {
    match kind {
        None => MachineDiCommandKind::None,
        Some(ResidentCommandKind::Inquiry) => MachineDiCommandKind::Inquiry,
        Some(ResidentCommandKind::ReadSector) => MachineDiCommandKind::ReadSector,
        Some(ResidentCommandKind::ReadDiscId) => MachineDiCommandKind::ReadDiscId,
        Some(ResidentCommandKind::Seek) => MachineDiCommandKind::Seek,
        Some(ResidentCommandKind::RequestError) => MachineDiCommandKind::RequestError,
        Some(ResidentCommandKind::AudioStream) => MachineDiCommandKind::AudioStream,
        Some(ResidentCommandKind::AudioStatus) => MachineDiCommandKind::AudioStatus,
        Some(ResidentCommandKind::StopMotor) => MachineDiCommandKind::StopMotor,
        Some(ResidentCommandKind::AudioConfig) => MachineDiCommandKind::AudioConfig,
        Some(ResidentCommandKind::Unsupported) => MachineDiCommandKind::Unsupported,
    }
}

/// BrowserMachine-owned mirrors for evidence values whose subsystem owners expose only deltas or
/// resettable lifetime totals. Every mutation is fed back through `MachineEvidence`'s fail-closed
/// acceptance API before a snapshot can be issued.
struct MachineEvidenceIntegration {
    accumulator: MachineEvidence,
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    snapshot: MachineEvidenceV1,
    scheduler: SchedulerCounters,
    device: DeviceCounters,
    graphics: GraphicsCounters,
    renderer: RenderCounters,
    si: SiCounters,
    last_si_publication: Option<AuthenticatedSiPublication>,
    last_decoder_stats: DecoderStats,
    last_gx_stats: GxRuntimeStats,
    healthy: bool,
}

impl MachineEvidenceIntegration {
    fn try_new(canonical_cycle: u64, pc: u32, address_space_generation: u64) -> Option<Self> {
        let accumulator = MachineEvidence::try_new(MACHINE_EVIDENCE_EPOCH).ok()?;
        let mut integration = Self {
            accumulator,
            snapshot: MachineEvidenceV1::new(MACHINE_EVIDENCE_EPOCH, 1),
            scheduler: SchedulerCounters {
                canonical_cycle,
                address_space_generation,
                pc,
                ..SchedulerCounters::default()
            },
            device: DeviceCounters {
                dsp_lle_valid: true,
                ..DeviceCounters::default()
            },
            graphics: GraphicsCounters::default(),
            renderer: RenderCounters::default(),
            si: SiCounters::default(),
            last_si_publication: None,
            last_decoder_stats: DecoderStats::default(),
            last_gx_stats: GxRuntimeStats::default(),
            healthy: true,
        };
        integration.accept_scheduler();
        integration.accept_device();
        integration.healthy.then_some(integration)
    }

    fn retain_acceptance<T>(&mut self, result: Result<T, machine_evidence::MachineEvidenceFault>) {
        if result.is_err() {
            self.healthy = false;
        }
    }

    fn fail_closed(&mut self) {
        self.healthy = false;
    }

    fn is_healthy(&self) -> bool {
        self.healthy && self.accumulator.fault().is_none()
    }

    fn scheduler_authority(&self) -> SchedulerCounters {
        self.accumulator.scheduler_authority()
    }

    fn si_authority(&self) -> lazuli_abi::MachineSiEvidenceV1 {
        self.accumulator.si_authority()
    }

    fn si_publication_authority(&self) -> Option<AuthenticatedSiPublication> {
        self.is_healthy()
            .then_some(self.last_si_publication)
            .flatten()
    }

    fn accept_boot(&mut self, state: AuthenticatedBootState) {
        let result = self.accumulator.accept_boot_state(state);
        self.retain_acceptance(result);
    }

    fn accept_scheduler(&mut self) {
        let result = self.accumulator.accept_scheduler_commit(self.scheduler);
        self.retain_acceptance(result);
    }

    fn accept_device(&mut self) {
        let result = self.accumulator.accept_device_counters(self.device);
        self.retain_acceptance(result);
    }

    fn accept_di(
        &mut self,
        resident: Option<ResidentDiLifecycleEvidence>,
        browser: Option<BrowserDiLifecycleEvidence>,
    ) {
        let (Some(resident), Some(browser)) = (resident, browser) else {
            self.fail_closed();
            return;
        };
        let counters = DiCounters {
            command_starts: resident.command_starts,
            command_completions: resident.command_completions,
            command_cancellations: resident.command_cancellations,
            command_start_rejections: resident.command_start_rejections,
            inquiry_starts: resident.inquiry_starts,
            inquiry_completions: resident.inquiry_completions,
            inquiry_cancellations: resident.inquiry_cancellations,
            inquiry_start_rejections: resident.inquiry_start_rejections,
            read_starts: resident.read_starts,
            read_sector_starts: resident.read_sector_starts,
            read_disc_id_starts: resident.read_disc_id_starts,
            read_completions: resident.read_completions,
            read_cancellations: resident.read_cancellations,
            read_start_rejections: resident.read_start_rejections,
            read_device_failures: resident.read_device_failures,
            physical_host_requests_issued: browser.physical_host_requests_issued,
            physical_host_requests_cancelled: browser.physical_host_requests_cancelled,
            host_receipts_succeeded: browser.host_receipts_succeeded,
            host_receipts_failed: browser.host_receipts_failed,
            host_receipts_rejected: browser.host_receipts_rejected,
            logical_windows_ready: browser.logical_windows_ready,
            logical_windows_failed: browser.logical_windows_failed,
            current_state: machine_di_lifecycle_state(resident.current_state),
            current_kind: machine_di_command_kind(resident.current_kind),
            physical_host_request_pending: browser.physical_host_request_pending,
        };
        let result = self.accumulator.accept_di_counters(counters);
        self.retain_acceptance(result);
    }

    fn accept_graphics(&mut self) {
        let result = self.accumulator.accept_graphics_counters(self.graphics);
        self.retain_acceptance(result);
    }

    fn accept_renderer(&mut self) {
        let result = self.accumulator.accept_renderer_counters(self.renderer);
        self.retain_acceptance(result);
    }

    fn accept_si(&mut self) {
        let result = self.accumulator.accept_si_counters(self.si);
        self.retain_acceptance(result);
        self.si.publication = None;
    }

    fn add(total: u64, delta: u64) -> Option<u64> {
        total.checked_add(delta)
    }

    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn commit_dispatch(
        &mut self,
        canonical_cycle: u64,
        pc: u32,
        address_space_generation: u64,
        report: core_run::DispatchReport,
    ) {
        let Some(executed_cycles) = Self::add(self.scheduler.executed_cycles, report.cycles) else {
            self.fail_closed();
            return;
        };
        let Some(executed_instructions) =
            Self::add(self.scheduler.executed_instructions, report.instructions)
        else {
            self.fail_closed();
            return;
        };
        let Some(retired_blocks) =
            Self::add(self.scheduler.retired_blocks, u64::from(report.blocks))
        else {
            self.fail_closed();
            return;
        };
        self.scheduler.canonical_cycle = canonical_cycle;
        self.scheduler.executed_cycles = executed_cycles;
        self.scheduler.executed_instructions = executed_instructions;
        self.scheduler.address_space_generation = address_space_generation;
        self.scheduler.retired_blocks = retired_blocks;
        self.scheduler.pc = pc;
        self.accept_scheduler();
    }

    /// Commits a Rust-authenticated semantic-idle jump without inventing CPU work.
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn commit_idle_cycles(
        &mut self,
        canonical_cycle: u64,
        pc: u32,
        address_space_generation: u64,
        cycles: u64,
    ) -> bool {
        let Some(expected_cycle) = self.scheduler.canonical_cycle.checked_add(cycles) else {
            self.fail_closed();
            return false;
        };
        let Some(executed_cycles) = self.scheduler.executed_cycles.checked_add(cycles) else {
            self.fail_closed();
            return false;
        };
        let Some(semantic_idle_cycles) = self.scheduler.semantic_idle_cycles.checked_add(cycles)
        else {
            self.fail_closed();
            return false;
        };
        let Some(semantic_idle_jumps) = self
            .scheduler
            .semantic_idle_jumps
            .checked_add(1)
            .filter(|jumps| u32::try_from(*jumps).is_ok())
        else {
            self.fail_closed();
            return false;
        };
        if cycles == 0 || expected_cycle != canonical_cycle {
            self.fail_closed();
            return false;
        }
        self.scheduler.canonical_cycle = canonical_cycle;
        self.scheduler.executed_cycles = executed_cycles;
        self.scheduler.semantic_idle_cycles = semantic_idle_cycles;
        self.scheduler.semantic_idle_jumps = semantic_idle_jumps;
        self.scheduler.address_space_generation = address_space_generation;
        self.scheduler.pc = pc;
        self.accept_scheduler();
        self.is_healthy()
    }

    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn complete_outer_slice(
        &mut self,
        canonical_cycle: u64,
        pc: u32,
        address_space_generation: u64,
        fault: Option<MachineFault>,
    ) {
        let Some(completed) = self.scheduler.completed_outer_slices.checked_add(1) else {
            self.fail_closed();
            return;
        };
        self.scheduler.canonical_cycle = canonical_cycle;
        self.scheduler.address_space_generation = address_space_generation;
        self.scheduler.completed_outer_slices = completed;
        self.scheduler.pc = pc;
        if fault.is_some() {
            self.scheduler.machine_fault = fault;
        }
        self.accept_scheduler();
    }

    fn refresh_scheduler_identity(
        &mut self,
        canonical_cycle: u64,
        pc: u32,
        address_space_generation: u64,
        fault: Option<MachineFault>,
    ) {
        self.scheduler.canonical_cycle = canonical_cycle;
        self.scheduler.address_space_generation = address_space_generation;
        self.scheduler.pc = pc;
        if fault.is_some() {
            self.scheduler.machine_fault = fault;
        }
        self.accept_scheduler();
    }

    fn record_raw_disk_receipt(&mut self, request_failed: bool) {
        let Some(raw_disk_reads) = self.device.raw_disk_reads.checked_add(1) else {
            self.fail_closed();
            return;
        };
        self.device.raw_disk_reads = raw_disk_reads;
        if request_failed {
            let Some(errors) = self.device.disk_request_errors.checked_add(1) else {
                self.fail_closed();
                return;
            };
            self.device.disk_request_errors = errors;
        }
        self.accept_device();
    }

    fn record_controller_queue_overflow(&mut self) {
        let Some(overflows) = self.device.controller_queue_overflows.checked_add(1) else {
            self.fail_closed();
            return;
        };
        self.device.controller_queue_overflows = overflows;
        self.accept_device();
    }

    fn record_vi_fields(&mut self, fields: u64) {
        let Some(total) = self.device.vi_fields.checked_add(fields) else {
            self.fail_closed();
            return;
        };
        self.device.vi_fields = total;
        self.accept_device();
    }

    fn set_dsp_lle_steps(&mut self, steps: u64) {
        self.device.dsp_lle_steps = steps;
        self.accept_device();
    }

    fn invalidate_dsp_lle(&mut self) {
        self.device.dsp_lle_valid = false;
        self.accept_device();
    }

    fn record_di_completion(&mut self, successful: bool, error_code: u32) {
        self.device.di_last_error = error_code;
        if !successful {
            let Some(errors) = self.device.disk_device_errors.checked_add(1) else {
                self.fail_closed();
                return;
            };
            self.device.disk_device_errors = errors;
        }
        self.accept_device();
    }

    fn sync_graphics(
        &mut self,
        decoder: DecoderStats,
        runtime: GxRuntimeStats,
        pending_bytes: usize,
        decoder_carry_bytes: usize,
    ) {
        let deltas = (
            decoder
                .appended_bytes
                .checked_sub(self.last_decoder_stats.appended_bytes),
            runtime.batches.checked_sub(self.last_gx_stats.batches),
            decoder
                .decoded_commands
                .checked_sub(self.last_decoder_stats.decoded_commands),
            decoder
                .primitives
                .checked_sub(self.last_decoder_stats.primitives),
            decoder
                .unsupported_opcodes
                .checked_sub(self.last_decoder_stats.unsupported_opcodes),
        );
        let (Some(bytes), Some(drains), Some(commands), Some(primitives), Some(unsupported)) =
            deltas
        else {
            self.fail_closed();
            return;
        };
        let Some(gx_bytes) = Self::add(self.graphics.gx_bytes, bytes) else {
            self.fail_closed();
            return;
        };
        let Some(gx_drains) = Self::add(self.graphics.gx_drains, drains) else {
            self.fail_closed();
            return;
        };
        let Some(gx_commands) = Self::add(self.graphics.gx_commands, commands) else {
            self.fail_closed();
            return;
        };
        let Some(gx_primitives) = Self::add(self.graphics.gx_primitives, primitives) else {
            self.fail_closed();
            return;
        };
        let Some(unsupported_records) = Self::add(self.graphics.unsupported_records, unsupported)
        else {
            self.fail_closed();
            return;
        };
        let (Ok(pending_bytes), Ok(decoder_carry_bytes)) = (
            u64::try_from(pending_bytes),
            u64::try_from(decoder_carry_bytes),
        ) else {
            self.fail_closed();
            return;
        };
        self.graphics.gx_bytes = gx_bytes;
        self.graphics.gx_drains = gx_drains;
        self.graphics.gx_commands = gx_commands;
        self.graphics.gx_primitives = gx_primitives;
        self.graphics.unsupported_records = unsupported_records;
        self.graphics.pending_bytes = pending_bytes;
        self.graphics.decoder_carry_bytes = decoder_carry_bytes;
        self.last_decoder_stats = decoder;
        self.last_gx_stats = runtime;
        self.accept_graphics();
    }

    fn accept_gx_reset(&mut self) {
        self.last_decoder_stats = DecoderStats::default();
        self.last_gx_stats = GxRuntimeStats::default();
        self.graphics.pending_bytes = 0;
        self.graphics.decoder_carry_bytes = 0;
        self.accept_graphics();
    }

    fn record_xfb_copy(&mut self, completion: AuthenticatedXfbCompletion) {
        let Some(total) = self.graphics.xfb_copies.checked_add(1) else {
            self.fail_closed();
            return;
        };
        self.graphics.xfb_copies = total;
        self.accept_graphics();
        let result = self.accumulator.accept_authenticated_xfb(completion);
        self.retain_acceptance(result);
    }

    fn record_presented_frame(&mut self) {
        let Some(total) = self.graphics.presented_frames.checked_add(1) else {
            self.fail_closed();
            return;
        };
        self.graphics.presented_frames = total;
        self.accept_graphics();
    }

    fn record_render_issue(&mut self, pending: usize, texture_copy_barrier: bool) {
        let Some(issued) = self.renderer.render_requests_issued.checked_add(1) else {
            self.fail_closed();
            return;
        };
        let Ok(pending) = u32::try_from(pending) else {
            self.fail_closed();
            return;
        };
        self.renderer.render_requests_issued = issued;
        self.renderer.render_pending = pending;
        self.renderer.render_high_water = self.renderer.render_high_water.max(pending);
        if texture_copy_barrier {
            let Some(entered) = self.renderer.texture_copy_barriers_entered.checked_add(1) else {
                self.fail_closed();
                return;
            };
            self.renderer.texture_copy_barriers_entered = entered;
        }
        self.accept_renderer();
    }

    fn record_render_completion(
        &mut self,
        pending: usize,
        completion: AuthenticatedRenderCompletion,
    ) {
        if completion == AuthenticatedRenderCompletion::None {
            return;
        }
        let Some(completed) = self
            .renderer
            .render_completions_authenticated
            .checked_add(1)
        else {
            self.fail_closed();
            return;
        };
        let Ok(pending) = u32::try_from(pending) else {
            self.fail_closed();
            return;
        };
        self.renderer.render_completions_authenticated = completed;
        self.renderer.render_pending = pending;
        match completion {
            AuthenticatedRenderCompletion::HostFailure => {
                let Some(failures) = self.renderer.render_host_failures.checked_add(1) else {
                    self.fail_closed();
                    return;
                };
                self.renderer.render_host_failures = failures;
            }
            AuthenticatedRenderCompletion::RendererFailure => {
                let Some(failures) = self.renderer.render_renderer_failures.checked_add(1) else {
                    self.fail_closed();
                    return;
                };
                self.renderer.render_renderer_failures = failures;
            }
            AuthenticatedRenderCompletion::AuthenticatedOnly => {}
            AuthenticatedRenderCompletion::Commit(AuthenticatedRenderCommit::TextureCopy) => {
                let Some(exited) = self.renderer.texture_copy_barriers_exited.checked_add(1) else {
                    self.fail_closed();
                    return;
                };
                self.renderer.texture_copy_barriers_exited = exited;
            }
            AuthenticatedRenderCompletion::None
            | AuthenticatedRenderCompletion::Commit(
                AuthenticatedRenderCommit::Other
                | AuthenticatedRenderCommit::Xfb(_)
                | AuthenticatedRenderCommit::Vi { .. },
            ) => {}
        }
        self.accept_renderer();
    }

    fn accept_vi_selection(&mut self, selection: AuthenticatedViSelection) {
        let result = self.accumulator.accept_vi_selection(selection);
        self.retain_acceptance(result);
    }

    fn accept_vi_completion(&mut self, completion: AuthenticatedViCompletion) {
        let result = self.accumulator.accept_vi_completion(completion);
        self.retain_acceptance(result);
    }

    fn refresh_si_gauges(&mut self, queue_depth: usize, last_received_sequence: u64) {
        let Ok(queue_depth) = u32::try_from(queue_depth) else {
            self.fail_closed();
            return;
        };
        self.si.queue_depth = queue_depth;
        self.si.last_received_sequence = last_received_sequence;
        self.accept_si();
    }

    fn record_si_backpressure(
        &mut self,
        backpressured: u64,
        queue_depth: usize,
        last_received_sequence: u64,
    ) {
        let Some(total) = self.si.backpressured_polls.checked_add(backpressured) else {
            self.fail_closed();
            return;
        };
        let Ok(queue_depth) = u32::try_from(queue_depth) else {
            self.fail_closed();
            return;
        };
        self.si.backpressured_polls = total;
        self.si.queue_depth = queue_depth;
        self.si.last_received_sequence = last_received_sequence;
        self.accept_si();
    }

    fn record_si_publication(
        &mut self,
        source: lazuli_abi::MachineSiPollSource,
        publication: si::ControllerPublication,
        queue_depth: usize,
        last_received_sequence: u64,
    ) {
        let counter = match source {
            lazuli_abi::MachineSiPollSource::Periodic => &mut self.si.periodic_polls,
            lazuli_abi::MachineSiPollSource::Direct => &mut self.si.direct_polls,
        };
        let Some(total) = counter.checked_add(1) else {
            self.fail_closed();
            return;
        };
        let Ok(queue_depth) = u32::try_from(queue_depth) else {
            self.fail_closed();
            return;
        };
        *counter = total;
        self.si.queue_depth = queue_depth;
        self.si.last_received_sequence = last_received_sequence;
        self.si.publication = Some(AuthenticatedSiPublication {
            source,
            poll_index: publication.poll_index,
            scheduled_cycle: publication.scheduled_cycle,
            observed_cycle: publication.observed_cycle,
            applied_sequence: publication.sequence,
            state: publication.state,
            mode: publication.mode,
            packet: publication.packet,
        });
        self.last_si_publication = self.si.publication;
        self.accept_si();
    }

    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn issue_snapshot(&mut self) -> Option<&MachineEvidenceV1> {
        if !self.healthy || self.accumulator.fault().is_some() {
            return None;
        }
        let Ok(snapshot) = self.accumulator.snapshot() else {
            self.healthy = false;
            return None;
        };
        self.snapshot = snapshot;
        Some(&self.snapshot)
    }

    #[cfg(feature = "game-fidelity-probes")]
    fn last_authenticated_xfb_vi(&self) -> Option<lazuli_abi::MachineXfbViEvidenceV1> {
        if self.is_healthy() {
            self.accumulator.last_authenticated_xfb_vi()
        } else {
            None
        }
    }
}

impl BrowserMachine {
    /// Wraps one complete System in browser-resident runtime policy.
    pub fn from_system(mut system: System) -> Option<Self> {
        // The resident GX and VI/SI loops are now the sole owners of their device phases. These
        // callbacks are installed by legacy paths and must never race the Rust FIFO,
        // presentation, or authenticated controller-publication pipelines.
        system.scheduler.cancel(lazuli::system::gx::cmd::process);
        system.scheduler.cancel(lazuli::system::gx::cmd::consume);
        system.scheduler.cancel(lazuli::system::vi::vertical_count);
        system.set_resident_pixel_engine_pi_delivery(true);
        let initial_cycle = system.scheduler.elapsed();
        let ai_playing = system.audio.control.playing();
        let ai_sample_rate = system.audio.control.effective_aux_sample_rate();
        system
            .disk
            .synchronize_resident_ai_state(ai_playing, ai_sample_rate, initial_cycle)
            .ok()?;
        // No browser-side DI owner exists before construction. Retire any diagnostic reset latch
        // inherited from a pre-resident System so the first device hook cannot mistake it for a
        // reset of the newly-created adapter.
        let _ = system.disk.take_resident_reset();
        let runtime_hooks = MachineRuntimeHooks::new(&system.cpu);
        let machine_evidence = MachineEvidenceIntegration::try_new(
            initial_cycle,
            system.cpu.pc.0,
            runtime_hooks.current_generation().0,
        )?;
        let table_slot_count = u32::try_from(DISPATCH_SLOT_CAPACITY).ok()?;
        let cold_compile = ColdCompileCoordinator::new(CODE_CACHE_SET_COUNT, 0, table_slot_count)?;
        let mut event_deadlines = MachineEventDeadlines::default();
        system
            .publish_resident_audio_deadlines(&mut event_deadlines)
            .ok()?;
        system
            .publish_resident_dsp_deadlines(&mut event_deadlines)
            .ok()?;
        system.disk.publish_resident_deadlines(&mut event_deadlines);
        system.publish_resident_pixel_engine_deadline(&mut event_deadlines);
        #[cfg(any(target_arch = "wasm32", test))]
        let disc_boot_wait_outcome = {
            let mut outcome = RunOutcome::new(RunReason::BudgetExhausted);
            outcome.detail = core_run::RunOutcomeDetail::DiscBootWait as u32;
            outcome
        };
        #[cfg(any(target_arch = "wasm32", test))]
        let render_wait_outcome = RunOutcome::new(RunReason::HostRequest);
        let mut machine = Self {
            resident_context: ResidentContext::default(),
            system,
            disc_boot: BrowserDiscBootState::default(),
            di_runtime: BrowserDiRuntime::default(),
            gx_runtime: ResidentGxRuntime::try_new(GxRuntimeLimits::default()).ok()?,
            pending_gx_progress: None,
            pending_efb_load: None,
            pending_pe_effects: VecDeque::new(),
            render_runtime: RenderRuntime::new(FIRST_RENDER_NONCE).ok()?,
            vi_render: ViRenderAdapter::new(),
            pending_vi_work: None,
            runtime_hooks,
            #[cfg(any(target_arch = "wasm32", test))]
            cold_block_compiler: RustColdBlockCompiler::new(),
            cold_compile,
            run_coordinator: CoreRunCoordinator::default(),
            #[cfg(any(target_arch = "wasm32", test))]
            resident_idle_witness: None,
            #[cfg(any(target_arch = "wasm32", test))]
            pending_installable: None,
            #[cfg(target_arch = "wasm32")]
            host_compile_request: None,
            #[cfg(target_arch = "wasm32")]
            last_compile_status: 0,
            event_deadlines,
            #[cfg(any(target_arch = "wasm32", test))]
            render_wait_outcome,
            #[cfg(any(target_arch = "wasm32", test))]
            host_render_request: None,
            #[cfg(any(target_arch = "wasm32", test))]
            disc_boot_wait_outcome,
            machine_evidence,
            capture_authority_snapshot: CaptureAuthorityV2::default(),
            pending_resident_si_summary: None,
            #[cfg(feature = "game-fidelity-probes")]
            game_fidelity: GameFidelityIntegration::default(),
            machine_evidence_outer_active: false,
            machine_exit: None,
        };
        machine.initialize_resident_vi_si_deadlines().ok()?;
        Some(machine)
    }

    pub fn system(&self) -> &System {
        &self.system
    }

    pub fn system_mut(&mut self) -> &mut System {
        &mut self.system
    }

    fn controller_input_sample(
        sequence_lo: u32,
        sequence_hi: u32,
        buttons: u32,
        stick_xy_cxy: u32,
        trigger_lrab: u32,
    ) -> Option<si::ControllerInputSample> {
        if buttons & !CONTROLLER_INPUT_BUTTON_MASK != 0 {
            return None;
        }
        let sequence = u64::from(sequence_lo) | (u64::from(sequence_hi) << 32);
        let sticks = stick_xy_cxy.to_le_bytes();
        let triggers = trigger_lrab.to_le_bytes();
        si::ControllerInputSample::new(
            sequence,
            si::ControllerInputState {
                buttons: buttons as u16,
                stick_x: sticks[0],
                stick_y: sticks[1],
                c_stick_x: sticks[2],
                c_stick_y: sticks[3],
                trigger_l: triggers[0],
                trigger_r: triggers[1],
                analog_a: triggers[2],
                analog_b: triggers[3],
            },
        )
        .ok()
    }

    /// Publishes one host-normalized controller sample into Rust-owned SI state.
    ///
    /// The two packed words use little-endian byte lanes in their namesake order:
    /// `stick_x, stick_y, c_stick_x, c_stick_y` and
    /// `trigger_l, trigger_r, analog_a, analog_b`. The host cannot publish PAD_USE_ORIGIN or any
    /// other reserved button bit; SI adds PAD_USE_ORIGIN only while constructing guest packets.
    pub fn publish_controller_input(
        &mut self,
        sequence_lo: u32,
        sequence_hi: u32,
        buttons: u32,
        stick_xy_cxy: u32,
        trigger_lrab: u32,
    ) -> BrowserInputPublication {
        let Some(sample) = Self::controller_input_sample(
            sequence_lo,
            sequence_hi,
            buttons,
            stick_xy_cxy,
            trigger_lrab,
        ) else {
            return BrowserInputPublication::Rejected;
        };
        match self.system.serial.publish_controller_input(sample) {
            Ok(receipt) => {
                let result = match receipt.disposition {
                    si::ControllerInputDisposition::Queued { .. } => {
                        BrowserInputPublication::Queued
                    }
                    si::ControllerInputDisposition::CoalescedQueued { .. } => {
                        BrowserInputPublication::Coalesced
                    }
                    si::ControllerInputDisposition::AppliedEquivalent { .. } => {
                        BrowserInputPublication::Equivalent
                    }
                };
                self.refresh_machine_evidence_si_gauges();
                result
            }
            Err(si::ControllerInputError::QueueFull { .. }) => {
                self.machine_evidence.record_controller_queue_overflow();
                BrowserInputPublication::Rejected
            }
            Err(
                si::ControllerInputError::ZeroSequence
                | si::ControllerInputError::NonMonotonicSequence { .. },
            ) => BrowserInputPublication::Rejected,
        }
    }

    /// Number of exact Rust-owned renderer requests awaiting host completion.
    pub fn pending_render_requests(&self) -> usize {
        self.render_runtime.pending_count()
    }

    /// Copies one opaque host request without exposing its private commit plan.
    pub fn render_request(&self, index: usize) -> Option<HostRequest> {
        self.render_runtime.request(index)
    }

    /// Reauthenticates a copied request and lends its packet only for synchronous transport.
    pub fn render_packet_bytes(
        &self,
        request: HostRequest,
    ) -> Result<&[u8], RenderCompletionError> {
        self.render_runtime.packet_bytes(request)
    }

    /// Reauthenticates a copied request after host suspension and reacquires its exact response.
    pub fn render_receipt_staging_mut(
        &mut self,
        request: HostRequest,
    ) -> Result<&mut [u8], RenderCompletionError> {
        self.render_runtime.receipt_staging_mut(request)
    }

    fn scatter_texture_copy(
        system: &mut System,
        terminal: lzgx_packet::TerminalState,
        materialization: TextureCopyMaterialization,
        bytes: &[u8],
    ) -> Option<TextureCopyReference> {
        let row_bytes = usize::try_from(materialization.row_bytes()).ok()?;
        let row_count = usize::try_from(materialization.row_count()).ok()?;
        let stride = usize::try_from(terminal.stride).ok()?;
        if row_bytes == 0 || row_count == 0 || stride < row_bytes {
            return None;
        }
        let expected_bytes = row_bytes.checked_mul(row_count)?;
        if bytes.len() != expected_bytes {
            return None;
        }
        let destination = usize::try_from(terminal.destination).ok()?;
        let extent = (row_count - 1)
            .checked_mul(stride)?
            .checked_add(row_bytes)?;
        let end = destination.checked_add(extent)?;
        if end > system.mem.ram().len() {
            return None;
        }
        let format = u8::try_from(materialization.base_format()).ok()?;
        let hash = materialized_texture_hash(bytes);

        // Every destination is proven before the first write. The scatter is therefore atomic
        // with respect to malformed/overflowing receipts, while each external row invalidates
        // only the reservation granules it really overwrites.
        for row in 0..row_count {
            let target = destination + row * stride;
            let source = row * row_bytes;
            system
                .cpu
                .reservation
                .invalidate_range(Address(u32::try_from(target).ok()?), row_bytes);
            system.mem.ram_mut()[target..target + row_bytes]
                .copy_from_slice(&bytes[source..source + row_bytes]);
        }

        Some(TextureCopyReference {
            destination: terminal.destination,
            generation: terminal.generation,
            width: terminal.output_width,
            height: terminal.output_height,
            format,
            stride: terminal.stride,
            row_bytes: materialization.row_bytes(),
            row_count: materialization.row_count(),
            materialized_hash: hash,
        })
    }

    /// Consumes one authenticated renderer completion and applies its private Rust commit plan.
    /// Known host/renderer failures are terminal because GX may already be stopped at a receipt
    /// barrier; malformed identities leave the pending request live in `RenderRuntime`.
    pub fn complete_render_request(
        &mut self,
        request: HostRequest,
        completion: HostCompletion,
    ) -> Result<BrowserRenderCompletion, BrowserRenderError> {
        let observed_cycle = self.system.scheduler.elapsed();
        let application = {
            let Self {
                render_runtime,
                system,
                gx_runtime,
                pending_gx_progress,
                pending_efb_load,
                vi_render,
                ..
            } = self;
            match render_runtime.complete(request, completion) {
                Err(error) => {
                    let consumed = matches!(
                        error,
                        RenderCompletionError::MalformedCompletionRecord
                            | RenderCompletionError::UnknownHostStatus(_)
                            | RenderCompletionError::InvalidFilledLength
                            | RenderCompletionError::PacketMutated
                            | RenderCompletionError::MalformedReceipt
                            | RenderCompletionError::WrongSequence
                            | RenderCompletionError::WrongKind
                            | RenderCompletionError::WrongGeneration
                            | RenderCompletionError::WrongReceiptPayload
                            | RenderCompletionError::WrongReceiptOptionals
                    );
                    let evidence = if !consumed {
                        AuthenticatedRenderCompletion::None
                    } else if matches!(
                        error,
                        RenderCompletionError::MalformedReceipt
                            | RenderCompletionError::WrongSequence
                            | RenderCompletionError::WrongKind
                            | RenderCompletionError::WrongGeneration
                            | RenderCompletionError::WrongReceiptPayload
                            | RenderCompletionError::WrongReceiptOptionals
                    ) {
                        AuthenticatedRenderCompletion::RendererFailure
                    } else {
                        AuthenticatedRenderCompletion::HostFailure
                    };
                    Err((BrowserRenderError::Completion(error), consumed, evidence))
                }
                Ok(completion) => match completion {
                    RenderCompletion::Failed { failure, .. } => Ok((
                        BrowserRenderCompletion::Failed,
                        match failure {
                            RenderFailure::Host(_) => AuthenticatedRenderCompletion::HostFailure,
                            RenderFailure::Renderer(_) => {
                                AuthenticatedRenderCompletion::RendererFailure
                            }
                        },
                    )),
                    RenderCompletion::Committed(committed) => {
                        let committed_result = (|| -> Result<_, (BrowserRenderError, bool)> {
                            let plan = committed
                                .plan()
                                .copied()
                                .ok_or((BrowserRenderError::MachineRejected, true))?;
                            let mut evidence_commit = AuthenticatedRenderCommit::Other;
                            match plan {
                                RenderCommitPlan::TextureCopy {
                                    terminal,
                                    materialization: Some(materialization),
                                } => {
                                    if pending_gx_progress.is_some() {
                                        return Err((BrowserRenderError::MachineRejected, true));
                                    }
                                    let bytes = committed
                                        .texture_copy_bytes()
                                        .ok_or((BrowserRenderError::MachineRejected, true))?;
                                    let reference = Self::scatter_texture_copy(
                                        system,
                                        terminal,
                                        materialization,
                                        bytes,
                                    )
                                    .ok_or((BrowserRenderError::MachineRejected, true))?;
                                    let progress = {
                                        let mut memory = ResidentMem1 {
                                            bytes: system.mem.ram_mut(),
                                        };
                                        gx_runtime.acknowledge_texture_copy(
                                            reference,
                                            bytes,
                                            &mut memory,
                                            observed_cycle,
                                        )
                                    }
                                    .map_err(|_| (BrowserRenderError::MachineRejected, true))?;
                                    *pending_gx_progress =
                                        Some(PendingGxProgress::from_progress(progress));
                                    evidence_commit = AuthenticatedRenderCommit::TextureCopy;
                                }
                                RenderCommitPlan::TextureCopy {
                                    terminal: _,
                                    materialization: None,
                                } => {
                                    if pending_gx_progress.is_some() {
                                        return Err((BrowserRenderError::MachineRejected, true));
                                    }
                                    let sequence = gx_runtime
                                        .pending_barrier()
                                        .map(|(sequence, _)| sequence)
                                        .ok_or((BrowserRenderError::MachineRejected, true))?;
                                    let progress = {
                                        let mut memory = ResidentMem1 {
                                            bytes: system.mem.ram_mut(),
                                        };
                                        gx_runtime.acknowledge_legacy_texture_copy(
                                            sequence,
                                            &mut memory,
                                            observed_cycle,
                                        )
                                    }
                                    .map_err(|_| (BrowserRenderError::MachineRejected, true))?;
                                    *pending_gx_progress =
                                        Some(PendingGxProgress::from_progress(progress));
                                    evidence_commit = AuthenticatedRenderCommit::TextureCopy;
                                }
                                RenderCommitPlan::XfbCopy { terminal } => {
                                    let registration = vi_render
                                        .record_authenticated_xfb_completion(terminal)
                                        .map_err(|_| (BrowserRenderError::MachineRejected, true))?;
                                    evidence_commit =
                                        AuthenticatedRenderCommit::Xfb(registration.recorded);
                                }
                                RenderCommitPlan::ViPresent { presentation: _ } => {
                                    let render_sequence = committed.sequence();
                                    let presentation = committed
                                        .presentation()
                                        .ok_or((BrowserRenderError::MachineRejected, true))?;
                                    evidence_commit = AuthenticatedRenderCommit::Vi {
                                        render_sequence,
                                        presentation,
                                    };
                                }
                                RenderCommitPlan::EfbPeek { terminal } => {
                                    if pending_gx_progress.is_some() {
                                        return Err((BrowserRenderError::MachineRejected, true));
                                    }
                                    let value = committed
                                        .efb_value()
                                        .ok_or((BrowserRenderError::MachineRejected, true))?;
                                    let Some(EfbLoadContinuation::AwaitingReceipt {
                                        identity,
                                        terminal_sequence,
                                    }) = *pending_efb_load
                                    else {
                                        return Err((BrowserRenderError::MachineRejected, true));
                                    };
                                    let Ok(EfbPeekAddress::Pixel { x, y, plane }) =
                                        classify_efb_peek_address(identity.physical)
                                    else {
                                        return Err((BrowserRenderError::MachineRejected, true));
                                    };
                                    if terminal.source_x != x
                                        || terminal.source_y != y
                                        || terminal.destination != plane
                                        || terminal.stride != u32::from(identity.alpha_read_mode)
                                    {
                                        return Err((BrowserRenderError::MachineRejected, true));
                                    }
                                    let retry_pc = system.cpu.pc;
                                    let progress = {
                                        let mut memory = ResidentMem1 {
                                            bytes: system.mem.ram_mut(),
                                        };
                                        gx_runtime.acknowledge_efb_peek(
                                            terminal_sequence,
                                            value,
                                            |commit| {
                                                if commit.sequence != terminal_sequence
                                                    || commit.combined_plane
                                                    || commit.alpha_read_mode
                                                        != identity.alpha_read_mode
                                                {
                                                    return Err(GxRuntimeError::InternalInvariant(
                                                        "EFB load continuation identity",
                                                    ));
                                                }
                                                *pending_efb_load =
                                                    Some(EfbLoadContinuation::Ready {
                                                        identity,
                                                        terminal_sequence,
                                                        retry_pc,
                                                        value: commit.value,
                                                    });
                                                Ok(())
                                            },
                                            &mut memory,
                                            observed_cycle,
                                        )
                                    }
                                    .map_err(|_| (BrowserRenderError::MachineRejected, true))?;
                                    *pending_gx_progress =
                                        Some(PendingGxProgress::from_progress(progress));
                                }
                            }
                            Ok(evidence_commit)
                        })();
                        match committed_result {
                            Ok(commit) => Ok((
                                BrowserRenderCompletion::Committed,
                                AuthenticatedRenderCompletion::Commit(commit),
                            )),
                            Err((error, consumed)) => Err((
                                error,
                                consumed,
                                AuthenticatedRenderCompletion::AuthenticatedOnly,
                            )),
                        }
                    }
                },
            }
        };
        match application {
            Ok((BrowserRenderCompletion::Committed, evidence)) => {
                self.record_machine_evidence_render_completion(observed_cycle, evidence);
                self.refresh_render_wait_request();
                Ok(BrowserRenderCompletion::Committed)
            }
            Ok((BrowserRenderCompletion::Failed, evidence)) => {
                self.record_machine_evidence_render_completion(observed_cycle, evidence);
                self.publish_machine_exit(ResidentMachineExitDetail::RenderRuntimeError);
                self.refresh_render_wait_request();
                Ok(BrowserRenderCompletion::Failed)
            }
            Err((error, consumed, evidence)) => {
                if consumed {
                    self.record_machine_evidence_render_completion(observed_cycle, evidence);
                    self.publish_machine_exit(ResidentMachineExitDetail::RenderRuntimeError);
                    self.refresh_render_wait_request();
                }
                Err(error)
            }
        }
    }

    fn record_machine_evidence_render_completion(
        &mut self,
        observed_cycle: u64,
        completion: AuthenticatedRenderCompletion,
    ) {
        self.machine_evidence
            .record_render_completion(self.render_runtime.pending_count(), completion);
        match completion {
            AuthenticatedRenderCompletion::Commit(AuthenticatedRenderCommit::Xfb(xfb)) => {
                self.machine_evidence
                    .record_xfb_copy(AuthenticatedXfbCompletion {
                        completion_cycle: observed_cycle,
                        generation: xfb.generation(),
                        width: xfb.output_width(),
                        height: xfb.output_height(),
                        stride: xfb.stride(),
                    });
            }
            AuthenticatedRenderCompletion::Commit(AuthenticatedRenderCommit::Vi {
                render_sequence,
                presentation,
            }) => {
                if presentation.status == lazuli_abi::RenderPresentationStatus::Presented {
                    self.machine_evidence.record_presented_frame();
                }
                self.machine_evidence
                    .accept_vi_completion(AuthenticatedViCompletion {
                        completion_cycle: observed_cycle,
                        render_sequence,
                        presentation_status: presentation.status,
                        presentation_epoch: presentation.epoch,
                        presentation_width: presentation.width,
                        presentation_height: presentation.height,
                        presentation_serial: presentation.serial,
                    });
                #[cfg(feature = "game-fidelity-probes")]
                self.accept_game_fidelity_vi_completion();
            }
            AuthenticatedRenderCompletion::None
            | AuthenticatedRenderCompletion::AuthenticatedOnly
            | AuthenticatedRenderCompletion::HostFailure
            | AuthenticatedRenderCompletion::RendererFailure
            | AuthenticatedRenderCompletion::Commit(
                AuthenticatedRenderCommit::Other | AuthenticatedRenderCommit::TextureCopy,
            ) => {}
        }
    }

    #[cfg(feature = "game-fidelity-probes")]
    fn accept_game_fidelity_vi_completion(&mut self) {
        if self.machine_exit.is_some() {
            self.game_fidelity.fail_machine_lifetime();
            return;
        }
        let Some(chronology) = self.machine_evidence.last_authenticated_xfb_vi() else {
            if !self.machine_evidence.is_healthy() {
                self.game_fidelity.fail_machine_lifetime();
            }
            return;
        };
        self.game_fidelity
            .accept_authenticated_vi(&mut self.system, chronology);
    }

    pub fn disc_boot(&self) -> &BrowserDiscBootState {
        &self.disc_boot
    }

    fn authenticated_boot_state(&self) -> AuthenticatedBootState {
        let status = match self.disc_boot.status() {
            BrowserDiscBootStatus::Idle => lazuli_abi::MachineBootStatus::Idle,
            BrowserDiscBootStatus::Planning => lazuli_abi::MachineBootStatus::Planning,
            BrowserDiscBootStatus::Loading => lazuli_abi::MachineBootStatus::Loading,
            BrowserDiscBootStatus::Committed => lazuli_abi::MachineBootStatus::Committed,
            BrowserDiscBootStatus::Failed => lazuli_abi::MachineBootStatus::Failed,
            BrowserDiscBootStatus::Cancelled => lazuli_abi::MachineBootStatus::Cancelled,
        };
        let fault = match self.disc_boot.fault_code() {
            BrowserDiscBootFaultCode::None => lazuli_abi::MachineBootFault::None,
            BrowserDiscBootFaultCode::EpochExhausted => {
                lazuli_abi::MachineBootFault::EpochExhausted
            }
            BrowserDiscBootFaultCode::Planning => lazuli_abi::MachineBootFault::Planning,
            BrowserDiscBootFaultCode::PlanningShortRead => {
                lazuli_abi::MachineBootFault::PlanningShortRead
            }
            BrowserDiscBootFaultCode::LoadStart => lazuli_abi::MachineBootFault::LoadStart,
            BrowserDiscBootFaultCode::Loading => lazuli_abi::MachineBootFault::Loading,
            BrowserDiscBootFaultCode::LoadingShortRead => {
                lazuli_abi::MachineBootFault::LoadingShortRead
            }
        };
        let identity = self
            .disc_boot
            .commit()
            .map(|commit| AuthenticatedBootIdentity {
                identifier: commit.identity.identifier,
                revision: commit.identity.version,
                disc_number: commit.identity.disc_id,
                format: match commit.format {
                    lazuli::disks::async_boot::DiscFormat::RawIso { .. } => {
                        lazuli_abi::MachineDiscFormat::RawIso
                    }
                    lazuli::disks::async_boot::DiscFormat::Ciso { .. } => {
                        lazuli_abi::MachineDiscFormat::Ciso
                    }
                },
                logical_bytes: commit.format.logical_bytes(),
            });
        AuthenticatedBootState {
            boot_epoch: self.disc_boot.current_epoch().unwrap_or(0),
            status,
            fault,
            identity,
        }
    }

    fn publish_authenticated_boot_state(&mut self) {
        let state = self.authenticated_boot_state();
        self.machine_evidence.accept_boot(state);
        #[cfg(feature = "game-fidelity-probes")]
        if self.machine_evidence.is_healthy() {
            self.game_fidelity.accept_authenticated_boot(state);
        } else {
            self.game_fidelity.fail_machine_lifetime();
        }
    }

    pub fn begin_disc_boot(&mut self, container_bytes: u64) -> Result<u64, BrowserDiscBootError> {
        if self.has_outstanding_core_work()
            || self.has_outstanding_di_work()
            || self.has_outstanding_graphics_work()
        {
            return Err(BrowserDiscBootError::MachineBusy);
        }
        let result = self.disc_boot.begin(container_bytes);
        self.publish_authenticated_boot_state();
        result
    }

    /// Disc planning/loading mutates MEM1 incrementally, so no PPC dispatch authority may coexist
    /// with a nonterminal boot epoch. A failed epoch remains sealed until explicit cancellation.
    #[cfg(any(target_arch = "wasm32", test))]
    fn disc_boot_blocks_cpu_dispatch(&self) -> bool {
        matches!(
            self.disc_boot.status(),
            BrowserDiscBootStatus::Planning
                | BrowserDiscBootStatus::Loading
                | BrowserDiscBootStatus::Failed
        )
    }

    fn has_outstanding_core_work(&self) -> bool {
        if !self.run_coordinator.is_quiescent() || self.cold_compile.has_pending_compile() {
            return true;
        }
        #[cfg(any(target_arch = "wasm32", test))]
        {
            self.pending_installable.is_some()
        }
        #[cfg(not(any(target_arch = "wasm32", test)))]
        {
            false
        }
    }

    fn has_outstanding_di_work(&self) -> bool {
        let deadlines = self.system.disk.resident_deadlines();
        deadlines.completion.is_some()
            || deadlines.audio.is_some()
            || self.di_runtime.active_logical_request().is_some()
    }

    fn has_outstanding_graphics_work(&self) -> bool {
        self.pending_gx_progress.is_some()
            || self.pending_efb_load.is_some()
            || !self.pending_pe_effects.is_empty()
            || self.gx_runtime.pending_barrier().is_some()
            || self.gx_runtime.decoder().buffered_bytes() != 0
            || self.gx_runtime.pending_bytes() != Ok(0)
            || self.render_runtime.pending_count() != 0
            || self.pending_vi_work.is_some()
            || self.vi_render.has_prepared_handoff()
            || self.system.gpu.cmd.resident_fifo_reset_pending()
            || !self.system.gpu.cmd.queue.is_empty()
            || self.system.gpu.cmd.fifo.distance != 0
            || pi::fifo_pending_bytes(&self.system) != 0
    }

    pub fn cancel_disc_boot(&mut self) -> bool {
        if self.has_outstanding_core_work() || self.has_outstanding_graphics_work() {
            return false;
        }
        if let Some(reader) = self.disc_boot.committed_disc_reader_mut() {
            self.di_runtime.cancel(reader);
        }
        let cancelled = self.disc_boot.cancel();
        if !cancelled {
            return false;
        }
        self.publish_authenticated_boot_state();
        self.di_runtime.abandon();
        let reset = self.system.disk.reset_resident();
        let ejected = reset
            .ok()
            .and_then(|()| self.system.disk.configure_resident_disc(None).ok());
        // The host lifecycle already retired both adapter and committed mapper above.
        let _ = self.system.disk.take_resident_reset();
        self.system
            .disk
            .publish_resident_deadlines(&mut self.event_deadlines);
        pi::check_interrupts_excluding_pixel_engine(&mut self.system);
        if ejected.is_none() {
            self.publish_machine_exit(ResidentMachineExitDetail::DiskAdapterError);
        }
        true
    }

    /// Retires every browser-side owner named by one coalesced resident DI reset notification.
    ///
    /// The reset latch is consumed only at the synchronous device-hook boundary. A mismatch
    /// between adapter and committed-mapper ownership is cleared defensively and reported as a
    /// sticky machine fault, so no later host descriptor can inherit ambiguous authority.
    #[cfg(any(target_arch = "wasm32", test))]
    fn consume_resident_di_reset(&mut self) -> bool {
        let Some(_generation) = self.system.disk.take_resident_reset() else {
            return true;
        };

        let adapter_active = self.di_runtime.active_logical_request().is_some();
        let Some(reader) = self.disc_boot.committed_disc_reader_mut() else {
            return !self.di_runtime.abandon();
        };
        let mapper_active = reader.active_identity().is_some();
        match (adapter_active, mapper_active) {
            (false, false) => true,
            (true, true) => {
                if self.di_runtime.cancel(reader) {
                    true
                } else {
                    if let Some(identity) = reader.active_identity() {
                        let _ = reader.cancel(identity);
                    }
                    false
                }
            }
            (true, false) => {
                self.di_runtime.abandon();
                false
            }
            (false, true) => {
                if let Some(identity) = reader.active_identity() {
                    let _ = reader.cancel(identity);
                }
                false
            }
        }
    }

    pub fn disc_boot_request(&self, index: usize) -> Option<ReadRequest> {
        self.disc_boot.request(index)
    }

    /// Reacquires one exact Rust-owned staging allocation after the browser's range fetch.
    pub fn disc_boot_staging_mut(
        &mut self,
        request: ReadRequest,
    ) -> Result<&mut [u8], BrowserDiscBootError> {
        self.disc_boot.staging_mut(request)
    }

    /// Completes a fetched range and publishes low memory plus the complete HLE CPU launch state
    /// only on terminal Rust commit.
    pub fn complete_disc_boot(
        &mut self,
        request: ReadRequest,
        written: u32,
    ) -> Result<BrowserDiscBootProgress, BrowserDiscBootError> {
        let authenticated_request = self.disc_boot.requests().any(|pending| pending == request);
        let result = self
            .disc_boot
            .complete(request, written, self.system.mem.ram_mut());
        if authenticated_request {
            self.machine_evidence
                .record_raw_disk_receipt(result.is_err());
        }
        let progress = match result {
            Ok(progress) => progress,
            Err(error) => {
                // Failed and nonterminal loader mutations are complete at this point, so their
                // lifecycle state is safe to publish. A terminal identity is handled below only
                // after every BrowserMachine owner has committed the handoff.
                if self.disc_boot.status() != BrowserDiscBootStatus::Committed {
                    self.publish_authenticated_boot_state();
                }
                return Err(error);
            }
        };
        if progress.commit.is_none() {
            self.publish_authenticated_boot_state();
            return Ok(progress);
        }
        if let Some(commit) = progress.commit.as_ref() {
            if let Err(error) = self.system.disk.configure_resident_boot_disc(
                commit.format.logical_bytes(),
                ResidentAudioBufferConfiguration {
                    enabled: commit.identity.audio_streaming != 0,
                    buffer_length: commit.identity.stream_buffer_size,
                },
            ) {
                self.publish_machine_exit(ResidentMachineExitDetail::DiskAdapterError);
                return Err(BrowserDiscBootError::DiscConfiguration(error));
            }
            self.system
                .disk
                .publish_resident_deadlines(&mut self.event_deadlines);
            let Some(previous_bytes) = self.system.mem.ram().get(..BOOT_LOW_MEMORY_BYTES) else {
                self.publish_machine_exit(ResidentMachineExitDetail::HookScheduleRejected);
                return Err(BrowserDiscBootError::MachineHandoff);
            };
            let mut previous = [0; BOOT_LOW_MEMORY_BYTES];
            previous.copy_from_slice(previous_bytes);
            let low_memory = committed_low_memory(&previous, commit);
            let Some(low_memory_target) =
                self.system.mem.ram_mut().get_mut(..BOOT_LOW_MEMORY_BYTES)
            else {
                self.publish_machine_exit(ResidentMachineExitDetail::HookScheduleRejected);
                return Err(BrowserDiscBootError::MachineHandoff);
            };
            low_memory_target.copy_from_slice(&low_memory);
            self.system.launch_hle_executable(Address(commit.entry));

            // The async loader writes executable bytes directly into physical MEM1. Retire every
            // resident block even when a later boot happens to reuse the same BAT/MSR signature,
            // then publish the newly authored launch address space before any cold fetch.
            let cache_outcome =
                self.apply_hook_result(MachineRuntimeHooks::clear_instruction_cache());
            let synchronized = self.runtime_hooks.synchronize_address_space(&self.system);
            let synchronization_outcome = self.apply_hook_result(synchronized);
            let scheduler_refreshed = self.refresh_machine_evidence_scheduler(None);
            if matches!(cache_outcome, HookOutcome::Fault | HookOutcome::Yield)
                || matches!(
                    synchronization_outcome,
                    HookOutcome::Fault | HookOutcome::Yield
                )
                || !scheduler_refreshed
            {
                self.publish_machine_exit(ResidentMachineExitDetail::HookScheduleRejected);
                return Err(BrowserDiscBootError::MachineHandoff);
            }
        }
        // `disc_boot.complete` authors the immutable identity before BrowserMachine installs the
        // remaining owners. Publishing here is the terminal machine commit: DI configuration,
        // low memory, HLE launch, cache retirement, and address-space synchronization all hold.
        self.publish_authenticated_boot_state();
        Ok(progress)
    }

    /// Prepares at most one pointer-free physical container request for the current resident DI
    /// logical window. Fully sparse CISO windows complete locally inside Rust.
    pub fn di_read_request(&mut self) -> Result<Option<ReadRequest>, BrowserDiError> {
        if self.system.disk.resident_read_request().is_none() {
            return Ok(None);
        }
        let Self {
            system,
            disc_boot,
            di_runtime,
            ..
        } = self;
        let reader = disc_boot
            .committed_disc_reader_mut()
            .ok_or(BrowserDiError::NoCommittedDisc)?;
        di_runtime.prepare(&mut system.disk, reader)
    }

    /// Reacquires the exact sub-slice of DI's private payload after an async physical read.
    pub fn di_read_staging_mut(
        &mut self,
        request: ReadRequest,
    ) -> Result<&mut [u8], BrowserDiError> {
        let Self {
            system,
            disc_boot,
            di_runtime,
            ..
        } = self;
        let reader = disc_boot
            .committed_disc_reader_mut()
            .ok_or(BrowserDiError::NoCommittedDisc)?;
        di_runtime.staging_mut(&mut system.disk, reader, request)
    }

    /// Applies one exact physical host receipt without accepting any browser-authored pointer.
    pub fn complete_di_read(
        &mut self,
        request: ReadRequest,
        written: u32,
        status_raw: u32,
    ) -> Result<BrowserDiCallResult, BrowserDiError> {
        let authenticated_request = self
            .disc_boot
            .committed_disc_reader()
            .and_then(|reader| reader.request())
            == Some(request)
            && HostCompletionStatus::try_from(status_raw).is_ok();
        let result = {
            let Self {
                system,
                disc_boot,
                di_runtime,
                ..
            } = self;
            let reader = disc_boot
                .committed_disc_reader_mut()
                .ok_or(BrowserDiError::NoCommittedDisc)?;
            di_runtime.complete(&mut system.disk, reader, request, written, status_raw)
        };
        if authenticated_request {
            let failed = !matches!(
                result,
                Ok(BrowserDiCallResult::Accepted | BrowserDiCallResult::LogicalWindowReady)
            );
            self.machine_evidence.record_raw_disk_receipt(failed);
        }
        result
    }

    /// Diagnostic-only entry to prove a complete legal 24 MiB DI payload in the linked Wasm
    /// heap. Normal execution reaches this same start path through guest DI MMIO.
    #[cfg(feature = "di-contract-probes")]
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    fn begin_maximum_di_probe(&mut self) -> bool {
        use lazuli::system::mem::RAM_LEN;

        if self.disc_boot.status() != BrowserDiscBootStatus::Committed
            || self.system.disk.resident_read_request().is_some()
        {
            return false;
        }
        let observed_cycle = self.system.scheduler.elapsed();
        let disk = &mut self.system.disk;
        if disk.write_resident_command_word(0, 0xa800_0000).is_err()
            || disk.write_resident_command_word(1, 0).is_err()
            || disk.write_resident_command_word(2, RAM_LEN as u32).is_err()
            || disk.write_resident_dma_address(0).is_err()
            || disk.write_resident_dma_length(RAM_LEN as u32).is_err()
        {
            return false;
        }
        let started = disk
            .write_resident_control(
                3,
                observed_cycle,
                self.system.mem.ram_mut(),
                &mut self.system.cpu.reservation,
            )
            .ok()
            .flatten()
            .is_some();
        disk.publish_resident_deadlines(&mut self.event_deadlines);
        started
    }

    /// Diagnostic counterpart to [`Self::begin_maximum_di_probe`]. It services the exact Rust DI
    /// completion deadline directly so the heap contract does not need a synthetic PPC runner.
    #[cfg(feature = "di-contract-probes")]
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    fn finish_maximum_di_probe(&mut self) -> bool {
        use lazuli::system::di::ResidentServiceState;
        use lazuli::system::mem::RAM_LEN;

        let Some(completion_cycle) = self.system.disk.resident_deadlines().completion else {
            return false;
        };
        let summary = self.system.disk.service_resident(
            completion_cycle,
            self.system.mem.ram_mut(),
            &mut self.system.cpu.reservation,
        );
        self.system
            .disk
            .publish_resident_deadlines(&mut self.event_deadlines);
        pi::check_interrupts_excluding_pixel_engine(&mut self.system);
        matches!(
            summary.command,
            ResidentServiceState::Completed(completion)
                if completion.successful
                    && completion.memory_write_bytes == RAM_LEN as u32
                    && self.system.disk.dma_length == 0
                    && self.system.disk.dma_base == Address(RAM_LEN as u32)
        )
    }

    pub fn resident_control(&self) -> &ResidentControl {
        &self.resident_context.control
    }

    pub fn resident_control_mut(&mut self) -> &mut ResidentControl {
        &mut self.resident_context.control
    }

    pub fn current_generation(&self) -> Option<AddressSpaceGeneration> {
        Some(self.runtime_hooks.current_generation())
    }

    fn refresh_machine_evidence_scheduler(&mut self, fault: Option<MachineFault>) -> bool {
        self.machine_evidence.refresh_scheduler_identity(
            self.system.scheduler.elapsed(),
            self.system.cpu.pc.0,
            self.runtime_hooks.current_generation().0,
            fault,
        );
        self.machine_evidence.is_healthy()
    }

    #[cfg(any(target_arch = "wasm32", test))]
    fn record_machine_evidence_dispatch(&mut self, report: core_run::DispatchReport) {
        self.machine_evidence.commit_dispatch(
            self.system.scheduler.elapsed(),
            self.system.cpu.pc.0,
            self.runtime_hooks.current_generation().0,
            report,
        );
    }

    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn complete_machine_evidence_outer_slice(&mut self) {
        if !self.machine_evidence_outer_active {
            return;
        }
        // A hook-side SI summary is meaningful only if `core_finish_slice` authenticated and
        // committed the enclosing report. Never carry uncommitted device evidence into another
        // outer slice or silently discard it on an error path.
        if self.pending_resident_si_summary.take().is_some() {
            self.machine_evidence.fail_closed();
            self.publish_machine_exit(ResidentMachineExitDetail::HookObservationRejected);
        }
        self.machine_evidence_outer_active = false;
        let outcome = self
            .machine_exit
            .as_ref()
            .copied()
            .unwrap_or_else(|| *self.run_coordinator.outcome());
        let fault = outcome
            .reason()
            .ok()
            .filter(|reason| matches!(reason, RunReason::Fault | RunReason::InvalidState))
            .filter(|_| outcome.detail != 0)
            .map(|reason| MachineFault {
                reason,
                detail: outcome.detail,
            });
        self.machine_evidence.complete_outer_slice(
            self.system.scheduler.elapsed(),
            self.system.cpu.pc.0,
            self.runtime_hooks.current_generation().0,
            fault,
        );
    }

    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn machine_evidence_snapshot(&mut self) -> Option<&MachineEvidenceV1> {
        self.sync_machine_evidence_graphics();
        self.machine_evidence
            .set_dsp_lle_steps(self.system.dsp.lle.executed_instructions());
        self.refresh_machine_evidence_si_gauges();
        self.refresh_machine_evidence_scheduler(None);
        self.machine_evidence.accept_di(
            self.system.disk.resident_di_lifecycle_evidence(),
            self.di_runtime.lifecycle_evidence(),
        );
        self.machine_evidence.issue_snapshot()
    }

    /// Issue one atomic scheduler/SI authority record without exposing guest memory or devices.
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn capture_authority_snapshot(&mut self) -> Option<&CaptureAuthorityV2> {
        if !self.refresh_machine_evidence_scheduler(None) || !self.machine_evidence.is_healthy() {
            return None;
        }
        let scheduler = self.machine_evidence.scheduler_authority();
        let si = self.machine_evidence.si_authority();
        let canonical_cycle = split_u64(scheduler.canonical_cycle);
        let executed_cycles = split_u64(scheduler.executed_cycles);
        let executed_instructions = split_u64(scheduler.executed_instructions);
        let retired_blocks = split_u64(scheduler.retired_blocks);
        let si_poll_index = split_u64(si.poll_index.get());
        let si_scheduled_cycle = split_u64(si.scheduled_cycle.get());
        let si_observed_cycle = split_u64(si.observed_cycle.get());
        let si_applied_sequence = split_u64(si.applied_sequence.get());
        let publication = self.machine_evidence.si_publication_authority();
        if si.poll_index.get() != 0
            && publication.is_none_or(|publication| {
                publication.poll_index != si.poll_index.get()
                    || publication.applied_sequence != si.applied_sequence.get()
            })
        {
            return None;
        }
        let (controller_mode, buttons, stick_xy_cxy, trigger_lrab) =
            publication.map_or((0, 0, 0, 0), |publication| {
                let state = publication.state;
                (
                    u32::from(publication.mode),
                    u32::from(state.buttons),
                    u32::from(state.stick_x)
                        | (u32::from(state.stick_y) << 8)
                        | (u32::from(state.c_stick_x) << 16)
                        | (u32::from(state.c_stick_y) << 24),
                    u32::from(state.trigger_l)
                        | (u32::from(state.trigger_r) << 8)
                        | (u32::from(state.analog_a) << 16)
                        | (u32::from(state.analog_b) << 24),
                )
            });
        self.capture_authority_snapshot = CaptureAuthorityV2 {
            magic: CAPTURE_AUTHORITY_MAGIC,
            version: 2,
            bytes: core::mem::size_of::<CaptureAuthorityV2>() as u32,
            canonical_cycle_lo: canonical_cycle[0],
            canonical_cycle_hi: canonical_cycle[1],
            executed_cycles_lo: executed_cycles[0],
            executed_cycles_hi: executed_cycles[1],
            executed_instructions_lo: executed_instructions[0],
            executed_instructions_hi: executed_instructions[1],
            retired_blocks_lo: retired_blocks[0],
            retired_blocks_hi: retired_blocks[1],
            si_poll_index_lo: si_poll_index[0],
            si_poll_index_hi: si_poll_index[1],
            si_scheduled_cycle_lo: si_scheduled_cycle[0],
            si_scheduled_cycle_hi: si_scheduled_cycle[1],
            si_observed_cycle_lo: si_observed_cycle[0],
            si_observed_cycle_hi: si_observed_cycle[1],
            si_applied_sequence_lo: si_applied_sequence[0],
            si_applied_sequence_hi: si_applied_sequence[1],
            si_packet_word_0: si.packet_be_words[0],
            si_packet_word_1: si.packet_be_words[1],
            si_source: si.source_raw,
            si_controller_mode: controller_mode,
            si_buttons: buttons,
            si_stick_xy_cxy: stick_xy_cxy,
            si_trigger_lrab: trigger_lrab,
            reserved: 0,
        };
        Some(&self.capture_authority_snapshot)
    }

    #[cfg(feature = "game-fidelity-probes")]
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn sample_game_fidelity_after_dispatch(&mut self) {
        if !self.machine_evidence.is_healthy() || self.machine_exit.is_some() {
            self.game_fidelity.fail_machine_lifetime();
            return;
        }
        let cycle = self.system.scheduler.canonical_elapsed();
        self.game_fidelity
            .sample_after_dispatch(&mut self.system, cycle);
    }

    #[cfg(feature = "game-fidelity-probes")]
    fn refresh_game_fidelity_trust(&mut self) {
        if !self.machine_evidence.is_healthy() || self.machine_exit.is_some() {
            self.game_fidelity.fail_machine_lifetime();
        }
    }

    #[cfg(feature = "game-fidelity-probes")]
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn game_fidelity_requested_buttons(&mut self) -> u32 {
        self.refresh_game_fidelity_trust();
        self.game_fidelity.requested_buttons()
    }

    #[cfg(feature = "game-fidelity-probes")]
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn game_fidelity_requested_stick_xy_cxy(&mut self) -> u32 {
        self.refresh_game_fidelity_trust();
        self.game_fidelity
            .requested_controller_state()
            .map_or(0, pack_game_fidelity_stick_xy_cxy)
    }

    #[cfg(feature = "game-fidelity-probes")]
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn game_fidelity_requested_trigger_lrab(&mut self) -> u32 {
        self.refresh_game_fidelity_trust();
        self.game_fidelity
            .requested_controller_state()
            .map_or(0, pack_game_fidelity_trigger_lrab)
    }

    #[cfg(feature = "game-fidelity-probes")]
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn game_fidelity_phase(&mut self) -> u32 {
        self.refresh_game_fidelity_trust();
        self.game_fidelity
            .phase()
            .map_or(ProbePhase::Unarmed as u32, |phase| phase as u32)
    }

    #[cfg(feature = "game-fidelity-probes")]
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn game_fidelity_snapshot(&mut self) -> Option<&[u8; GAME_FIDELITY_RECORD_BYTES]> {
        self.refresh_game_fidelity_trust();
        self.game_fidelity.snapshot()
    }

    pub fn cold_compile(&self) -> &ColdCompileCoordinator {
        &self.cold_compile
    }

    pub fn cold_compile_mut(&mut self) -> &mut ColdCompileCoordinator {
        &mut self.cold_compile
    }

    #[cfg(any(target_arch = "wasm32", test))]
    pub fn pending_installable(&self) -> Option<&InstallableColdBlock> {
        self.pending_installable.as_ref()
    }

    #[cfg(any(target_arch = "wasm32", test))]
    fn discard_pending_installable_for_slot(&mut self, retired: TableSlotRetirement) -> bool {
        let matches = self.pending_installable.as_ref().is_some_and(|pending| {
            let identity = pending.identity();
            identity.table_slot == retired.table_slot && identity.slot_nonce() == retired.slot_nonce
        });
        if matches {
            self.pending_installable = None;
            #[cfg(target_arch = "wasm32")]
            {
                self.host_compile_request = None;
            }
        }
        matches
    }

    #[cfg(any(target_arch = "wasm32", test))]
    fn discard_pending_installable(&mut self, identity: ResidentBlockInstallIdentity) -> bool {
        let matches = self
            .pending_installable
            .as_ref()
            .is_some_and(|pending| pending.identity() == identity);
        if matches {
            self.pending_installable = None;
            #[cfg(target_arch = "wasm32")]
            {
                self.host_compile_request = None;
            }
        }
        matches
    }

    #[cfg(any(target_arch = "wasm32", test))]
    fn fail_prepared_compile(
        &mut self,
        error: PrepareCurrentPcError,
        mut retirements: ColdCompileRetirements,
    ) -> PrepareCurrentPcFailure {
        retirements.cancelled_preparation = self.cold_compile.cancel_pending();
        if let Some(cancelled) = retirements.cancelled_preparation {
            self.discard_pending_installable_for_slot(cancelled);
        }
        PrepareCurrentPcFailure { error, retirements }
    }

    #[cfg(any(target_arch = "wasm32", test))]
    #[allow(
        clippy::result_large_err,
        reason = "the synchronous failure owns exact retirements and must not allocate while recovering"
    )]
    fn prepare_current_pc_compile_with_source(
        &mut self,
        source_for: impl FnOnce(&ResidentModule) -> Option<lazuli::runtime::WasmModuleSource>,
    ) -> Result<PreparedCompileRequest, PrepareCurrentPcFailure> {
        let mut retirements = ColdCompileRetirements::default();
        if self.pending_installable.is_some() || self.cold_compile.has_pending_compile() {
            return Err(PrepareCurrentPcFailure {
                error: PrepareCurrentPcError::PendingRequest,
                retirements,
            });
        }

        let synchronized = self.runtime_hooks.synchronize_address_space(&self.system);
        if synchronized.outcome != HookOutcome::Complete {
            retirements.blocks.extend(
                self.cold_compile
                    .invalidate_where(|block| synchronized.invalidation.selects(block)),
            );
            self.resident_context.control.request_exit();
            if synchronized.outcome != HookOutcome::Invalidated {
                return Err(PrepareCurrentPcFailure {
                    error: PrepareCurrentPcError::AddressSpaceSynchronization(synchronized.outcome),
                    retirements,
                });
            }
        }

        let generation = self.runtime_hooks.current_generation();
        let pc = self.system.cpu.pc;
        let prepared = self
            .cold_block_compiler
            .prepare(&mut self.system, generation, pc)
            .map_err(|error| PrepareCurrentPcFailure {
                error: PrepareCurrentPcError::Block(error),
                retirements: retirements.clone(),
            })?;
        let preparation = self
            .cold_compile
            .prepare_compile(prepared.block())
            .map_err(|error| PrepareCurrentPcFailure {
                error: PrepareCurrentPcError::Coordinator(error),
                retirements: retirements.clone(),
            })?;
        retirements.blocks.extend(preparation.evicted);
        retirements.reclaimed_slot = preparation.retired_slot;

        let installable = match self
            .cold_block_compiler
            .finalize_installable(prepared, preparation.install_identity)
        {
            Ok(installable) => installable,
            Err(error) => {
                return Err(
                    self.fail_prepared_compile(PrepareCurrentPcError::Block(error), retirements)
                );
            }
        };
        let Some(source) = source_for(installable.module()) else {
            return Err(self.fail_prepared_compile(
                PrepareCurrentPcError::SharedModuleUnavailable,
                retirements,
            ));
        };
        let request = match self
            .cold_compile
            .publish_prepared_compile(installable.identity(), source)
        {
            Ok(request) => request,
            Err(error) => {
                return Err(
                    self.fail_prepared_compile(PrepareCurrentPcError::Publish(error), retirements)
                );
            }
        };
        self.pending_installable = Some(installable);
        Ok(PreparedCompileRequest {
            request,
            retirements,
        })
    }

    /// Compiles the current PPC PC into an exact Rust-authored self-installing Wasm module.
    ///
    /// The returned request is a by-value ABI copy. Its source stays valid because this machine
    /// retains the finalized module until installation commits, fails, or is invalidated.
    #[cfg(target_arch = "wasm32")]
    #[allow(
        clippy::result_large_err,
        reason = "the synchronous failure owns exact retirements and must not allocate while recovering"
    )]
    pub fn prepare_current_pc_compile(
        &mut self,
    ) -> Result<PreparedCompileRequest, PrepareCurrentPcFailure> {
        self.prepare_current_pc_compile_with_source(ResidentModule::shared_source)
    }

    #[cfg(test)]
    #[allow(
        clippy::result_large_err,
        reason = "the synchronous failure owns exact retirements and must not allocate while recovering"
    )]
    fn prepare_current_pc_compile_at(
        &mut self,
        source_offset: lazuli_abi::SharedPtr,
    ) -> Result<PreparedCompileRequest, PrepareCurrentPcFailure> {
        self.prepare_current_pc_compile_with_source(|module| module.source_at(source_offset))
    }

    pub fn event_deadlines(&self) -> &MachineEventDeadlines {
        &self.event_deadlines
    }

    pub fn event_deadlines_mut(&mut self) -> &mut MachineEventDeadlines {
        &mut self.event_deadlines
    }

    fn serial_service_timing_at(&self, observed_cycle: u64) -> si::ViSerialTiming {
        // An overdue poll must advance recurrence from its scheduled raster phase. Anchoring a
        // fresh snapshot at the later service cycle would make `following_poll_cycle` reject the
        // earlier identity and would lose negative-epoch VI phase preservation.
        let anchor_cycle = self
            .system
            .serial
            .next_poll_cycle()
            .filter(|scheduled| *scheduled <= observed_cycle)
            .unwrap_or(observed_cycle);
        self.system
            .video
            .serial_timing_at_cycle(anchor_cycle)
            .unwrap_or_else(|| si::ViSerialTiming::disabled_at(anchor_cycle))
    }

    fn synchronize_serial_poll_timing_at(
        &mut self,
        observed_cycle: u64,
    ) -> Result<(), ResidentMmioError> {
        if let Some(timing) = self.system.video.serial_timing_at_cycle(observed_cycle) {
            self.system
                .serial
                .synchronize_poll_timing(timing, observed_cycle, &mut self.event_deadlines)
                .map_err(|error| ResidentMmioError::Serial(error.into()))?;
        } else {
            self.system
                .serial
                .clear_poll_timing(&mut self.event_deadlines);
        }
        self.system
            .serial
            .publish_deadlines(&mut self.event_deadlines);
        Ok(())
    }

    fn initialize_resident_vi_si_deadlines(&mut self) -> Result<(), ResidentMmioError> {
        let observed_cycle = self.system.scheduler.elapsed();
        self.system
            .video
            .synchronize_resident(observed_cycle)
            .map_err(ResidentMmioError::Video)?;
        self.system
            .video
            .publish_resident_deadlines(&mut self.event_deadlines);
        self.synchronize_serial_poll_timing_at(observed_cycle)?;
        Ok(())
    }

    /// Completes the VI due-events phase and refreshes PI only after comparator, timing, and
    /// scanout transitions have drained in their exact Rust-owned order.
    fn service_resident_vi_phase_at(
        &mut self,
        observed_cycle: u64,
    ) -> Result<(), ResidentMmioError> {
        let prior_reschedules = self.system.video.resident_timing_reschedules();
        let summary = self
            .system
            .service_resident_video_interface(observed_cycle, &mut self.event_deadlines)
            .map_err(ResidentMmioError::Video)?;
        self.machine_evidence
            .record_vi_fields(summary.scanout_boundaries);
        if self.system.video.resident_timing_reschedules() != prior_reschedules {
            self.synchronize_serial_poll_timing_at(observed_cycle)?;
        }
        Ok(())
    }

    /// Completes SI's poll-before-transfer phase and refreshes PI once after the batch.
    fn service_resident_si_phase_at(
        &mut self,
        observed_cycle: u64,
    ) -> Result<(), ResidentMmioError> {
        let timing = self.serial_service_timing_at(observed_cycle);
        let summary = si::service_due(
            &mut self.system,
            timing,
            observed_cycle,
            &mut self.event_deadlines,
        )
        .map_err(ResidentMmioError::Serial)?;
        self.record_machine_evidence_si_summary(summary);
        Ok(())
    }

    fn refresh_machine_evidence_si_gauges(&mut self) {
        let queue_depth = self.system.serial.controller_queue_len();
        let last_received = self.system.serial.controller_last_received_sequence();
        self.machine_evidence
            .refresh_si_gauges(queue_depth, last_received);
    }

    #[cfg(feature = "game-fidelity-probes")]
    fn accept_game_fidelity_si_publication(&mut self, publication: si::ControllerPublication) {
        if self.machine_evidence.is_healthy() && self.machine_exit.is_none() {
            self.game_fidelity
                .accept_authenticated_si_publication(publication);
        } else {
            self.game_fidelity.fail_machine_lifetime();
        }
    }

    fn record_machine_evidence_si_summary(&mut self, summary: si::SerialServiceSummary) {
        let queue_depth = self.system.serial.controller_queue_len();
        let last_received = self.system.serial.controller_last_received_sequence();
        if summary.backpressured_polls != 0 {
            self.machine_evidence.record_si_backpressure(
                summary.backpressured_polls,
                queue_depth,
                last_received,
            );
        }
        if let Some(publication) = summary.periodic_publication {
            self.machine_evidence.record_si_publication(
                lazuli_abi::MachineSiPollSource::Periodic,
                publication,
                queue_depth,
                last_received,
            );
            #[cfg(feature = "game-fidelity-probes")]
            self.accept_game_fidelity_si_publication(publication);
        }
        if let Some(publication) = summary
            .transfer
            .and_then(|completion| completion.publication)
        {
            self.machine_evidence.record_si_publication(
                lazuli_abi::MachineSiPollSource::Direct,
                publication,
                queue_depth,
                last_received,
            );
            #[cfg(feature = "game-fidelity-probes")]
            self.accept_game_fidelity_si_publication(publication);
        }
        if summary.backpressured_polls == 0
            && summary.periodic_publication.is_none()
            && summary
                .transfer
                .is_none_or(|completion| completion.publication.is_none())
        {
            self.refresh_machine_evidence_si_gauges();
        }
    }

    #[cfg(any(target_arch = "wasm32", test))]
    fn si_summary_has_machine_evidence(summary: si::SerialServiceSummary) -> bool {
        summary.backpressured_polls != 0
            || summary.periodic_publication.is_some()
            || summary
                .transfer
                .and_then(|completion| completion.publication)
                .is_some()
    }

    /// Retains SI evidence performed inside observed MMIO hooks until the dispatcher authenticates
    /// the instruction's complete cycle contribution. An instruction can issue many MMIO hooks,
    /// but the first `service_due` drains all work due at that observed cycle; later empty
    /// summaries need no delayed evidence commit. A second evidence-bearing producer fails closed.
    #[cfg(any(target_arch = "wasm32", test))]
    fn stage_resident_si_summary(&mut self, summary: si::SerialServiceSummary) -> bool {
        if !Self::si_summary_has_machine_evidence(summary) {
            return true;
        }
        if self.pending_resident_si_summary.is_some() {
            self.machine_evidence.fail_closed();
            self.publish_machine_exit(ResidentMachineExitDetail::HookObservationRejected);
            return false;
        }
        self.pending_resident_si_summary = Some(summary);
        true
    }

    /// Commits the exact hook-owned SI summary only after canonical scheduler and dispatch
    /// evidence accounting cover its observed instruction cycle.
    #[cfg(any(target_arch = "wasm32", test))]
    fn commit_resident_si_summary(&mut self) -> bool {
        if let Some(summary) = self.pending_resident_si_summary.take() {
            self.record_machine_evidence_si_summary(summary);
            if !self.machine_evidence.is_healthy() {
                self.publish_machine_exit(ResidentMachineExitDetail::SerialServiceError);
                return false;
            }
        }
        true
    }

    /// Services DTK before DI completion, republishes both disk deadlines, and refreshes PI only
    /// after the complete Rust disk phase.
    fn service_resident_di_phase_at(&mut self, observed_cycle: u64) -> ResidentServiceState {
        let summary = {
            let System { disk, mem, cpu, .. } = &mut self.system;
            disk.service_resident(observed_cycle, mem.ram_mut(), &mut cpu.reservation)
        };
        self.system
            .disk
            .publish_resident_deadlines(&mut self.event_deadlines);
        pi::check_interrupts_excluding_pixel_engine(&mut self.system);
        if let ResidentServiceState::Completed(completion) = summary.command {
            self.machine_evidence
                .record_di_completion(completion.successful, completion.error_code);
        }
        summary.command
    }

    fn publish_resident_device_error(&mut self, error: ResidentMmioError) {
        let detail = match error {
            ResidentMmioError::Video(_) => ResidentMachineExitDetail::VideoServiceError,
            ResidentMmioError::Dsp(ResidentDspServiceError::Interpreter(
                DspLleServiceError::FatalStop(slice),
            )) => {
                self.event_deadlines
                    .schedule(MachineEventKind::DspExecution, slice.next_execution_cycle);
                self.machine_evidence
                    .set_dsp_lle_steps(self.system.dsp.lle.executed_instructions());
                self.machine_evidence.invalidate_dsp_lle();
                ResidentMachineExitDetail::DspFatalStop
            }
            ResidentMmioError::Audio(_)
            | ResidentMmioError::Dsp(_)
            | ResidentMmioError::Aram(_) => ResidentMachineExitDetail::DspServiceError,
            ResidentMmioError::Serial(_) => ResidentMachineExitDetail::SerialServiceError,
            ResidentMmioError::Disk(_) => ResidentMachineExitDetail::DiskServiceError,
        };
        self.publish_machine_exit(detail);
    }

    #[cfg(any(target_arch = "wasm32", test))]
    fn efb_load_must_order_after_graphics(&self) -> bool {
        self.pending_gx_progress.is_some()
            || self.gx_runtime.pending_barrier().is_some()
            || self.render_runtime.pending_count() != 0
            || self.system.gpu.cmd.resident_fifo_reset_pending()
            || !self.system.gpu.cmd.queue.is_empty()
            || self.system.gpu.cmd.resident_fifo_drainable()
    }

    /// Resolves one resident word read, retaining a translated EFB access across every required
    /// cooperative yield. A completed receipt is consumed only by the same effective address at
    /// the same instruction-start cycle and unchanged guest PC.
    #[cfg(any(target_arch = "wasm32", test))]
    fn read_resident_i32_at(
        &mut self,
        effective: Address,
        observed_cycle: u64,
    ) -> Result<ResidentI32Read, ResidentMmioError> {
        let identity = match self.pending_efb_load {
            Some(continuation) => {
                let identity = continuation.identity();
                if !identity.matches(effective.value(), observed_cycle) {
                    self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
                    return Ok(ResidentI32Read::MachineExit);
                }
                match continuation {
                    EfbLoadContinuation::Ready {
                        retry_pc, value, ..
                    } => {
                        if self.system.cpu.pc != retry_pc {
                            self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
                            return Ok(ResidentI32Read::MachineExit);
                        }
                        self.pending_efb_load = None;
                        return Ok(ResidentI32Read::Complete(value as i32));
                    }
                    EfbLoadContinuation::AwaitingReceipt { .. } => {
                        return Ok(ResidentI32Read::Yield);
                    }
                    EfbLoadContinuation::Ordering { .. } => identity,
                }
            }
            None => {
                let mut value = 0_i32;
                match MachineRuntimeHooks::read_slow_classified_at_deferred(
                    &mut self.system,
                    effective,
                    &mut value,
                    observed_cycle,
                )? {
                    ResidentMemoryRead::Complete(result) => {
                        return Ok(ResidentI32Read::Memory { result, value });
                    }
                    ResidentMemoryRead::EfbPeek { physical } => EfbLoadIdentity {
                        effective: effective.value(),
                        physical,
                        observed_cycle,
                        alpha_read_mode: self.system.gpu.pix.canonical_alpha_read_mode(),
                    },
                }
            }
        };

        match classify_efb_peek_address(identity.physical) {
            Ok(EfbPeekAddress::ImmediateZero { .. }) => {
                self.pending_efb_load = None;
                return Ok(ResidentI32Read::Complete(0));
            }
            Ok(EfbPeekAddress::Pixel { .. }) => {}
            Err(_) => {
                self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
                return Ok(ResidentI32Read::MachineExit);
            }
        }

        if self.efb_load_must_order_after_graphics() {
            self.pending_efb_load = Some(EfbLoadContinuation::Ordering { identity });
            return Ok(ResidentI32Read::Yield);
        }

        let Ok(progress) = self.gx_runtime.request_efb_peek(EfbPeekRequest {
            physical_address: identity.physical,
            alpha_read_mode: identity.alpha_read_mode,
            earlier_renderer_terminal: false,
        }) else {
            self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
            return Ok(ResidentI32Read::MachineExit);
        };
        match progress {
            GxEfbPeekProgress::ImmediateZero { .. } => {
                self.pending_efb_load = None;
                Ok(ResidentI32Read::Complete(0))
            }
            GxEfbPeekProgress::YieldForEarlierTerminal => {
                self.pending_efb_load = Some(EfbLoadContinuation::Ordering { identity });
                Ok(ResidentI32Read::Yield)
            }
            GxEfbPeekProgress::Terminal(handoff) => {
                if !self.render_can_admit_terminal(&handoff) {
                    let (handoff_identity, _, _) = handoff.into_parts();
                    let _ = self.gx_runtime.fail_terminal_handoff(handoff_identity);
                    self.publish_machine_exit(ResidentMachineExitDetail::RenderRuntimeError);
                    return Ok(ResidentI32Read::MachineExit);
                }
                let (handoff_identity, packet, metadata) = handoff.into_parts();
                let terminal_sequence = metadata.terminal.sequence;
                let Some(supplement) = Self::render_supplement(metadata) else {
                    let _ = self.gx_runtime.fail_terminal_handoff(handoff_identity);
                    self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
                    return Ok(ResidentI32Read::MachineExit);
                };
                if self.submit_render_packet(packet, supplement).is_err() {
                    let _ = self.gx_runtime.fail_terminal_handoff(handoff_identity);
                    self.publish_machine_exit(ResidentMachineExitDetail::RenderRuntimeError);
                    return Ok(ResidentI32Read::MachineExit);
                }
                if self
                    .gx_runtime
                    .accept_terminal_handoff(handoff_identity)
                    .is_err()
                {
                    self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
                    return Ok(ResidentI32Read::MachineExit);
                }
                self.pending_efb_load = Some(EfbLoadContinuation::AwaitingReceipt {
                    identity,
                    terminal_sequence,
                });
                self.refresh_render_wait_request();
                Ok(ResidentI32Read::Yield)
            }
        }
    }

    /// Applies one classified memory hook. Ordinary hashed/slow RAM stays in the dispatcher;
    /// only the exact translated MMIO target crosses the resident device boundary.
    #[cfg(any(target_arch = "wasm32", test))]
    fn apply_memory_hook_result(
        &mut self,
        result: MemoryHookResult,
        observed_cycle: u64,
        prior_vi_reschedules: u64,
    ) -> HookOutcome {
        if result.boundary == HookMemoryBoundary::Device {
            let Some(serial_service) = result.serial_service else {
                self.machine_evidence.fail_closed();
                self.publish_machine_exit(ResidentMachineExitDetail::HookObservationRejected);
                return HookOutcome::Fault;
            };
            if !self.stage_resident_si_summary(serial_service) {
                return HookOutcome::Fault;
            }
            if !self.consume_resident_di_reset() {
                self.publish_machine_exit(ResidentMachineExitDetail::DiskAdapterError);
                return HookOutcome::Fault;
            }
            self.system
                .video
                .publish_resident_deadlines(&mut self.event_deadlines);
            if self.system.video.resident_timing_reschedules() != prior_vi_reschedules
                && let Err(error) = self.synchronize_serial_poll_timing_at(observed_cycle)
            {
                self.publish_resident_device_error(error);
                return HookOutcome::Fault;
            }
            self.system
                .serial
                .publish_deadlines(&mut self.event_deadlines);
            if let Err(error) = self
                .system
                .publish_resident_audio_deadlines(&mut self.event_deadlines)
            {
                self.publish_resident_device_error(ResidentMmioError::Audio(error));
                return HookOutcome::Fault;
            }
            if let Err(error) = self
                .system
                .publish_resident_dsp_deadlines(&mut self.event_deadlines)
            {
                self.publish_resident_device_error(ResidentMmioError::Audio(error));
                return HookOutcome::Fault;
            }
            self.system
                .disk
                .publish_resident_deadlines(&mut self.event_deadlines);
            // The checked memory instruction has completed, but its translated block is still
            // live. Raising PI here would mutate PC/MSR/SRR while later instructions from that
            // pre-exception block could still execute. Request an exact post-instruction return;
            // the Rust outer boundary samples PI only after authenticated dispatch accounting.
            self.resident_context.control.request_exit();
        } else if result.serial_service.is_some() {
            self.machine_evidence.fail_closed();
            self.publish_machine_exit(ResidentMachineExitDetail::HookObservationRejected);
            return HookOutcome::Fault;
        }
        self.apply_hook_result(result.result)
    }

    /// Selects the same combined fixed/legacy deadline used to seal a resident run plan.
    ///
    /// Keeping this at the machine boundary lets observed hooks detect an earlier fixed deadline
    /// as VI/SI/DI and other devices migrate out of the legacy callback scheduler.
    #[cfg(any(target_arch = "wasm32", test))]
    fn next_resident_deadline_at(&self, observed_cycle: u64) -> Option<u64> {
        let fixed_deadline = if self
            .event_deadlines
            .runtime_event_due_at_or_before(observed_cycle)
        {
            Some(observed_cycle)
        } else {
            self.event_deadlines
                .next_cycle_after(observed_cycle, RuntimeDeadlinePolicy::EXACT)
        };
        let legacy_deadline = self
            .system
            .scheduler
            .until_next()
            .map(|remaining| observed_cycle.saturating_add(remaining));
        match (fixed_deadline, legacy_deadline) {
            (Some(fixed), Some(legacy)) => Some(fixed.min(legacy)),
            (fixed @ Some(_), None) => fixed,
            (None, legacy) => legacy,
        }
    }

    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn publish_machine_exit(&mut self, detail: ResidentMachineExitDetail) {
        if self.machine_exit.is_none() {
            let mut outcome = RunOutcome::new(RunReason::Fault);
            outcome.detail = detail as u32;
            self.machine_exit = Some(outcome);
            self.refresh_machine_evidence_scheduler(Some(MachineFault {
                reason: RunReason::Fault,
                detail: detail as u32,
            }));
        }
        self.resident_context.control.request_exit();
    }

    /// Executes one resident semantic hook at its authenticated instruction-start cycle.
    ///
    /// Canonical time remains unchanged until `core_finish_slice` accepts the dispatcher's report.
    /// Every normal hook return closes the scope.  Scheduling a deadline earlier than the one that
    /// bounded the active block requests an immediate dispatcher exit, including fixed deadlines
    /// that future device ports publish outside the legacy scheduler.
    #[cfg(any(target_arch = "wasm32", test))]
    fn observe_resident_hook<T>(
        &mut self,
        operation: impl FnOnce(&mut BrowserMachine) -> T,
    ) -> Option<T> {
        let hook_cycle = self.resident_context.control.exact_hook_cycle();
        if !self
            .run_coordinator
            .authorizes_resident_hook_cycle(hook_cycle)
        {
            self.publish_machine_exit(ResidentMachineExitDetail::HookObservationRejected);
            return None;
        }
        let Ok(observation) = self.system.scheduler.begin_observation(hook_cycle) else {
            self.publish_machine_exit(ResidentMachineExitDetail::HookObservationRejected);
            return None;
        };
        let observed_cycle = self.system.scheduler.elapsed();
        let prior_deadline = self.next_resident_deadline_at(observed_cycle);
        let prior_pc = self.system.cpu.pc;
        let result = operation(self);
        let next_deadline = self.next_resident_deadline_at(observed_cycle);
        let pc_changed = self.system.cpu.pc != prior_pc;
        let Ok(scheduler_effect) = self.system.scheduler.end_observation(observation) else {
            self.publish_machine_exit(ResidentMachineExitDetail::HookObservationRejected);
            return None;
        };
        let combined_deadline_advanced = match (prior_deadline, next_deadline) {
            (Some(prior), Some(next)) => next < prior,
            (None, Some(_)) => true,
            _ => false,
        };
        if scheduler_effect
            == lazuli::system::scheduler::SchedulerObservationEffect::EarlierDeadline
            || combined_deadline_advanced
            || pc_changed
        {
            self.resident_context.control.request_exit();
        }
        Some(result)
    }

    /// Commits only a dispatcher report that covers every semantic time observed by its hooks.
    #[cfg(any(target_arch = "wasm32", test))]
    fn commit_resident_dispatch_cycles(&mut self, cycles: u64) -> bool {
        if self.system.scheduler.try_advance(cycles).is_ok() {
            true
        } else {
            self.publish_machine_exit(ResidentMachineExitDetail::SchedulerAdvanceRejected);
            false
        }
    }

    #[cfg(any(target_arch = "wasm32", test))]
    fn current_block_metadata(&self) -> Option<core_run::CurrentBlockMetadata> {
        let generation = self.runtime_hooks.current_generation();
        let pc = self.system.cpu.pc;
        self.cold_compile
            .peek(generation, pc)
            .map(|block| core_run::CurrentBlockMetadata {
                generation: block.generation.0,
                pc: block.pc.value(),
                table_slot: block.table_slot,
                slot_nonce: block.slot_nonce,
                pattern: block.pattern,
                maximum_cycles: block.maximum_cycles,
            })
    }

    #[cfg(any(target_arch = "wasm32", test))]
    const fn idle_probe_metadata(
        identity: core_run::IdleProbeIdentity,
    ) -> core_run::CurrentBlockMetadata {
        core_run::CurrentBlockMetadata {
            generation: identity.generation,
            pc: identity.pc,
            table_slot: identity.table_slot,
            slot_nonce: identity.slot_nonce,
            pattern: identity.pattern,
            maximum_cycles: identity.maximum_cycles,
        }
    }

    #[cfg(any(target_arch = "wasm32", test))]
    fn resolve_idle_without_advance(
        &mut self,
        identity: core_run::IdleProbeIdentity,
    ) -> Option<core_run::FinishSlice> {
        match self
            .run_coordinator
            .resolve_idle_probe(identity, core_run::IdleResolution::Resume)
        {
            Ok(finish) => {
                if finish == core_run::FinishSlice::Outcome {
                    self.resident_idle_witness = None;
                }
                Some(finish)
            }
            Err(_) => {
                self.resident_idle_witness = None;
                self.publish_machine_exit(ResidentMachineExitDetail::IdleAdvanceRejected);
                None
            }
        }
    }

    /// Re-authenticates one exact installed idle block and, after two unchanged transitions,
    /// charges an exact Rust-selected deadline jump to both scheduler and active slice.
    #[cfg(any(target_arch = "wasm32", test))]
    fn resolve_resident_idle_probe(
        &mut self,
        identity: core_run::IdleProbeIdentity,
    ) -> Option<core_run::FinishSlice> {
        if self.current_block_metadata() != Some(Self::idle_probe_metadata(identity)) {
            self.resident_idle_witness = None;
            return self.resolve_idle_without_advance(identity);
        }

        let cpu = self.system.cpu.clone();
        let stable_transitions = match self.resident_idle_witness.take() {
            Some(previous)
                if previous.identity == identity
                    && resident_idle_cpu_stable(&previous.cpu, &cpu) =>
            {
                previous.stable_transitions.saturating_add(1)
            }
            _ => 0,
        };
        self.resident_idle_witness = Some(ResidentIdleWitness {
            identity,
            cpu,
            stable_transitions,
        });
        if stable_transitions < 2 {
            return self.resolve_idle_without_advance(identity);
        }

        let now = self.system.scheduler.canonical_elapsed();
        let Some(deadline) = self.next_resident_deadline_at(now) else {
            return self.resolve_idle_without_advance(identity);
        };
        if deadline == now {
            self.resident_idle_witness = None;
            return match self
                .run_coordinator
                .resolve_idle_probe(identity, core_run::IdleResolution::ServiceNow)
            {
                Ok(finish) => Some(finish),
                Err(_) => {
                    self.publish_machine_exit(ResidentMachineExitDetail::IdleAdvanceRejected);
                    None
                }
            };
        }
        let Some(cycles) = deadline.checked_sub(now) else {
            self.resident_idle_witness = None;
            self.publish_machine_exit(ResidentMachineExitDetail::IdleAdvanceRejected);
            return None;
        };
        let Some(remaining_cycles) = self.run_coordinator.idle_probe_remaining_cycles(identity)
        else {
            self.resident_idle_witness = None;
            self.publish_machine_exit(ResidentMachineExitDetail::IdleAdvanceRejected);
            return None;
        };
        if cycles > remaining_cycles {
            return self.resolve_idle_without_advance(identity);
        }
        if self
            .run_coordinator
            .validate_idle_advance(identity, cycles)
            .is_err()
            || self.system.scheduler.canonical_elapsed() != now
            || self.system.scheduler.validate_advance(cycles) != Ok(deadline)
        {
            self.resident_idle_witness = None;
            self.publish_machine_exit(ResidentMachineExitDetail::IdleAdvanceRejected);
            return None;
        }

        // The accepted dispatcher report immediately before this method successfully committed
        // every uncommitted hook observation. With no active observation and a checked exact
        // `now + cycles == deadline`, Scheduler::try_advance cannot reject. Charge the same delta
        // to the coordinator first; an impossible scheduler failure becomes a sticky machine
        // fault and can never authorize another dispatcher plan.
        let Ok(finish) = self.run_coordinator.resolve_idle_probe(
            identity,
            core_run::IdleResolution::AdvanceToEvent { cycles },
        ) else {
            self.resident_idle_witness = None;
            self.publish_machine_exit(ResidentMachineExitDetail::IdleAdvanceRejected);
            return None;
        };
        if self.system.scheduler.try_advance(cycles).is_err() {
            self.resident_idle_witness = None;
            self.publish_machine_exit(ResidentMachineExitDetail::SchedulerAdvanceRejected);
            return None;
        }
        if !self.machine_evidence.commit_idle_cycles(
            self.system.scheduler.canonical_elapsed(),
            self.system.cpu.pc.value(),
            self.runtime_hooks.current_generation().0,
            cycles,
        ) {
            self.resident_idle_witness = None;
            self.publish_machine_exit(ResidentMachineExitDetail::IdleAdvanceRejected);
            return None;
        }
        self.resident_idle_witness = None;
        Some(finish)
    }

    fn service_pixel_engine_phase_at(&mut self, observed_cycle: u64) -> bool {
        while let Some(effect) = self.pending_pe_effects.pop_front() {
            let record = SemanticRecord::BpLoad {
                register: effect.register,
                value: effect.value,
            };
            if self
                .system
                .apply_resident_pixel_engine_record(
                    &record,
                    effect.observed_cycle,
                    &mut self.event_deadlines,
                )
                .is_err()
            {
                self.publish_machine_exit(ResidentMachineExitDetail::PixelEngineError);
                return false;
            }
        }
        if self
            .system
            .service_resident_pixel_engine(observed_cycle, &mut self.event_deadlines)
            .is_err()
        {
            self.publish_machine_exit(ResidentMachineExitDetail::PixelEngineError);
            return false;
        }
        true
    }

    fn render_terminal_payload_bytes(metadata: gx_runtime::GxTerminalMetadata) -> Option<usize> {
        match metadata.supplement {
            GxTerminalSupplement::TextureCopy {
                layout: Some(layout),
            } => usize::try_from(layout.row_bytes.checked_mul(layout.row_count)?).ok(),
            GxTerminalSupplement::TextureCopy { layout: None }
            | GxTerminalSupplement::XfbCopy
            | GxTerminalSupplement::EfbPeek => Some(0),
        }
    }

    fn render_charge_can_admit(
        pending_count: usize,
        pending_bytes: usize,
        packet_len: usize,
        packet_charge: usize,
        payload_bytes: usize,
    ) -> bool {
        let Some(response_bytes) = RenderReceipt::BYTE_LEN.checked_add(payload_bytes) else {
            return false;
        };
        let Some(request_bytes) = packet_charge.checked_add(response_bytes) else {
            return false;
        };
        pending_count < MAX_PENDING_RENDER_REQUESTS
            && packet_len <= packet_charge
            && packet_len <= MAX_RENDER_PACKET_BYTES
            && payload_bytes <= MAX_RENDER_RECEIPT_PAYLOAD_BYTES
            && pending_bytes
                .checked_add(request_bytes)
                .is_some_and(|bytes| bytes <= MAX_PENDING_RENDER_BYTES)
    }

    fn render_can_admit_terminal(&self, handoff: &gx_runtime::GxTerminalHandoff) -> bool {
        let Some(payload_bytes) = Self::render_terminal_payload_bytes(handoff.metadata()) else {
            return false;
        };
        Self::render_charge_can_admit(
            self.render_runtime.pending_count(),
            self.render_runtime.pending_bytes(),
            handoff.packet().len(),
            handoff.pending_charge(),
            payload_bytes,
        )
    }

    fn render_supplement(
        metadata: gx_runtime::GxTerminalMetadata,
    ) -> Option<RenderCommitSupplement> {
        match metadata.supplement {
            GxTerminalSupplement::TextureCopy { layout } => {
                let materialization = match layout {
                    Some(layout) => Some(TextureCopyMaterialization::new(
                        layout.row_bytes,
                        layout.row_count,
                        u32::from(layout.copy_format),
                        u32::from(layout.base_format),
                    )?),
                    None => None,
                };
                Some(RenderCommitSupplement::TextureCopy(materialization))
            }
            GxTerminalSupplement::XfbCopy => Some(RenderCommitSupplement::XfbCopy),
            GxTerminalSupplement::EfbPeek => Some(RenderCommitSupplement::EfbPeek),
        }
    }

    fn submit_render_packet(
        &mut self,
        packet: Vec<u8>,
        supplement: RenderCommitSupplement,
    ) -> Result<HostRequest, RenderSubmitError> {
        let texture_copy_barrier = matches!(supplement, RenderCommitSupplement::TextureCopy(_));
        #[cfg(target_arch = "wasm32")]
        let result = { self.render_runtime.submit(packet, supplement) };
        #[cfg(not(target_arch = "wasm32"))]
        let result = {
            self.render_runtime.submit_at(
                packet,
                supplement,
                SharedPtr(0x1000_0000),
                SharedPtr(0x7000_0000),
            )
        };
        if result.is_ok() {
            self.machine_evidence
                .record_render_issue(self.render_runtime.pending_count(), texture_copy_barrier);
        }
        result
    }

    fn submit_vi_plan(
        &mut self,
        plan: render_runtime::ViPresentationCommitPlan,
    ) -> Result<HostRequest, RenderSubmitError> {
        #[cfg(target_arch = "wasm32")]
        let result = { self.render_runtime.submit_vi(plan) };
        #[cfg(not(target_arch = "wasm32"))]
        let result = {
            self.render_runtime
                .submit_vi_at(plan, SharedPtr(0x2000_0000), SharedPtr(0x7100_0000))
        };
        if result.is_ok() {
            self.machine_evidence
                .record_render_issue(self.render_runtime.pending_count(), false);
        }
        result
    }

    fn handle_vi_scanout_rejection(
        &mut self,
        rejection: ViScanoutRejection,
    ) -> ResidentEventService {
        if rejection == ViScanoutRejection::InvalidDimensions {
            // The frozen browser oracle consumes a transient invalid-geometry startup field and
            // later presents from authenticated XFB state. Do not author a renderer request or
            // mutate VI pairing state for this one exact rejection.
            self.pending_vi_work = None;
            ResidentEventService::Complete
        } else {
            self.publish_machine_exit(ResidentMachineExitDetail::ViRenderError);
            ResidentEventService::MachineExit
        }
    }

    fn service_pending_vi_presentation(&mut self) -> ResidentEventService {
        let Some(work) = self.pending_vi_work else {
            return ResidentEventService::Complete;
        };
        // Renderer operations are serialized in the first production cutover. Retain the exact
        // destructive ScanoutWork until the authenticated XFB operation ahead of it completes.
        if self.render_runtime.pending_count() != 0 {
            return ResidentEventService::Deferred;
        }
        match self.vi_render.prepare_scanout(work) {
            ViScanoutOutcome::Ready(handoff) => {
                let (identity, plan) = handoff.into_parts();
                match self.submit_vi_plan(plan) {
                    Ok(request) => {
                        if self.vi_render.accept_handoff(&identity).is_err() {
                            self.publish_machine_exit(ResidentMachineExitDetail::ViRenderError);
                            return ResidentEventService::MachineExit;
                        }
                        self.machine_evidence
                            .accept_vi_selection(AuthenticatedViSelection {
                                selection_cycle: work.scheduled_cycle,
                                render_sequence: u64::from(request.arg0)
                                    | (u64::from(request.arg1) << 32),
                                xfb_generation: plan.expected_generation(),
                                selected_row: plan.selected_row(),
                                mode: plan.mode(),
                                parity: plan.parity(),
                                pair_epoch: plan.pair_epoch(),
                                output_width: plan.output_width(),
                                output_height: plan.output_height(),
                                field_stride_bytes: plan.field_stride_bytes(),
                                field_height: plan.field_height(),
                                row_repeat: plan.row_repeat(),
                                pair_completing: plan.pair_completing(),
                            });
                        self.pending_vi_work = None;
                        self.refresh_render_wait_request();
                        ResidentEventService::Deferred
                    }
                    Err(
                        RenderSubmitError::PendingQueueFull
                        | RenderSubmitError::PendingByteBudget
                        | RenderSubmitError::CommitInProgress,
                    ) => {
                        if self.vi_render.cancel_handoff(&identity).is_err() {
                            self.publish_machine_exit(ResidentMachineExitDetail::ViRenderError);
                            return ResidentEventService::MachineExit;
                        }
                        ResidentEventService::Deferred
                    }
                    Err(_) => {
                        let _ = self.vi_render.cancel_handoff(&identity);
                        self.publish_machine_exit(ResidentMachineExitDetail::ViRenderError);
                        ResidentEventService::MachineExit
                    }
                }
            }
            ViScanoutOutcome::Deferred(_) => {
                // With no renderer operation in flight, no future authenticated XFB can satisfy
                // this already-due field. Consume it locally rather than deadlocking VI forever.
                self.pending_vi_work = None;
                ResidentEventService::Complete
            }
            ViScanoutOutcome::Rejected(rejection) => self.handle_vi_scanout_rejection(rejection),
        }
    }

    /// Applies as much of one charged progress vector as renderer admission permits. No terminal
    /// is extracted from the retained Vec iterator until its complete packet/receipt charge fits.
    fn service_pending_gx_progress(&mut self, observed_cycle: u64) -> ResidentEventService {
        loop {
            let next = self
                .pending_gx_progress
                .as_ref()
                .and_then(|progress| progress.events.as_slice().first());
            let Some(next) = next else {
                let Some(progress) = self.pending_gx_progress.take() else {
                    break;
                };
                let _status = progress.status;
                if let Some(identity) = progress.identity
                    && self.gx_runtime.accept_progress(identity).is_err()
                {
                    self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
                    return ResidentEventService::MachineExit;
                }
                break;
            };

            match next {
                GxRuntimeEvent::PeBpLoad(_) => {
                    let Some(GxRuntimeEvent::PeBpLoad(effect)) = self
                        .pending_gx_progress
                        .as_mut()
                        .and_then(|progress| progress.events.next())
                    else {
                        self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
                        return ResidentEventService::MachineExit;
                    };
                    if self.pending_pe_effects.len() >= MAX_PENDING_PE_EFFECTS
                        || self.pending_pe_effects.try_reserve(1).is_err()
                    {
                        self.publish_machine_exit(ResidentMachineExitDetail::PixelEngineError);
                        return ResidentEventService::MachineExit;
                    }
                    self.pending_pe_effects.push_back(effect);
                }
                GxRuntimeEvent::Terminal(handoff) => {
                    if !self.render_can_admit_terminal(handoff) {
                        if self.render_runtime.pending_count() != 0 {
                            return ResidentEventService::Deferred;
                        }
                        let Some(GxRuntimeEvent::Terminal(handoff)) = self
                            .pending_gx_progress
                            .as_mut()
                            .and_then(|progress| progress.events.next())
                        else {
                            self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
                            return ResidentEventService::MachineExit;
                        };
                        let (identity, _, _) = handoff.into_parts();
                        let _ = self.gx_runtime.fail_terminal_handoff(identity);
                        self.publish_machine_exit(ResidentMachineExitDetail::RenderRuntimeError);
                        return ResidentEventService::MachineExit;
                    }
                    let Some(GxRuntimeEvent::Terminal(handoff)) = self
                        .pending_gx_progress
                        .as_mut()
                        .and_then(|progress| progress.events.next())
                    else {
                        self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
                        return ResidentEventService::MachineExit;
                    };
                    let (identity, packet, metadata) = handoff.into_parts();
                    let Some(supplement) = Self::render_supplement(metadata) else {
                        let _ = self.gx_runtime.fail_terminal_handoff(identity);
                        self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
                        return ResidentEventService::MachineExit;
                    };
                    if self.submit_render_packet(packet, supplement).is_err() {
                        let _ = self.gx_runtime.fail_terminal_handoff(identity);
                        self.publish_machine_exit(ResidentMachineExitDetail::RenderRuntimeError);
                        return ResidentEventService::MachineExit;
                    }
                    if self.gx_runtime.accept_terminal_handoff(identity).is_err() {
                        self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
                        return ResidentEventService::MachineExit;
                    }
                    self.refresh_render_wait_request();
                }
            }
        }
        let _ = observed_cycle;
        ResidentEventService::Complete
    }

    fn append_queued_gx_bytes(&mut self, observed_cycle: u64) -> ResidentEventService {
        if self.pending_gx_progress.is_some() {
            return self.service_pending_gx_progress(observed_cycle);
        }
        self.system.gpu.cmd.queue.prepare();
        let queued = self.system.gpu.cmd.queue.len();
        if queued == 0 {
            return ResidentEventService::Complete;
        }
        if queued > CP_FIFO_SERVICE_BUDGET_BYTES {
            self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
            return ResidentEventService::MachineExit;
        }
        let progress = {
            let System { gpu, mem, .. } = &mut self.system;
            let source = gpu.cmd.queue.data();
            let mut memory = ResidentMem1 {
                bytes: mem.ram_mut(),
            };
            self.gx_runtime.append(source, &mut memory, observed_cycle)
        };
        let Ok(progress) = progress else {
            self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
            return ResidentEventService::MachineExit;
        };
        // Only a successful append transfers every byte into the decoder's bounded carry.
        self.system.gpu.cmd.queue.consume(queued);
        self.pending_gx_progress = Some(PendingGxProgress::from_progress(progress));
        self.service_pending_gx_progress(observed_cycle)
    }

    /// A guest PI FIFO reset may discard decoder carry only after every already-issued semantic
    /// owner has retired. Decoder carry itself is deliberately excluded: clearing that partial
    /// command is the purpose of the reset.
    fn resident_gx_reset_owners_quiescent(&self) -> bool {
        self.pending_gx_progress.is_none()
            && !matches!(
                self.pending_efb_load,
                Some(
                    EfbLoadContinuation::AwaitingReceipt { .. } | EfbLoadContinuation::Ready { .. }
                )
            )
            && self.pending_pe_effects.is_empty()
            && self.gx_runtime.pending_barrier().is_none()
            && self.render_runtime.pending_count() == 0
            && self.pending_vi_work.is_none()
            && !self.vi_render.has_prepared_handoff()
    }

    /// Drains at most one 256 KiB legacy CP window at a time and immediately transfers it into
    /// the resident decoder before allowing any legacy callback to run.
    fn service_resident_gx(&mut self, observed_cycle: u64) -> ResidentEventService {
        self.system
            .scheduler
            .cancel(lazuli::system::gx::cmd::process);
        self.system
            .scheduler
            .cancel(lazuli::system::gx::cmd::consume);

        if self.system.gpu.cmd.resident_fifo_reset_pending() {
            // Progress already returned by the decoder must be allowed to move into its next
            // bounded owner, but no post-reset queue/FIFO byte may enter the old decoder.
            if self.pending_gx_progress.is_some() {
                match self.service_pending_gx_progress(observed_cycle) {
                    ResidentEventService::Complete => {}
                    other => return other,
                }
            }
            if !self.resident_gx_reset_owners_quiescent() {
                // PE and VI owners retire in their later fixed phases. A renderer owner, barrier,
                // or still-retained progress instead fences the whole same-cycle service pass.
                return if self.render_runtime.pending_count() != 0
                    || self.pending_gx_progress.is_some()
                    || self.gx_runtime.pending_barrier().is_some()
                {
                    ResidentEventService::Deferred
                } else {
                    ResidentEventService::Complete
                };
            }
            let Some(_generation) = self.system.gpu.cmd.take_resident_fifo_reset() else {
                self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
                return ResidentEventService::MachineExit;
            };
            // Once the one-shot notification is consumed there is no retry authority. Any
            // unexpected hidden handoff therefore becomes a sticky machine fault.
            self.sync_machine_evidence_graphics();
            if self.gx_runtime.reset().is_err() {
                self.publish_machine_exit(ResidentMachineExitDetail::GxRuntimeError);
                return ResidentEventService::MachineExit;
            }
            self.machine_evidence.accept_gx_reset();
        }

        loop {
            if self.pending_gx_progress.is_none() && self.render_runtime.pending_count() != 0 {
                return ResidentEventService::Deferred;
            }
            match self.append_queued_gx_bytes(observed_cycle) {
                ResidentEventService::Complete => {}
                other => return other,
            }
            if self.pending_gx_progress.is_some()
                || self.gx_runtime.pending_barrier().is_some()
                || self.render_runtime.pending_count() != 0
            {
                return ResidentEventService::Deferred;
            }
            let prior_distance = self.system.gpu.cmd.fifo.distance;
            if prior_distance == 0 || !self.system.gpu.cmd.control.fifo_read_enable() {
                return ResidentEventService::Complete;
            }
            lazuli::system::gx::cmd::consume(&mut self.system);
            self.system
                .scheduler
                .cancel(lazuli::system::gx::cmd::consume);
            self.system.scheduler.cancel(pi::check_interrupts);
            pi::check_interrupts_excluding_pixel_engine(&mut self.system);
            if self.system.gpu.cmd.queue.is_empty()
                && self.system.gpu.cmd.fifo.distance == prior_distance
            {
                return ResidentEventService::Complete;
            }
        }
    }

    fn sync_machine_evidence_graphics(&mut self) {
        let decoder = self.gx_runtime.decoder().stats();
        let runtime = self.gx_runtime.stats();
        let decoder_carry = self.gx_runtime.decoder().buffered_bytes();
        let Ok(pending) = self.gx_runtime.pending_bytes() else {
            self.machine_evidence.fail_closed();
            return;
        };
        self.machine_evidence
            .sync_graphics(decoder, runtime, pending, decoder_carry);
    }

    fn refresh_render_wait_request(&mut self) -> bool {
        let request = self.render_runtime.request(0);
        #[cfg(any(target_arch = "wasm32", test))]
        {
            self.host_render_request = request;
            self.render_wait_outcome.request_ptr = self
                .host_render_request
                .as_ref()
                .map_or(SharedPtr::NULL, |request| {
                    SharedPtr(request as *const HostRequest as usize as u32)
                });
        }
        request.is_some()
    }

    /// Drains the transitional callback queue, then fixed Rust deadlines in browser phase order.
    ///
    /// VI due events drain comparator -> timing -> scanout, SI drains poll -> direct transfer,
    /// and resident PE delivery occurs exactly once after those earlier phases. Presentation
    /// moves an authenticated XFB selection into the typed renderer HostRequest boundary; a
    /// destructive ScanoutWork is retained whenever that boundary is backpressured.
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn service_due_resident_events(&mut self) -> ResidentEventService {
        let observed_cycle = self.system.scheduler.elapsed();
        match self.service_resident_gx(observed_cycle) {
            ResidentEventService::Complete => {}
            ResidentEventService::Deferred => {
                self.refresh_render_wait_request();
                return ResidentEventService::Deferred;
            }
            ResidentEventService::MachineExit => return ResidentEventService::MachineExit,
        }
        // The renderer wait is internal to one guest load. Once its exact earlier GX chain has
        // drained, retry the untranslated Ordering continuation or consume the authenticated
        // Ready value before a due device can raise an interrupt and move PC away from the load.
        if matches!(
            self.pending_efb_load,
            Some(EfbLoadContinuation::Ordering { .. } | EfbLoadContinuation::Ready { .. })
        ) {
            return ResidentEventService::Complete;
        }
        if self.system.scheduler.has_pending() {
            self.system.process_events();
        }

        let mut pixel_engine_serviced = false;
        loop {
            let Some(event) = self
                .event_deadlines
                .next_due_event_at_or_before(observed_cycle, RuntimeDeadlinePolicy::EXACT)
            else {
                if !pixel_engine_serviced && !self.service_pixel_engine_phase_at(observed_cycle) {
                    return ResidentEventService::MachineExit;
                }
                match self.service_pending_vi_presentation() {
                    ResidentEventService::Complete => {}
                    ResidentEventService::Deferred => {
                        self.refresh_render_wait_request();
                        return ResidentEventService::Deferred;
                    }
                    ResidentEventService::MachineExit => {
                        return ResidentEventService::MachineExit;
                    }
                }
                // A reset that was waiting only for PE/VI retirement can now be authenticated and
                // applied. PI reset disables FIFO reads, so this second entry cannot reorder new
                // CP bytes behind the fixed phases that just retired the old owners.
                if self.system.gpu.cmd.resident_fifo_reset_pending() {
                    match self.service_resident_gx(observed_cycle) {
                        ResidentEventService::Complete => {}
                        ResidentEventService::Deferred => {
                            self.refresh_render_wait_request();
                            return ResidentEventService::Deferred;
                        }
                        ResidentEventService::MachineExit => {
                            return ResidentEventService::MachineExit;
                        }
                    }
                }
                return if self.refresh_render_wait_request() {
                    ResidentEventService::Deferred
                } else {
                    ResidentEventService::Complete
                };
            };
            if !pixel_engine_serviced
                && matches!(
                    event.kind.service_phase(),
                    Some(
                        MachineServicePhase::PixelEngine
                            | MachineServicePhase::VideoPresentation
                            | MachineServicePhase::VideoInterrupt
                            | MachineServicePhase::Disk
                            | MachineServicePhase::Decrementer
                    )
                )
            {
                if !self.service_pixel_engine_phase_at(observed_cycle) {
                    return ResidentEventService::MachineExit;
                }
                pixel_engine_serviced = true;
            }
            if matches!(
                event.kind.service_phase(),
                Some(MachineServicePhase::Disk | MachineServicePhase::Decrementer)
            ) {
                match self.service_pending_vi_presentation() {
                    ResidentEventService::Complete => {}
                    ResidentEventService::Deferred => {
                        self.refresh_render_wait_request();
                        return ResidentEventService::Deferred;
                    }
                    ResidentEventService::MachineExit => {
                        return ResidentEventService::MachineExit;
                    }
                }
            }
            match event.kind {
                MachineEventKind::ViComparator
                | MachineEventKind::ViScanoutBoundary
                | MachineEventKind::ViTimingBoundary => {
                    if let Err(error) = self.service_resident_vi_phase_at(observed_cycle) {
                        self.publish_resident_device_error(error);
                        return ResidentEventService::MachineExit;
                    }
                }
                MachineEventKind::SiPoll | MachineEventKind::SiTransferCompletion => {
                    if let Err(error) = self.service_resident_si_phase_at(observed_cycle) {
                        self.publish_resident_device_error(error);
                        return ResidentEventService::MachineExit;
                    }
                }
                MachineEventKind::DiskAudio | MachineEventKind::DiskCompletion => {
                    if let ResidentServiceState::WaitingForHost { .. } =
                        self.service_resident_di_phase_at(observed_cycle)
                    {
                        match self.di_read_request() {
                            Ok(Some(_)) => return ResidentEventService::Deferred,
                            Ok(None) => {
                                // A fully sparse CISO window (or sequence of windows) became
                                // ready without browser work. Re-enter the same due completion.
                            }
                            Err(_) => {
                                self.publish_machine_exit(
                                    ResidentMachineExitDetail::DiskAdapterError,
                                );
                                return ResidentEventService::MachineExit;
                            }
                        }
                    }
                }
                MachineEventKind::AiSample | MachineEventKind::AiInterrupt => {
                    if self
                        .system
                        .service_resident_audio_interface(observed_cycle, &mut self.event_deadlines)
                        .is_err()
                    {
                        self.publish_machine_exit(ResidentMachineExitDetail::DspServiceError);
                        return ResidentEventService::MachineExit;
                    }
                }
                MachineEventKind::DspExecution
                | MachineEventKind::DspAudioDmaInterrupt
                | MachineEventKind::DspAudioDmaBlock
                | MachineEventKind::DspAudioDmaCompletion
                | MachineEventKind::AramDmaCompletion => {
                    match self
                        .system
                        .service_resident_dsp(observed_cycle, &mut self.event_deadlines)
                    {
                        Ok(_) => {
                            self.machine_evidence
                                .set_dsp_lle_steps(self.system.dsp.lle.executed_instructions());
                        }
                        Err(ResidentDspServiceError::Interpreter(
                            DspLleServiceError::FatalStop(slice),
                        )) => {
                            self.event_deadlines.schedule(
                                MachineEventKind::DspExecution,
                                slice.next_execution_cycle,
                            );
                            self.machine_evidence
                                .set_dsp_lle_steps(self.system.dsp.lle.executed_instructions());
                            self.machine_evidence.invalidate_dsp_lle();
                            self.publish_machine_exit(ResidentMachineExitDetail::DspFatalStop);
                            return ResidentEventService::MachineExit;
                        }
                        Err(_) => {
                            self.publish_machine_exit(ResidentMachineExitDetail::DspServiceError);
                            return ResidentEventService::MachineExit;
                        }
                    }
                }
                MachineEventKind::PeFinish => {
                    // The phase gate above services both staged BP records and a due FINISH edge.
                }
                MachineEventKind::ViPresentation => {
                    if self.pending_vi_work.is_none() {
                        match self
                            .system
                            .take_resident_video_scanout(observed_cycle, &mut self.event_deadlines)
                        {
                            Ok(work) => self.pending_vi_work = work,
                            Err(error) => {
                                self.publish_resident_device_error(ResidentMmioError::Video(error));
                                return ResidentEventService::MachineExit;
                            }
                        }
                    }
                    match self.service_pending_vi_presentation() {
                        ResidentEventService::Complete => {}
                        ResidentEventService::Deferred => {
                            self.refresh_render_wait_request();
                            return ResidentEventService::Deferred;
                        }
                        ResidentEventService::MachineExit => {
                            return ResidentEventService::MachineExit;
                        }
                    }
                }
                _ => return ResidentEventService::Deferred,
            }
        }
    }

    /// Stable opaque context pointer passed to resident PPC blocks and their Rust hooks.
    #[cfg(target_arch = "wasm32")]
    fn context_ptr(&mut self) -> u32 {
        core::ptr::addr_of_mut!(self.resident_context) as usize as u32
    }

    /// Stable pointer to the canonical `repr(C)` Gekko CPU owned by this machine.
    #[cfg(target_arch = "wasm32")]
    fn cpu_ptr(&mut self) -> u32 {
        core::ptr::addr_of_mut!(self.system.cpu) as usize as u32
    }

    /// Conservative primary fast-memory table for the current data-translation mode.
    ///
    /// The returned table is write-safe, so generated loads may take a harmless slow path for
    /// read-only IPL while no generated store can bypass Rust permission checks.  Hashed-page
    /// translations stay on the Rust hook path until the Rust-owned 4 KiB sidecar is integrated.
    #[cfg(target_arch = "wasm32")]
    fn fastmem_ptr(&mut self) -> u32 {
        let translated = self
            .system
            .cpu
            .supervisor
            .config
            .msr
            .data_addr_translation();
        self.system.mem.resident_fastmem_write_lut_ptr(translated) as usize as u32
    }

    /// Samples every dispatcher argument and deadline from the canonical Rust-owned machine.
    #[cfg(target_arch = "wasm32")]
    fn core_run_bindings(&mut self) -> core_run::SliceBindings {
        let now = self.system.scheduler.elapsed();
        let next_deadline = self.next_resident_deadline_at(now);
        let generation = self.runtime_hooks.current_generation();
        let pc = self.system.cpu.pc;
        let current_block = self.current_block_metadata();
        let context = self.context_ptr();
        let cpu = self.cpu_ptr();
        let fastmem = self.fastmem_ptr();
        let control = core::ptr::addr_of_mut!(self.resident_context.control) as usize as u32;
        core_run::SliceBindings {
            context,
            cpu,
            fastmem,
            pc_offset: lazuli::gekko::Reg::PC.offset() as u32,
            control,
            generation: generation.0,
            pc: pc.value(),
            now,
            next_deadline,
            current_block,
        }
    }

    /// Samples external interrupts only while no translated block is live, then publishes the
    /// resulting instruction-address-space identity before another dispatcher segment begins.
    #[cfg(any(target_arch = "wasm32", test))]
    fn prepare_resident_dispatch_boundary(&mut self) -> bool {
        // Ordering/Ready are cooperative continuations of one untranslated EFB load. Preserve
        // that instruction's retry PC until it consumes its retained translation/value; the
        // normal boundary immediately after completion will sample the still-live PI levels.
        let unretired_efb_load = matches!(
            self.pending_efb_load,
            Some(EfbLoadContinuation::Ordering { .. } | EfbLoadContinuation::Ready { .. })
        );
        if !unretired_efb_load {
            pi::check_interrupts_excluding_pixel_engine(&mut self.system);
        }
        let synchronized = self.runtime_hooks.synchronize_address_space(&self.system);
        matches!(
            self.apply_hook_result(synchronized),
            HookOutcome::Complete | HookOutcome::Invalidated
        ) && self.machine_exit.is_none()
    }

    #[cfg(target_arch = "wasm32")]
    fn begin_core_run_slice(&mut self, host_cycle_cap: u64, host_block_cap: u32) -> u32 {
        if self.pending_resident_si_summary.is_some() {
            self.machine_evidence.fail_closed();
            self.publish_machine_exit(ResidentMachineExitDetail::HookObservationRejected);
            return 0;
        }
        if self.disc_boot_blocks_cpu_dispatch()
            || self.machine_exit.is_some()
            || self.service_due_resident_events() != ResidentEventService::Complete
            || !self.prepare_resident_dispatch_boundary()
        {
            return 0;
        }
        let bindings = self.core_run_bindings();
        let host_cycle_cap = host_cycle_cap.min(u64::MAX - bindings.now);
        let begins_outer_slice = self.run_coordinator.is_quiescent();
        match self
            .run_coordinator
            .begin_slice(bindings, host_cycle_cap, host_block_cap)
        {
            Ok(core_run::BeginSlice::Dispatch) => {
                if begins_outer_slice {
                    self.machine_evidence_outer_active = true;
                }
                // A prior hook exit cannot poison a newly authorized dispatcher segment.
                self.resident_context.control.clear_for_slice();
                self.run_coordinator.plan() as *const core_run::SealedRunPlan as usize as u32
            }
            Ok(core_run::BeginSlice::Outcome) | Err(_) => 0,
        }
    }

    #[cfg(target_arch = "wasm32")]
    fn current_core_run_outcome_ptr(&self) -> u32 {
        self.machine_exit
            .as_ref()
            .or_else(|| {
                self.disc_boot_blocks_cpu_dispatch()
                    .then_some(&self.disc_boot_wait_outcome)
            })
            .or_else(|| {
                self.host_render_request
                    .as_ref()
                    .map(|_| &self.render_wait_outcome)
            })
            .unwrap_or_else(|| self.run_coordinator.outcome()) as *const RunOutcome as usize
            as u32
    }

    /// Synchronizes instruction identity, then validates a retained hashed-page dependency.
    pub fn validate_instruction_page_dependency(
        &mut self,
        effective_page: u32,
        physical_page: u32,
    ) -> bool {
        let synchronized = self.runtime_hooks.synchronize_address_space(&self.system);
        if synchronized.outcome != HookOutcome::Complete {
            self.apply_hook_result(synchronized);
            return false;
        }
        validate_dependency(&mut self.system, effective_page, physical_page)
    }

    /// Applies cache ownership and resident-loop control effects for one shared Rust hook.
    fn apply_hook_result(&mut self, result: HookResult) -> HookOutcome {
        match result.outcome {
            HookOutcome::Complete => {}
            HookOutcome::Fault | HookOutcome::Yield => {
                self.resident_context.control.request_exit();
            }
            HookOutcome::Invalidated => {
                let removed = self
                    .cold_compile
                    .invalidate_where(|block| result.invalidation.selects(block));
                let pending = self
                    .cold_compile
                    .cancel_pending_where(|block| result.invalidation.selects(block.retained()));
                #[cfg(any(target_arch = "wasm32", test))]
                if let Some(pending) = pending {
                    let identity = self.pending_installable.as_ref().and_then(|installable| {
                        let identity = installable.identity();
                        (identity.table_slot == pending.table_slot
                            && identity.slot_nonce() == pending.slot_nonce)
                            .then_some(identity)
                    });
                    let discarded = self.discard_pending_installable_for_slot(pending);
                    let coordinator_cancelled = identity
                        .is_some_and(|identity| self.cancel_run_install_if_awaiting(identity))
                        || !self.run_coordinator.is_awaiting_install();
                    if !discarded || !coordinator_cancelled {
                        self.resident_context.control.request_exit();
                    }
                }
                #[cfg(target_arch = "wasm32")]
                {
                    let mut directory_ok = true;
                    for removed in removed {
                        directory_ok &= self.unpublish_indexed_block(removed);
                    }
                    if let Some(pending) = pending {
                        directory_ok &= self.unpublish_slot_identity(pending);
                    }
                    if !directory_ok {
                        self.resident_context.control.request_exit();
                    }
                }
                #[cfg(not(target_arch = "wasm32"))]
                let _ = (removed, pending);
                self.resident_context.control.request_exit();
            }
        }
        result.outcome
    }

    /// Terminally consumes the matching run-coordinator owner after another exact owner has
    /// already cancelled or committed the cold request.
    #[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
    fn cancel_run_install_if_awaiting(&mut self, identity: ResidentBlockInstallIdentity) -> bool {
        if !self.run_coordinator.is_awaiting_install() {
            return true;
        }
        if self.run_coordinator.install_cancelled(identity).is_err() {
            return false;
        }
        self.complete_machine_evidence_outer_slice();
        true
    }

    #[cfg(target_arch = "wasm32")]
    fn dispatch_cache_record(index: u32) -> Option<*mut DispatchCacheRecord> {
        let index = usize::try_from(index).ok()?;
        if index >= DISPATCH_ENTRY_CAPACITY {
            return None;
        }
        Some((DISPATCH_METADATA_OFFSET as *mut DispatchCacheRecord).wrapping_add(index))
    }

    #[cfg(target_arch = "wasm32")]
    fn dispatch_slot_record(table_slot: u32) -> Option<*mut DispatchSlotIdentityRecord> {
        let table_slot = usize::try_from(table_slot).ok()?;
        if table_slot >= DISPATCH_SLOT_CAPACITY {
            return None;
        }
        Some(
            (DISPATCH_SLOT_IDENTITY_OFFSET as *mut DispatchSlotIdentityRecord)
                .wrapping_add(table_slot),
        )
    }

    /// Makes one exact cache record unreachable before its table slot can be reused.
    #[cfg(target_arch = "wasm32")]
    fn unpublish_indexed_block(&mut self, removed: IndexedCachedBlock) -> bool {
        let Some(record) = Self::dispatch_cache_record(removed.directory_index) else {
            return false;
        };
        // SAFETY: The fixed record range is imported, aligned, machine-owned, and single-threaded.
        // Checking the complete live identity prevents a delayed retirement from clearing a newer
        // occupant. State zero is sufficient to make every remaining field unreachable.
        let current = unsafe { record.read_volatile() };
        let block = removed.block;
        if current.state != DISPATCH_ENTRY_READY
            || current.pc != block.pc.value()
            || current.address_space_generation() != block.generation.0
            || current.table_slot != block.table_slot
            || current.slot_nonce() != block.slot_nonce
        {
            return false;
        }
        unsafe { core::ptr::addr_of_mut!((*record).state).write_volatile(0) };
        self.unpublish_slot_identity(block.table_retirement())
    }

    /// Clears one exact slot identity without trusting a late retirement after slot reuse.
    #[cfg(target_arch = "wasm32")]
    fn unpublish_slot_identity(&mut self, retired: TableSlotRetirement) -> bool {
        let Some(record) = Self::dispatch_slot_record(retired.table_slot) else {
            return false;
        };
        // SAFETY: See `unpublish_indexed_block`. A pending/trapped self-install has no published
        // slot identity, so state zero is an already-safe success.
        let current = unsafe { record.read_volatile() };
        if current.state == 0 {
            return true;
        }
        if current.state != DISPATCH_SLOT_READY || current.slot_nonce() != retired.slot_nonce {
            return false;
        }
        unsafe { core::ptr::addr_of_mut!((*record).state).write_volatile(0) };
        true
    }

    /// Publishes the exact function-slot identity, then the matching cache entry last.
    #[cfg(target_arch = "wasm32")]
    fn publish_completed_compile(&mut self, completed: CompletedCompile) -> bool {
        if let Some(evicted) = completed.evicted {
            if !self.unpublish_indexed_block(evicted) {
                return false;
            }
            if completed.retired_slot != Some(evicted.block.table_retirement()) {
                return false;
            }
        } else if completed.retired_slot.is_some() {
            return false;
        }

        let block = completed.block;
        if completed.directory_index % 4 != u32::from(completed.way) {
            return false;
        }
        let dependencies: [DispatchDependency; 2] =
            core::array::from_fn(|index| {
                block.dependencies().get(index).map_or(
                    DispatchDependency::default(),
                    |dependency| DispatchDependency {
                        effective_page: dependency.effective.value(),
                        physical_page: dependency.physical.value(),
                    },
                )
            });
        let Some(cache) = DispatchCacheRecord::unpublished_basic_block(
            block.pc.value(),
            block.generation.0,
            block.table_slot,
            block.slot_nonce,
            block.maximum_cycles,
            block.maximum_instructions,
            &dependencies[..block.dependencies().len()],
        ) else {
            return false;
        };
        let slot = DispatchSlotIdentityRecord::unpublished(
            block.pc.value(),
            block.generation.0,
            block.slot_nonce,
        );
        let Some(cache_record) = Self::dispatch_cache_record(completed.directory_index) else {
            return false;
        };
        let Some(slot_record) = Self::dispatch_slot_record(block.table_slot) else {
            return false;
        };

        // SAFETY: Both records are fixed, aligned, non-overlapping machine reservations. The
        // self-installer already wrote the function table. Publish its full slot identity first;
        // only the cache READY store can make the function executable by the dispatcher.
        unsafe {
            cache_record.write_volatile(DispatchCacheRecord::default());
            slot_record.write_volatile(slot);
            core::ptr::addr_of_mut!((*slot_record).state).write_volatile(DISPATCH_SLOT_READY);
            cache_record.write_volatile(cache);
            core::ptr::addr_of_mut!((*cache_record).state).write_volatile(DISPATCH_ENTRY_READY);
        }
        true
    }

    /// Applies identities returned by cold preparation before its request becomes host-visible.
    #[cfg(target_arch = "wasm32")]
    fn apply_cold_compile_retirements(&mut self, retirements: &ColdCompileRetirements) -> bool {
        let mut valid = true;
        for removed in retirements.blocks.iter().copied() {
            valid &= self.unpublish_indexed_block(removed);
        }
        if let Some(retired) = retirements.reclaimed_slot {
            valid &= self.unpublish_slot_identity(retired);
        }
        if let Some(cancelled) = retirements.cancelled_preparation {
            valid &= self.unpublish_slot_identity(cancelled);
        }
        valid
    }

    #[cfg(target_arch = "wasm32")]
    fn map_self_install_error(&mut self, error: SelfInstallError) -> ResidentInstallStatus {
        match error {
            SelfInstallError::NoPendingRequest => ResidentInstallStatus::NoPendingRequest,
            SelfInstallError::IdentityMismatch => ResidentInstallStatus::IdentityMismatch,
            SelfInstallError::InvalidPhase => ResidentInstallStatus::InvalidPhase,
            SelfInstallError::AddressSpaceChanged { retired_slot, .. } => {
                self.discard_pending_installable_for_slot(retired_slot);
                if !self.unpublish_slot_identity(retired_slot) {
                    self.resident_context.control.request_exit();
                }
                ResidentInstallStatus::AddressSpaceChanged
            }
        }
    }

    #[cfg(target_arch = "wasm32")]
    fn begin_resident_block_install(
        &mut self,
        identity: ResidentBlockInstallIdentity,
    ) -> ResidentInstallStatus {
        let synchronized = self.runtime_hooks.synchronize_address_space(&self.system);
        self.apply_hook_result(synchronized);
        let generation = self.runtime_hooks.current_generation();
        match self.cold_compile.begin_self_install(identity, generation) {
            Ok(()) => ResidentInstallStatus::Authorized,
            Err(error) => {
                let status = self.map_self_install_error(error);
                if status == ResidentInstallStatus::AddressSpaceChanged
                    && self.run_coordinator.is_awaiting_install()
                    && self.run_coordinator.install_cancelled(identity).is_ok()
                {
                    self.complete_machine_evidence_outer_slice();
                }
                status
            }
        }
    }

    /// Cancels only the exact Rust-issued module after a host compile/instantiate/install failure.
    #[cfg(target_arch = "wasm32")]
    fn cancel_resident_block_install(
        &mut self,
        identity: ResidentBlockInstallIdentity,
    ) -> ResidentInstallStatus {
        let retired = match self.cold_compile.cancel_self_install(identity) {
            Ok(retired) => retired,
            Err(error) => return self.map_self_install_error(error),
        };
        if !self.discard_pending_installable(identity) || !self.unpublish_slot_identity(retired) {
            self.resident_context.control.request_exit();
            return ResidentInstallStatus::TableUnavailable;
        }
        if self.run_coordinator.is_awaiting_install() {
            if self.run_coordinator.install_cancelled(identity).is_err() {
                self.resident_context.control.request_exit();
                return ResidentInstallStatus::TableUnavailable;
            }
            self.complete_machine_evidence_outer_slice();
        }
        self.resident_context.control.request_exit();
        ResidentInstallStatus::Cancelled
    }

    #[cfg(target_arch = "wasm32")]
    fn commit_resident_block_install(
        &mut self,
        identity: ResidentBlockInstallIdentity,
    ) -> ResidentInstallStatus {
        let synchronized = self.runtime_hooks.synchronize_address_space(&self.system);
        self.apply_hook_result(synchronized);
        let generation = self.runtime_hooks.current_generation();
        let completed = match self.cold_compile.commit_self_install(identity, generation) {
            Ok(completed) => completed,
            Err(error) => {
                let status = self.map_self_install_error(error);
                if status == ResidentInstallStatus::AddressSpaceChanged
                    && self.run_coordinator.is_awaiting_install()
                    && self.run_coordinator.install_cancelled(identity).is_ok()
                {
                    self.complete_machine_evidence_outer_slice();
                }
                return status;
            }
        };
        let published = self.publish_completed_compile(completed);
        let discarded = self.discard_pending_installable(identity);
        let coordinator_was_awaiting = self.run_coordinator.is_awaiting_install();
        let coordinator_committed = published
            && discarded
            && (!coordinator_was_awaiting
                || self.run_coordinator.install_committed(identity).is_ok());
        if coordinator_committed {
            ResidentInstallStatus::Committed
        } else {
            if coordinator_was_awaiting && self.run_coordinator.is_awaiting_install() {
                let _ = self.cancel_run_install_if_awaiting(identity);
            }
            self.host_compile_request = None;
            if let Some(removed) = self
                .cold_compile
                .invalidate(completed.block.generation, completed.block.pc)
            {
                let _ = self.unpublish_indexed_block(removed);
            }
            self.resident_context.control.request_exit();
            ResidentInstallStatus::TableUnavailable
        }
    }
}

/// Resolves one dependency with the architected instruction MMU and accepts hashed pages only.
///
/// Translation is deliberately performed before comparing the retained physical page. A valid
/// walk therefore fills/touches the ITLB and sets the PTE referenced bit exactly like a real
/// instruction fetch. Real-mode and BAT results are not dependencies and fail closed here.
fn validate_dependency(system: &mut System, effective_page: u32, physical_page: u32) -> bool {
    if effective_page & PAGE_MASK != 0 || physical_page & PAGE_MASK != 0 {
        return false;
    }

    let Ok(mapping) =
        system.translate_instruction_mmu(Address(effective_page), TranslationEffect::Architectural)
    else {
        return false;
    };

    matches!(mapping.source, TranslationSource::Page(_))
        && mapping.effective == effective_page
        && mapping.physical == physical_page
}

#[cfg(any(target_arch = "wasm32", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SlotPhase {
    Empty,
    Initializing,
    Ready,
    Entered,
}

#[cfg(any(target_arch = "wasm32", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InitAttempt<E> {
    Initialized,
    AlreadyInitialized,
    Reentrant,
    Failed(E),
}

/// Single-thread exclusive owner for the browser machine.
///
/// The separate phase cell is checked before the value cell is touched, so recursive calls fail
/// without creating a second mutable reference. This type is `Sync` only for wasm32, whose core
/// is instantiated and called on one browser worker thread.
#[cfg(any(target_arch = "wasm32", test))]
struct ExclusiveSlot<T> {
    phase: UnsafeCell<SlotPhase>,
    value: UnsafeCell<MaybeUninit<T>>,
}

#[cfg(any(target_arch = "wasm32", test))]
impl<T> ExclusiveSlot<T> {
    const fn empty() -> Self {
        Self {
            phase: UnsafeCell::new(SlotPhase::Empty),
            value: UnsafeCell::new(MaybeUninit::uninit()),
        }
    }

    fn try_init<E>(&self, initialize: impl FnOnce() -> Result<T, E>) -> InitAttempt<E> {
        // SAFETY: Callers obey the slot's single-thread contract. Reading the Copy phase does not
        // access `value`, including while an outer guarded call holds the value exclusively.
        match unsafe { *self.phase.get() } {
            SlotPhase::Ready => return InitAttempt::AlreadyInitialized,
            SlotPhase::Initializing | SlotPhase::Entered => return InitAttempt::Reentrant,
            SlotPhase::Empty => {}
        }

        // Publish the guard before running initialization so recursive init/use calls fail closed.
        unsafe { self.phase.get().write(SlotPhase::Initializing) };
        let mut guard = PhaseGuard::new(self.phase.get(), SlotPhase::Empty);
        let value = match initialize() {
            Ok(value) => value,
            Err(error) => return InitAttempt::Failed(error),
        };

        // SAFETY: Empty -> Initializing is exclusive, and failed initialization restores Empty.
        // This is the sole write that initializes `value` before Ready is published.
        unsafe {
            self.value.get().write(MaybeUninit::new(value));
            self.phase.get().write(SlotPhase::Ready);
        }
        guard.disarm();
        InitAttempt::Initialized
    }

    fn with<R>(&self, use_value: impl FnOnce(&mut T) -> R) -> Option<R> {
        // SAFETY: See `try_init`. Recursive calls observe Entered and never touch `value`.
        if unsafe { *self.phase.get() } != SlotPhase::Ready {
            return None;
        }

        unsafe { self.phase.get().write(SlotPhase::Entered) };
        let _guard = PhaseGuard::new(self.phase.get(), SlotPhase::Ready);
        // SAFETY: Ready means the value is initialized. Entered prevents another access until the
        // guard restores Ready, including during unwinding in native tests.
        Some(use_value(unsafe {
            (&mut *self.value.get()).assume_init_mut()
        }))
    }
}

#[cfg(any(target_arch = "wasm32", test))]
impl<T> Drop for ExclusiveSlot<T> {
    fn drop(&mut self) {
        if matches!(*self.phase.get_mut(), SlotPhase::Ready | SlotPhase::Entered) {
            // SAFETY: `&mut self` guarantees there is no active access, and these phases mean the
            // value was initialized exactly once.
            unsafe { self.value.get_mut().assume_init_drop() };
        }
    }
}

#[cfg(any(target_arch = "wasm32", test))]
struct PhaseGuard {
    phase: *mut SlotPhase,
    restore: SlotPhase,
    armed: bool,
}

#[cfg(any(target_arch = "wasm32", test))]
impl PhaseGuard {
    fn new(phase: *mut SlotPhase, restore: SlotPhase) -> Self {
        Self {
            phase,
            restore,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

#[cfg(any(target_arch = "wasm32", test))]
impl Drop for PhaseGuard {
    fn drop(&mut self) {
        if self.armed {
            // SAFETY: The guard is created only after its owner exclusively transitions `phase`.
            unsafe { self.phase.write(self.restore) };
        }
    }
}

#[cfg(target_arch = "wasm32")]
// SAFETY: A browser-machine instance is created and synchronously entered on one Web Worker. The
// guard rejects same-thread reentrancy. This impl must be revisited before enabling wasm threads.
unsafe impl Sync for ExclusiveSlot<BrowserMachine> {}

macro_rules! layout_getters {
    ($(($name:ident, $value:expr)),+ $(,)?) => {
        $(
            #[unsafe(no_mangle)]
            pub extern "C" fn $name() -> u32 {
                $value as u32
            }
        )+
    };
}

layout_getters! {
    (core_abi_version, ABI_VERSION),
    (core_compile_request_bytes, core::mem::size_of::<lazuli_abi::CompileRequest>()),
    (core_host_request_bytes, core::mem::size_of::<HostRequest>()),
    (core_host_completion_bytes, core::mem::size_of::<HostCompletion>()),
    (core_render_receipt_bytes, core::mem::size_of::<RenderReceipt>()),
    (core_capture_authority_bytes, core::mem::size_of::<CaptureAuthorityV2>()),
    (core_disc_boot_max_chunk_bytes, MAX_BOOT_LOAD_CHUNK_BYTES),
    (core_di_max_chunk_bytes, MAX_COMMITTED_DISC_READ_BYTES),
    (core_memory_initial_pages, RESIDENT_MEMORY_INITIAL_PAGES),
    (core_memory_maximum_pages, RESIDENT_MEMORY_MAXIMUM_PAGES),
    (core_memory_bytes, RESIDENT_MEMORY_BYTES),
    (core_dispatch_metadata_offset, DISPATCH_METADATA_OFFSET),
    (core_dispatch_metadata_bytes, DISPATCH_METADATA_BYTES),
    (core_dispatch_entry_capacity, DISPATCH_ENTRY_CAPACITY),
    (core_dispatch_slot_identity_offset, DISPATCH_SLOT_IDENTITY_OFFSET),
    (core_dispatch_slot_identity_bytes, DISPATCH_SLOT_IDENTITY_BYTES),
    (core_dispatch_slot_capacity, DISPATCH_SLOT_CAPACITY),
    (core_dispatch_reserved_end, DISPATCH_RESERVED_END),
    (core_resident_context_bytes, RESIDENT_CONTEXT_BYTES),
    (core_resident_stack_scratch_offset, RESIDENT_STACK_SCRATCH_OFFSET),
    (core_resident_stack_scratch_bytes, RESIDENT_STACK_SCRATCH_BYTES),
    (core_main_ram_offset, MAIN_RAM_OFFSET),
    (core_main_ram_bytes, MAIN_RAM_BYTES),
    (core_mmio_offset, MMIO_OFFSET),
    (core_mmio_bytes, MMIO_BYTES),
    (core_l2c_offset, L2C_OFFSET),
    (core_l2c_bytes, L2C_BYTES),
    (core_machine_reserved_end, MACHINE_RESERVED_END),
    (core_ipl_offset, IPL_OFFSET),
    (core_ipl_bytes, IPL_BYTES),
    (core_aram_offset, ARAM_OFFSET),
    (core_aram_bytes, ARAM_BYTES),
    (core_runtime_base, RUNTIME_BASE),
    (core_runtime_end, RESIDENT_RUNTIME_END),
}

#[cfg(target_arch = "wasm32")]
mod wasm_abi {
    use core::arch::wasm32::memory_size;
    use core::mem::{align_of, size_of};

    use lazuli::gekko::QuantReg;
    use lazuli::runtime_hooks::{HookOutcome, HookResult, MachineRuntimeHooks};
    use lazuli::system::dspi::ARAM_LEN;
    use lazuli::system::mem::{IPL_LEN, L2C_LEN, RAM_LEN};
    use lazuli::{Address, Primitive};
    use lazuli_abi::{
        HostCompletion, HostRequest, MachineEvidenceV1, RecordHeader, SharedPtr, SharedSlice,
    };

    use super::{
        ARAM_OFFSET, BrowserDiCallResult, BrowserInputPublication, BrowserMachine,
        BrowserRenderCompletion, DISPATCH_METADATA_BYTES, DISPATCH_METADATA_OFFSET,
        DISPATCH_SLOT_IDENTITY_BYTES, DISPATCH_SLOT_IDENTITY_OFFSET, ExclusiveSlot, IPL_OFFSET,
        InitAttempt, L2C_OFFSET, MAIN_RAM_OFFSET, MappedMemoryBacking, MappedSystemBacking,
        RESIDENT_CONTEXT_BYTES, RESIDENT_MEMORY_INITIAL_PAGES, RESIDENT_STACK_SCRATCH_BYTES,
        RESIDENT_STACK_SCRATCH_OFFSET, ReadRequest, ResidentEventService, ResidentI32Read,
        ResidentMachineExitDetail, core_run, mapped_system,
        synchronize_resident_instruction_stream,
    };
    use crate::disc_boot::{BrowserDiscBootCallResult, BrowserDiscBootStatus};

    const INIT_ALREADY_INITIALIZED: u32 = 0;
    const INIT_OK: u32 = 1;
    const INIT_WRONG_MEMORY_SIZE: u32 = 2;
    const INIT_REENTRANT: u32 = 3;
    const INIT_INVALID_RUNTIME_LAYOUT: u32 = 4;

    static MACHINE: ExclusiveSlot<BrowserMachine> = ExclusiveSlot::empty();

    #[derive(Debug, Clone, Copy)]
    enum CoreInitError {
        WrongMemorySize,
        InvalidRuntimeLayout,
    }

    unsafe fn mapped_array<const N: usize>(offset: usize) -> &'static mut [u8; N] {
        // SAFETY: `core_init` calls this once. ABI layout constants make the four ranges exact,
        // in-bounds at the imported minimum, and pairwise disjoint. MACHINE retains sole Rust
        // ownership for the lifetime of this Wasm instance.
        unsafe { &mut *(offset as *mut [u8; N]) }
    }

    unsafe fn clear_dispatch_directory() {
        // SAFETY: Both ABI-owned reservations are in-bounds at the imported minimum, disjoint
        // from each other, and below every mapped architected window. Zero is the canonical
        // unpublished state for DispatchCacheRecord and DispatchSlotIdentityRecord.
        unsafe {
            core::ptr::write_bytes(
                DISPATCH_METADATA_OFFSET as *mut u8,
                0,
                DISPATCH_METADATA_BYTES,
            );
            core::ptr::write_bytes(
                DISPATCH_SLOT_IDENTITY_OFFSET as *mut u8,
                0,
                DISPATCH_SLOT_IDENTITY_BYTES,
            );
        }
    }

    fn initialize_mapped_system() -> Result<BrowserMachine, CoreInitError> {
        if memory_size::<0>() != RESIDENT_MEMORY_INITIAL_PAGES {
            return Err(CoreInitError::WrongMemorySize);
        }

        // SAFETY: The initialization phase is visible before this function is called, so no
        // validator or second initializer can observe a partially cleared Rust-owned directory.
        unsafe { clear_dispatch_directory() };

        // SAFETY: The initialization guard is already published and the fixed ranges do not
        // overlap. No other export can reach them until the complete System is Ready.
        let (ram, l2c, ipl, aram) = unsafe {
            (
                mapped_array::<RAM_LEN>(MAIN_RAM_OFFSET),
                mapped_array::<L2C_LEN>(L2C_OFFSET),
                mapped_array::<IPL_LEN>(IPL_OFFSET),
                mapped_array::<ARAM_LEN>(ARAM_OFFSET),
            )
        };
        let memory = MappedMemoryBacking::new(ram, l2c, ipl);
        BrowserMachine::from_system(mapped_system(MappedSystemBacking::new(memory, aram)))
            .ok_or(CoreInitError::InvalidRuntimeLayout)
    }

    /// Initializes the sole Rust browser machine over preloaded fixed memory windows.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_init() -> u32 {
        match MACHINE.try_init(initialize_mapped_system) {
            InitAttempt::Initialized => INIT_OK,
            InitAttempt::AlreadyInitialized => INIT_ALREADY_INITIALIZED,
            InitAttempt::Reentrant => INIT_REENTRANT,
            InitAttempt::Failed(CoreInitError::WrongMemorySize) => INIT_WRONG_MEMORY_SIZE,
            InitAttempt::Failed(CoreInitError::InvalidRuntimeLayout) => INIT_INVALID_RUNTIME_LAYOUT,
        }
    }

    /// Exact byte width of the immutable generic evidence record returned by this ABI.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_machine_evidence_bytes() -> u32 {
        size_of::<MachineEvidenceV1>() as u32
    }

    /// Copies one coherent Rust-owned evidence snapshot and returns its stable linear-memory
    /// address. The prior snapshot remains immutable until this export is called again.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_machine_evidence_snapshot() -> u32 {
        MACHINE
            .with(|machine| {
                machine.machine_evidence_snapshot().map_or(0, |snapshot| {
                    snapshot as *const MachineEvidenceV1 as usize as u32
                })
            })
            .unwrap_or(0)
    }

    /// Exact byte width of the optional opaque title-fidelity record.
    #[cfg(feature = "game-fidelity-probes")]
    #[unsafe(no_mangle)]
    pub extern "C" fn core_game_fidelity_bytes() -> u32 {
        super::GAME_FIDELITY_RECORD_BYTES as u32
    }

    /// Fixed Rust-selected button request. Nonzero only after a transactional baseline arm and
    /// until an exact typed SI publication is accepted.
    #[cfg(feature = "game-fidelity-probes")]
    #[unsafe(no_mangle)]
    pub extern "C" fn core_game_fidelity_requested_buttons() -> u32 {
        MACHINE
            .with(BrowserMachine::game_fidelity_requested_buttons)
            .unwrap_or(0)
    }

    /// Exact Rust-selected packed stick lanes in `stick_x, stick_y, c_stick_x, c_stick_y` order.
    /// Zero is returned whenever no transactional baseline is awaiting its witness.
    #[cfg(feature = "game-fidelity-probes")]
    #[unsafe(no_mangle)]
    pub extern "C" fn core_game_fidelity_requested_stick_xy_cxy() -> u32 {
        MACHINE
            .with(BrowserMachine::game_fidelity_requested_stick_xy_cxy)
            .unwrap_or(0)
    }

    /// Exact Rust-selected packed trigger lanes in `trigger_l, trigger_r, analog_a, analog_b`
    /// order. Zero is returned whenever no transactional baseline is awaiting its witness.
    #[cfg(feature = "game-fidelity-probes")]
    #[unsafe(no_mangle)]
    pub extern "C" fn core_game_fidelity_requested_trigger_lrab() -> u32 {
        MACHINE
            .with(BrowserMachine::game_fidelity_requested_trigger_lrab)
            .unwrap_or(0)
    }

    /// Current reduced projector phase. Zero also represents an uninitialized or unsupported core.
    #[cfg(feature = "game-fidelity-probes")]
    #[unsafe(no_mangle)]
    pub extern "C" fn core_game_fidelity_phase() -> u32 {
        MACHINE
            .with(BrowserMachine::game_fidelity_phase)
            .unwrap_or(0)
    }

    /// Copies one opaque reduced record and returns its stable Rust-owned linear-memory pointer.
    #[cfg(feature = "game-fidelity-probes")]
    #[unsafe(no_mangle)]
    pub extern "C" fn core_game_fidelity_snapshot() -> u32 {
        MACHINE
            .with(|machine| {
                machine
                    .game_fidelity_snapshot()
                    .map_or(0, |snapshot| snapshot.as_ptr() as usize as u32)
            })
            .unwrap_or(0)
    }

    /// Exercises one transient Rust-owned allocation without exposing its pointer to the host.
    ///
    /// This contract probe models atomic disc/GX payload retention. A successful allocation may
    /// grow linear memory, so browser adapters must reacquire every `memory.buffer`-backed view
    /// after the call. The allocation is dropped before returning and does not mutate machine
    /// state.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_resident_allocation_probe(bytes: u32) -> u32 {
        if bytes == 0 {
            return 0;
        }
        MACHINE
            .with(|_| {
                let bytes = bytes as usize;
                let mut allocation = Vec::<u8>::new();
                if allocation.try_reserve_exact(bytes).is_err() {
                    return 0;
                }
                allocation.resize(bytes, 0xa5);
                std::hint::black_box((allocation[0], allocation[bytes - 1]));
                1
            })
            .unwrap_or(0)
    }

    fn join_u64(lo: u32, hi: u32) -> u64 {
        u64::from(lo) | (u64::from(hi) << 32)
    }

    fn disc_read_request(
        epoch_lo: u32,
        epoch_hi: u32,
        id_lo: u32,
        id_hi: u32,
        container_offset_lo: u32,
        container_offset_hi: u32,
        length: u32,
    ) -> ReadRequest {
        ReadRequest {
            epoch: join_u64(epoch_lo, epoch_hi),
            id: join_u64(id_lo, id_hi),
            container_offset: join_u64(container_offset_lo, container_offset_hi),
            length,
        }
    }

    /// Starts one Rust-owned ISO/CISO boot epoch. The browser supplies only container length.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_disc_boot_begin(
        container_bytes_lo: u32,
        container_bytes_hi: u32,
    ) -> u32 {
        MACHINE
            .with(|machine| {
                machine
                    .begin_disc_boot(join_u64(container_bytes_lo, container_bytes_hi))
                    .map_or_else(
                        |error| error.call_result() as u32,
                        |_| BrowserDiscBootCallResult::Accepted as u32,
                    )
            })
            .unwrap_or(BrowserDiscBootCallResult::Rejected as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_disc_boot_cancel() -> u32 {
        MACHINE
            .with(|machine| machine.cancel_disc_boot() as u32)
            .unwrap_or(0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_disc_boot_status() -> u32 {
        MACHINE
            .with(|machine| machine.disc_boot().status() as u32)
            .unwrap_or(BrowserDiscBootStatus::Idle as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_disc_boot_fault() -> u32 {
        MACHINE
            .with(|machine| machine.disc_boot().fault_code() as u32)
            .unwrap_or(0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_disc_boot_pending_count() -> u32 {
        MACHINE
            .with(|machine| u32::try_from(machine.disc_boot().pending_count()).unwrap_or(u32::MAX))
            .unwrap_or(0)
    }

    fn disc_request_at(index: u32) -> Option<ReadRequest> {
        MACHINE
            .with(|machine| machine.disc_boot_request(index as usize))
            .flatten()
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_disc_boot_request_epoch_lo(index: u32) -> u32 {
        disc_request_at(index).map_or(0, |request| request.epoch as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_disc_boot_request_epoch_hi(index: u32) -> u32 {
        disc_request_at(index).map_or(0, |request| (request.epoch >> 32) as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_disc_boot_request_id_lo(index: u32) -> u32 {
        disc_request_at(index).map_or(0, |request| request.id as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_disc_boot_request_id_hi(index: u32) -> u32 {
        disc_request_at(index).map_or(0, |request| (request.id >> 32) as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_disc_boot_request_container_offset_lo(index: u32) -> u32 {
        disc_request_at(index).map_or(0, |request| request.container_offset as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_disc_boot_request_container_offset_hi(index: u32) -> u32 {
        disc_request_at(index).map_or(0, |request| (request.container_offset >> 32) as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_disc_boot_request_length(index: u32) -> u32 {
        disc_request_at(index).map_or(0, |request| request.length)
    }

    /// Returns a staging pointer only after reauthenticating the complete copied descriptor.
    /// The adapter must copy fetched bytes and call `core_disc_boot_complete` synchronously before
    /// yielding; no pointer is retained by this ABI across its asynchronous range fetch.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_disc_boot_staging_ptr(
        epoch_lo: u32,
        epoch_hi: u32,
        id_lo: u32,
        id_hi: u32,
        container_offset_lo: u32,
        container_offset_hi: u32,
        length: u32,
    ) -> u32 {
        let request = disc_read_request(
            epoch_lo,
            epoch_hi,
            id_lo,
            id_hi,
            container_offset_lo,
            container_offset_hi,
            length,
        );
        MACHINE
            .with(|machine| {
                machine
                    .disc_boot_staging_mut(request)
                    .ok()
                    .filter(|staging| staging.len() == request.length as usize)
                    .map_or(0, |staging| staging.as_mut_ptr() as usize as u32)
            })
            .unwrap_or(0)
    }

    /// Consumes one exact descriptor after its staging bytes were filled synchronously.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_disc_boot_complete(
        epoch_lo: u32,
        epoch_hi: u32,
        id_lo: u32,
        id_hi: u32,
        container_offset_lo: u32,
        container_offset_hi: u32,
        length: u32,
        written: u32,
    ) -> u32 {
        let request = disc_read_request(
            epoch_lo,
            epoch_hi,
            id_lo,
            id_hi,
            container_offset_lo,
            container_offset_hi,
            length,
        );
        MACHINE
            .with(
                |machine| match machine.complete_disc_boot(request, written) {
                    Ok(progress) if progress.status == BrowserDiscBootStatus::Committed => {
                        BrowserDiscBootCallResult::Committed as u32
                    }
                    Ok(_) => BrowserDiscBootCallResult::Accepted as u32,
                    Err(error) => error.call_result() as u32,
                },
            )
            .unwrap_or(BrowserDiscBootCallResult::Rejected as u32)
    }

    fn di_request_at(index: u32) -> Option<ReadRequest> {
        if index != 0 {
            return None;
        }
        MACHINE
            .with(|machine| match machine.di_read_request() {
                Ok(request) => request,
                Err(_) => {
                    machine.publish_machine_exit(ResidentMachineExitDetail::DiskAdapterError);
                    None
                }
            })
            .flatten()
    }

    /// Resident DI has exactly one sequential physical request in flight.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_di_pending_count() -> u32 {
        u32::from(di_request_at(0).is_some())
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_di_request_epoch_lo(index: u32) -> u32 {
        di_request_at(index).map_or(0, |request| request.epoch as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_di_request_epoch_hi(index: u32) -> u32 {
        di_request_at(index).map_or(0, |request| (request.epoch >> 32) as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_di_request_id_lo(index: u32) -> u32 {
        di_request_at(index).map_or(0, |request| request.id as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_di_request_id_hi(index: u32) -> u32 {
        di_request_at(index).map_or(0, |request| (request.id >> 32) as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_di_request_container_offset_lo(index: u32) -> u32 {
        di_request_at(index).map_or(0, |request| request.container_offset as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_di_request_container_offset_hi(index: u32) -> u32 {
        di_request_at(index).map_or(0, |request| (request.container_offset >> 32) as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_di_request_length(index: u32) -> u32 {
        di_request_at(index).map_or(0, |request| request.length)
    }

    /// Reauthenticates a copied physical request after await and returns only its exact DI-owned
    /// payload sub-slice. The caller must copy and complete synchronously before yielding.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_di_staging_ptr(
        epoch_lo: u32,
        epoch_hi: u32,
        id_lo: u32,
        id_hi: u32,
        container_offset_lo: u32,
        container_offset_hi: u32,
        length: u32,
    ) -> u32 {
        let request = disc_read_request(
            epoch_lo,
            epoch_hi,
            id_lo,
            id_hi,
            container_offset_lo,
            container_offset_hi,
            length,
        );
        MACHINE
            .with(|machine| {
                machine
                    .di_read_staging_mut(request)
                    .ok()
                    .filter(|staging| staging.len() == request.length as usize)
                    .map_or(0, |staging| staging.as_mut_ptr() as usize as u32)
            })
            .unwrap_or(0)
    }

    /// Consumes one physical receipt. `status_raw` is a checked `HostCompletionStatus` integer;
    /// known failures become delayed DI device errors and unknown values leave the request live.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_di_complete(
        epoch_lo: u32,
        epoch_hi: u32,
        id_lo: u32,
        id_hi: u32,
        container_offset_lo: u32,
        container_offset_hi: u32,
        length: u32,
        written: u32,
        status_raw: u32,
    ) -> u32 {
        let request = disc_read_request(
            epoch_lo,
            epoch_hi,
            id_lo,
            id_hi,
            container_offset_lo,
            container_offset_hi,
            length,
        );
        MACHINE
            .with(|machine| {
                machine
                    .complete_di_read(request, written, status_raw)
                    .map_or_else(|error| error.call_result() as u32, |result| result as u32)
            })
            .unwrap_or(BrowserDiCallResult::Rejected as u32)
    }

    /// Contract-only 24 MiB allocation entry. Production artifacts omit this semantic bypass.
    #[cfg(feature = "di-contract-probes")]
    #[unsafe(no_mangle)]
    pub extern "C" fn core_di_probe_begin_maximum() -> u32 {
        MACHINE
            .with(|machine| machine.begin_maximum_di_probe() as u32)
            .unwrap_or(0)
    }

    #[cfg(feature = "di-contract-probes")]
    #[unsafe(no_mangle)]
    pub extern "C" fn core_di_probe_finish_maximum() -> u32 {
        MACHINE
            .with(|machine| machine.finish_maximum_di_probe() as u32)
            .unwrap_or(0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_di_resident_payload_bytes() -> u32 {
        MACHINE
            .with(|machine| {
                u32::try_from(machine.system.disk.resident_payload_bytes()).unwrap_or(u32::MAX)
            })
            .unwrap_or(0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_di_resident_payload_capacity_bytes() -> u32 {
        MACHINE
            .with(|machine| {
                u32::try_from(machine.system.disk.resident_payload_capacity_bytes())
                    .unwrap_or(u32::MAX)
            })
            .unwrap_or(0)
    }

    /// Publishes one host-normalized controller sample without lending JS any SI queue, timing,
    /// mailbox, or packet semantics. Packed byte lanes are documented by
    /// [`BrowserMachine::publish_controller_input`].
    #[unsafe(no_mangle)]
    pub extern "C" fn core_input_publish(
        sequence_lo: u32,
        sequence_hi: u32,
        buttons: u32,
        stick_xy_cxy: u32,
        trigger_lrab: u32,
    ) -> u32 {
        MACHINE
            .with(|machine| {
                machine.publish_controller_input(
                    sequence_lo,
                    sequence_hi,
                    buttons,
                    stick_xy_cxy,
                    trigger_lrab,
                ) as u32
            })
            .unwrap_or(BrowserInputPublication::Rejected as u32)
    }

    /// Issues one atomic Rust-owned scheduler/SI capture record in stable machine storage.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_capture_authority_snapshot() -> *const u8 {
        MACHINE
            .with(|machine| {
                machine
                    .capture_authority_snapshot()
                    .map_or(core::ptr::null(), |snapshot| {
                        core::ptr::from_ref(snapshot).cast()
                    })
            })
            .unwrap_or(core::ptr::null())
    }

    /// Returns the number of exact renderer operations retained by Rust.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_render_pending_count() -> u32 {
        MACHINE
            .with(|machine| u32::try_from(machine.pending_render_requests()).unwrap_or(u32::MAX))
            .unwrap_or(0)
    }

    /// Publishes the current copied HostRequest record. The browser copies the record before
    /// suspension; it must not retain this pointer or any typed view across an await.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_render_request_ptr() -> u32 {
        MACHINE
            .with(|machine| {
                if !machine.refresh_render_wait_request() {
                    return 0;
                }
                machine
                    .host_render_request
                    .as_ref()
                    .map_or(0, |request| request as *const HostRequest as usize as u32)
            })
            .unwrap_or(0)
    }

    /// Reconstructs and reauthenticates the complete copied request after the host filled the
    /// Rust-issued receipt range. No host-authored pointer or semantic commit plan is accepted.
    #[allow(clippy::too_many_arguments)]
    #[unsafe(no_mangle)]
    pub extern "C" fn core_render_complete(
        request_abi_version: u32,
        request_byte_len: u32,
        request_id: u32,
        request_nonce_lo: u32,
        request_nonce_hi: u32,
        kind_raw: u32,
        flags: u32,
        address: u32,
        length: u32,
        payload_ptr: u32,
        payload_len: u32,
        arg0: u32,
        arg1: u32,
        status_raw: u32,
        filled_len: u32,
    ) -> u32 {
        let request = HostRequest {
            header: RecordHeader {
                abi_version: request_abi_version,
                byte_len: request_byte_len,
            },
            request_id,
            request_nonce_lo,
            request_nonce_hi,
            kind_raw,
            flags,
            address,
            length,
            payload: SharedSlice {
                ptr: SharedPtr(payload_ptr),
                len: payload_len,
            },
            arg0,
            arg1,
        };
        let completion = HostCompletion {
            header: RecordHeader::for_record::<HostCompletion>(),
            request_id,
            request_nonce_lo,
            request_nonce_hi,
            status_raw,
            filled_len,
            reserved: 0,
            value_lo: 0,
            value_hi: 0,
        };
        MACHINE
            .with(
                |machine| match machine.complete_render_request(request, completion) {
                    Ok(BrowserRenderCompletion::Committed) => 1,
                    Ok(BrowserRenderCompletion::Failed) => 2,
                    Err(_) => 0,
                },
            )
            .unwrap_or(0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_address_space_generation_lo() -> u32 {
        MACHINE
            .with(|machine| {
                machine
                    .current_generation()
                    .map(|generation| generation.0 as u32)
            })
            .flatten()
            .unwrap_or(0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_address_space_generation_hi() -> u32 {
        MACHINE
            .with(|machine| {
                machine
                    .current_generation()
                    .map(|generation| (generation.0 >> 32) as u32)
            })
            .flatten()
            .unwrap_or(0)
    }

    /// Opaque Rust-machine context supplied to generated blocks by the resident dispatcher.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_context_ptr() -> u32 {
        MACHINE.with(BrowserMachine::context_ptr).unwrap_or(0)
    }

    /// Canonical `gekko::Cpu` pointer supplied to generated blocks by the resident dispatcher.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_cpu_ptr() -> u32 {
        MACHINE.with(BrowserMachine::cpu_ptr).unwrap_or(0)
    }

    /// Current conservative primary fast-memory LUT supplied to generated blocks.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_fastmem_ptr() -> u32 {
        MACHINE.with(BrowserMachine::fastmem_ptr).unwrap_or(0)
    }

    /// Issues a one-use Rust-owned dispatcher plan. Browser code can only reduce the upper caps.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_begin_slice(host_cycle_cap: u64, host_block_cap: u32) -> u32 {
        MACHINE
            .with(|machine| machine.begin_core_run_slice(host_cycle_cap, host_block_cap))
            .unwrap_or(0)
    }

    /// Returns the stable current outcome for a begin that deliberately issued no plan.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_current_run_outcome() -> u32 {
        MACHINE
            .with(|machine| machine.current_core_run_outcome_ptr())
            .unwrap_or(0)
    }

    const COMPILE_STATUS_NONE: u32 = 0;
    const COMPILE_STATUS_READY: u32 = 1;
    const COMPILE_STATUS_PENDING: u32 = 2;
    const COMPILE_STATUS_ADDRESS_SPACE: u32 = 3;
    const COMPILE_STATUS_BLOCK: u32 = 4;
    const COMPILE_STATUS_COORDINATOR: u32 = 5;
    const COMPILE_STATUS_SOURCE: u32 = 6;
    const COMPILE_STATUS_PUBLISH: u32 = 7;
    const COMPILE_STATUS_RETIREMENT: u32 = 8;

    fn compile_error_status(error: &super::PrepareCurrentPcError) -> u32 {
        match error {
            super::PrepareCurrentPcError::PendingRequest => COMPILE_STATUS_PENDING,
            super::PrepareCurrentPcError::AddressSpaceSynchronization(_) => {
                COMPILE_STATUS_ADDRESS_SPACE
            }
            super::PrepareCurrentPcError::Block(_) => COMPILE_STATUS_BLOCK,
            super::PrepareCurrentPcError::Coordinator(_) => COMPILE_STATUS_COORDINATOR,
            super::PrepareCurrentPcError::SharedModuleUnavailable => COMPILE_STATUS_SOURCE,
            super::PrepareCurrentPcError::Publish(_) => COMPILE_STATUS_PUBLISH,
        }
    }

    /// Authenticates dispatcher accounting, advances canonical machine time, and handles a cold
    /// miss entirely inside Rust before exposing only the final opaque CompileRequest.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_finish_slice(
        token: u64,
        instructions: u64,
        cycles: u64,
        blocks: u32,
        reason: u32,
    ) -> u32 {
        MACHINE
            .with(|machine| {
                let Some(report) =
                    core_run::DispatchReport::from_raw(instructions, cycles, blocks, reason)
                else {
                    let _ = machine.run_coordinator.finish_slice_raw(
                        token,
                        instructions,
                        cycles,
                        blocks,
                        reason,
                    );
                    machine.complete_machine_evidence_outer_slice();
                    return machine.current_core_run_outcome_ptr();
                };
                let Ok(finish) = machine.run_coordinator.finish_slice(token, report) else {
                    machine.complete_machine_evidence_outer_slice();
                    return machine.current_core_run_outcome_ptr();
                };

                // The plan validator proved cycles <= its Rust-issued bound. Move the sole
                // canonical clock before cold compilation or any subsequent deadline selection.
                if !machine.commit_resident_dispatch_cycles(report.cycles) {
                    machine.complete_machine_evidence_outer_slice();
                    return machine.current_core_run_outcome_ptr();
                }
                machine.record_machine_evidence_dispatch(report);
                if !machine.commit_resident_si_summary() {
                    machine.complete_machine_evidence_outer_slice();
                    return machine.current_core_run_outcome_ptr();
                }
                #[cfg(feature = "game-fidelity-probes")]
                machine.sample_game_fidelity_after_dispatch();
                let finish = match finish {
                    core_run::FinishSlice::IdleProbe(identity) => {
                        let Some(resolved) = machine.resolve_resident_idle_probe(identity) else {
                            machine.complete_machine_evidence_outer_slice();
                            return machine.current_core_run_outcome_ptr();
                        };
                        resolved
                    }
                    other => {
                        machine.resident_idle_witness = None;
                        other
                    }
                };
                match finish {
                    core_run::FinishSlice::Resume => core_run::FINISH_RESUME,
                    core_run::FinishSlice::ServiceEvents => {
                        match machine.service_due_resident_events() {
                            ResidentEventService::Complete => {
                                if machine.run_coordinator.events_serviced().is_ok() {
                                    core_run::FINISH_RESUME
                                } else {
                                    machine.current_core_run_outcome_ptr()
                                }
                            }
                            ResidentEventService::Deferred => {
                                if machine.run_coordinator.events_deferred().is_ok() {
                                    machine.complete_machine_evidence_outer_slice();
                                }
                                machine.current_core_run_outcome_ptr()
                            }
                            ResidentEventService::MachineExit => {
                                let _ = machine.run_coordinator.events_deferred();
                                machine.complete_machine_evidence_outer_slice();
                                machine.current_core_run_outcome_ptr()
                            }
                        }
                    }
                    core_run::FinishSlice::Outcome => {
                        machine.complete_machine_evidence_outer_slice();
                        machine.current_core_run_outcome_ptr()
                    }
                    core_run::FinishSlice::PrepareCompile(_) => {
                        match machine.prepare_current_pc_compile() {
                            Ok(prepared) => {
                                let identity = prepared.request.install_identity();
                                if !machine.apply_cold_compile_retirements(&prepared.retirements) {
                                    // Even a synchronous publication failure is scoped to the
                                    // complete Rust-issued identity; never cancel "whatever is
                                    // pending" from this runner boundary.
                                    let _ = machine.cancel_resident_block_install(identity);
                                    machine.last_compile_status = COMPILE_STATUS_RETIREMENT;
                                    let _ = machine
                                        .run_coordinator
                                        .compile_failed(COMPILE_STATUS_RETIREMENT);
                                    machine.complete_machine_evidence_outer_slice();
                                    return machine.current_core_run_outcome_ptr();
                                }
                                machine.host_compile_request = Some(prepared.request);
                                let request_ptr = machine.host_compile_request.as_ref().map_or(
                                    lazuli_abi::SharedPtr::NULL,
                                    |request| {
                                        lazuli_abi::SharedPtr(
                                            request as *const lazuli_abi::CompileRequest as u32,
                                        )
                                    },
                                );
                                if machine
                                    .run_coordinator
                                    .compile_required(identity, request_ptr)
                                    .is_err()
                                {
                                    let _ = machine.cancel_resident_block_install(identity);
                                    machine.last_compile_status = COMPILE_STATUS_COORDINATOR;
                                    let _ = machine
                                        .run_coordinator
                                        .compile_failed(COMPILE_STATUS_COORDINATOR);
                                    machine.complete_machine_evidence_outer_slice();
                                } else {
                                    machine.last_compile_status = COMPILE_STATUS_READY;
                                }
                                machine.current_core_run_outcome_ptr()
                            }
                            Err(failure) => {
                                let retirements_ok =
                                    machine.apply_cold_compile_retirements(&failure.retirements);
                                let status = if retirements_ok {
                                    compile_error_status(&failure.error)
                                } else {
                                    COMPILE_STATUS_RETIREMENT
                                };
                                machine.last_compile_status = status;
                                if machine.run_coordinator.compile_failed(status).is_ok() {
                                    machine.complete_machine_evidence_outer_slice();
                                }
                                machine.current_core_run_outcome_ptr()
                            }
                        }
                    }
                    core_run::FinishSlice::IdleProbe(_) => {
                        machine
                            .publish_machine_exit(ResidentMachineExitDetail::IdleAdvanceRejected);
                        machine.complete_machine_evidence_outer_slice();
                        machine.current_core_run_outcome_ptr()
                    }
                }
            })
            .unwrap_or(0)
    }

    /// Compiles the current guest PC and returns a stable pointer to the copied request.
    ///
    /// All guest fetch, translation, lowering, module hashing, and request identity remain in
    /// Rust. The host receives only the final opaque Wasm bytes named by `CompileRequest`.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_prepare_current_pc_compile() -> u32 {
        MACHINE
            .with(|machine| match machine.prepare_current_pc_compile() {
                Ok(prepared) => {
                    if !machine.apply_cold_compile_retirements(&prepared.retirements) {
                        if let Some(cancelled) = machine.cold_compile.cancel_pending() {
                            machine.discard_pending_installable_for_slot(cancelled);
                            let _ = machine.unpublish_slot_identity(cancelled);
                        }
                        machine.last_compile_status = COMPILE_STATUS_RETIREMENT;
                        machine.resident_context.control.request_exit();
                        return 0;
                    }
                    machine.host_compile_request = Some(prepared.request);
                    machine.last_compile_status = COMPILE_STATUS_READY;
                    machine.host_compile_request.as_ref().map_or(0, |request| {
                        request as *const lazuli_abi::CompileRequest as u32
                    })
                }
                Err(failure) => {
                    let retirements_ok =
                        machine.apply_cold_compile_retirements(&failure.retirements);
                    machine.last_compile_status = if retirements_ok {
                        compile_error_status(&failure.error)
                    } else {
                        COMPILE_STATUS_RETIREMENT
                    };
                    0
                }
            })
            .unwrap_or(0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_last_compile_status() -> u32 {
        MACHINE
            .with(|machine| machine.last_compile_status)
            .unwrap_or(COMPILE_STATUS_NONE)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn core_pending_module_bytes() -> u32 {
        MACHINE
            .with(|machine| {
                machine
                    .pending_installable()
                    .and_then(|pending| u32::try_from(pending.module().bytes().len()).ok())
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    }

    /// Size of the currently host-visible compile request, or zero after it is consumed.
    #[unsafe(no_mangle)]
    pub extern "C" fn core_pending_compile_request_bytes() -> u32 {
        MACHINE
            .with(|machine| {
                machine.host_compile_request.as_ref().map_or(0, |_| {
                    core::mem::size_of::<lazuli_abi::CompileRequest>() as u32
                })
            })
            .unwrap_or(0)
    }

    /// Validates one retained hashed instruction-page dependency inside the Rust machine.
    #[unsafe(no_mangle)]
    pub extern "C" fn validate_instruction_page_dependency(
        effective_page: u32,
        physical_page: u32,
    ) -> u32 {
        MACHINE
            .with(|machine| {
                machine.validate_instruction_page_dependency(effective_page, physical_page)
            })
            .is_some_and(|valid| valid) as u32
    }

    #[allow(clippy::too_many_arguments)]
    fn install_identity(
        request_id: u32,
        table_slot: u32,
        slot_nonce_lo: u32,
        slot_nonce_hi: u32,
        generation_lo: u32,
        generation_hi: u32,
        install_token_lo: u32,
        install_token_hi: u32,
    ) -> super::ResidentBlockInstallIdentity {
        super::ResidentBlockInstallIdentity {
            request_id,
            table_slot,
            slot_nonce_lo,
            slot_nonce_hi,
            address_space_generation_lo: generation_lo,
            address_space_generation_hi: generation_hi,
            install_token_lo,
            install_token_hi,
        }
    }

    /// Authorizes one exact Rust-issued module immediately before its own typed table write.
    #[unsafe(no_mangle)]
    #[allow(clippy::too_many_arguments)]
    pub extern "C" fn begin_resident_block_install(
        request_id: u32,
        table_slot: u32,
        slot_nonce_lo: u32,
        slot_nonce_hi: u32,
        generation_lo: u32,
        generation_hi: u32,
        install_token_lo: u32,
        install_token_hi: u32,
    ) -> u32 {
        let identity = install_identity(
            request_id,
            table_slot,
            slot_nonce_lo,
            slot_nonce_hi,
            generation_lo,
            generation_hi,
            install_token_lo,
            install_token_hi,
        );
        MACHINE
            .with(|machine| machine.begin_resident_block_install(identity) as u32)
            .unwrap_or(super::ResidentInstallStatus::NoPendingRequest as u32)
    }

    /// Cancels one exact Rust-issued install after browser compilation or instantiation failed.
    #[unsafe(no_mangle)]
    #[allow(clippy::too_many_arguments)]
    pub extern "C" fn cancel_resident_block_install(
        request_id: u32,
        table_slot: u32,
        slot_nonce_lo: u32,
        slot_nonce_hi: u32,
        generation_lo: u32,
        generation_hi: u32,
        install_token_lo: u32,
        install_token_hi: u32,
    ) -> u32 {
        let identity = install_identity(
            request_id,
            table_slot,
            slot_nonce_lo,
            slot_nonce_hi,
            generation_lo,
            generation_hi,
            install_token_lo,
            install_token_hi,
        );
        MACHINE
            .with(|machine| machine.cancel_resident_block_install(identity) as u32)
            .unwrap_or(super::ResidentInstallStatus::NoPendingRequest as u32)
    }

    /// Publishes slot identity and cache metadata after the module completed `table.set`.
    #[unsafe(no_mangle)]
    #[allow(clippy::too_many_arguments)]
    pub extern "C" fn commit_resident_block_install(
        request_id: u32,
        table_slot: u32,
        slot_nonce_lo: u32,
        slot_nonce_hi: u32,
        generation_lo: u32,
        generation_hi: u32,
        install_token_lo: u32,
        install_token_hi: u32,
    ) -> u32 {
        let identity = install_identity(
            request_id,
            table_slot,
            slot_nonce_lo,
            slot_nonce_hi,
            generation_lo,
            generation_hi,
            install_token_lo,
            install_token_hi,
        );
        MACHINE
            .with(|machine| machine.commit_resident_block_install(identity) as u32)
            .unwrap_or(super::ResidentInstallStatus::NoPendingRequest as u32)
    }

    fn reject_resident_call(machine: &mut BrowserMachine) -> u32 {
        machine.resident_context.control.request_exit();
        HookOutcome::Fault as u32
    }

    fn context_matches(machine: &mut BrowserMachine, context: u32) -> bool {
        context != 0 && context == machine.context_ptr()
    }

    fn output_pointer_is_valid<P>(machine: &mut BrowserMachine, context: u32, output: u32) -> bool {
        if !context_matches(machine, context) || !output.is_multiple_of(align_of::<P>() as u32) {
            return false;
        }
        let Some(start) = context.checked_add(RESIDENT_STACK_SCRATCH_OFFSET as u32) else {
            return false;
        };
        let Some(end) = start.checked_add(RESIDENT_STACK_SCRATCH_BYTES as u32) else {
            return false;
        };
        let Some(output_end) = output.checked_add(size_of::<P>() as u32) else {
            return false;
        };
        output >= start && output_end <= end && end == context + RESIDENT_CONTEXT_BYTES as u32
    }

    fn map_scalar_outcome(machine: &mut BrowserMachine, result: HookResult) -> u32 {
        match machine.apply_hook_result(result) {
            HookOutcome::Complete => 1,
            HookOutcome::Yield => 2,
            HookOutcome::Fault | HookOutcome::Invalidated => 0,
        }
    }

    fn prepare_resident_memory_access(machine: &BrowserMachine) -> (u64, u64) {
        let observed_cycle = machine.system.scheduler.elapsed();
        (
            observed_cycle,
            machine.system.video.resident_timing_reschedules(),
        )
    }

    fn read_scalar<P: Primitive>(context: u32, address: u32, output: u32) -> u32 {
        MACHINE
            .with(|machine| {
                if !output_pointer_is_valid::<P>(machine, context, output) {
                    return reject_resident_call(machine);
                }
                let Some(operation) = machine.observe_resident_hook(|machine| {
                    let (observed_cycle, vi_reschedules) = prepare_resident_memory_access(machine);
                    let mut value = P::default();
                    let result = match MachineRuntimeHooks::read_slow_classified_at(
                        &mut machine.system,
                        Address(address),
                        &mut value,
                        observed_cycle,
                    ) {
                        Ok(result) => result,
                        Err(error) => {
                            machine.publish_resident_device_error(error);
                            return None;
                        }
                    };
                    Some((result, value, observed_cycle, vi_reschedules))
                }) else {
                    return HookOutcome::Fault as u32;
                };
                let Some((result, value, observed_cycle, vi_reschedules)) = operation else {
                    return HookOutcome::Fault as u32;
                };
                let outcome =
                    machine.apply_memory_hook_result(result, observed_cycle, vi_reschedules) as u32;
                if outcome == HookOutcome::Complete as u32 {
                    // SAFETY: `output_pointer_is_valid` authenticated a properly aligned complete
                    // primitive inside this machine's private resident scratch window. Generated
                    // code reads the native little-endian Wasm value from the same location.
                    unsafe { (output as *mut P).write(value) };
                }
                outcome
            })
            .unwrap_or(HookOutcome::Fault as u32)
    }

    fn read_scalar_i32(context: u32, address: u32, output: u32) -> u32 {
        MACHINE
            .with(|machine| {
                if !output_pointer_is_valid::<i32>(machine, context, output) {
                    return reject_resident_call(machine);
                }
                let Some(operation) = machine.observe_resident_hook(|machine| {
                    let (observed_cycle, vi_reschedules) = prepare_resident_memory_access(machine);
                    let result =
                        match machine.read_resident_i32_at(Address(address), observed_cycle) {
                            Ok(result) => result,
                            Err(error) => {
                                machine.publish_resident_device_error(error);
                                return None;
                            }
                        };
                    Some((result, observed_cycle, vi_reschedules))
                }) else {
                    return HookOutcome::Fault as u32;
                };
                let Some((result, observed_cycle, vi_reschedules)) = operation else {
                    return HookOutcome::Fault as u32;
                };
                let (outcome, value) = match result {
                    ResidentI32Read::Memory { result, value } => (
                        machine.apply_memory_hook_result(result, observed_cycle, vi_reschedules),
                        value,
                    ),
                    ResidentI32Read::Complete(value) => (HookOutcome::Complete, value),
                    ResidentI32Read::Yield => (machine.apply_hook_result(HookResult::YIELD), 0),
                    ResidentI32Read::MachineExit => (HookOutcome::Fault, 0),
                };
                if outcome == HookOutcome::Complete {
                    // SAFETY: The private scratch range and i32 alignment were authenticated.
                    unsafe { (output as *mut i32).write(value) };
                }
                outcome as u32
            })
            .unwrap_or(HookOutcome::Fault as u32)
    }

    fn write_scalar<P: Primitive>(context: u32, address: u32, value: P) -> u32 {
        MACHINE
            .with(|machine| {
                if !context_matches(machine, context) {
                    return reject_resident_call(machine);
                }
                let Some(operation) = machine.observe_resident_hook(|machine| {
                    let (observed_cycle, vi_reschedules) = prepare_resident_memory_access(machine);
                    let result = match MachineRuntimeHooks::write_slow_classified_at(
                        &mut machine.system,
                        Address(address),
                        value,
                        observed_cycle,
                    ) {
                        Ok(result) => result,
                        Err(error) => {
                            machine.publish_resident_device_error(error);
                            return None;
                        }
                    };
                    Some((result, observed_cycle, vi_reschedules))
                }) else {
                    return HookOutcome::Fault as u32;
                };
                let Some((result, observed_cycle, vi_reschedules)) = operation else {
                    return HookOutcome::Fault as u32;
                };
                machine.apply_memory_hook_result(result, observed_cycle, vi_reschedules) as u32
            })
            .unwrap_or(HookOutcome::Fault as u32)
    }

    #[derive(Clone, Copy)]
    enum ResidentHookBoundary {
        /// Time-only state may remain resident unless it authored an earlier machine deadline.
        TimeOnly,
        /// Translation, cache, control, and device state must return to the Rust outer boundary.
        Always,
    }

    fn state_hook(
        context: u32,
        boundary: ResidentHookBoundary,
        operation: impl FnOnce(&mut BrowserMachine) -> HookResult,
    ) {
        let _ = MACHINE.with(|machine| {
            if !context_matches(machine, context) {
                reject_resident_call(machine);
                return;
            }
            let Some(result) = machine.observe_resident_hook(operation) else {
                return;
            };
            machine.apply_hook_result(result);
            if matches!(boundary, ResidentHookBoundary::Always) {
                machine.resident_context.control.request_exit();
            }
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_3(context: u32, address: u32, output: u32) -> u32 {
        read_scalar::<i8>(context, address, output)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_4(context: u32, address: u32, output: u32) -> u32 {
        read_scalar::<i16>(context, address, output)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_5(context: u32, address: u32, output: u32) -> u32 {
        read_scalar_i32(context, address, output)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_6(context: u32, address: u32, output: u32) -> u32 {
        read_scalar::<i64>(context, address, output)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_7(context: u32, address: u32, value: i32) -> u32 {
        write_scalar::<i8>(context, address, value as i8)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_8(context: u32, address: u32, value: i32) -> u32 {
        write_scalar::<i16>(context, address, value as i16)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_9(context: u32, address: u32, value: i32) -> u32 {
        write_scalar::<i32>(context, address, value)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_10(context: u32, address: u32, value: i64) -> u32 {
        write_scalar::<i64>(context, address, value)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_11(context: u32, address: u32, gqr: u32, output: u32) -> u32 {
        MACHINE
            .with(|machine| {
                if !output_pointer_is_valid::<f64>(machine, context, output) {
                    return reject_resident_call(machine);
                }
                let Some(operation) = machine.observe_resident_hook(|machine| {
                    let (observed_cycle, vi_reschedules) = prepare_resident_memory_access(machine);
                    let mut value = 0.0;
                    let mut size = 0;
                    let result = match MachineRuntimeHooks::read_quantized_classified_at(
                        &mut machine.system,
                        Address(address),
                        QuantReg::from_bits(gqr),
                        &mut value,
                        &mut size,
                        observed_cycle,
                    ) {
                        Ok(result) => result,
                        Err(error) => {
                            machine.publish_resident_device_error(error);
                            return None;
                        }
                    };
                    Some((result, value, size, observed_cycle, vi_reschedules))
                }) else {
                    return 0;
                };
                let Some((result, value, size, observed_cycle, vi_reschedules)) = operation else {
                    return 0;
                };
                if machine.apply_memory_hook_result(result, observed_cycle, vi_reschedules)
                    != HookOutcome::Complete
                {
                    return 0;
                }
                // SAFETY: The exact private scratch range and f64 alignment were authenticated.
                unsafe { (output as *mut f64).write(value) };
                u32::from(size)
            })
            .unwrap_or(0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_12(context: u32, address: u32, gqr: u32, value: f64) -> u32 {
        MACHINE
            .with(|machine| {
                if !context_matches(machine, context) {
                    return reject_resident_call(machine);
                }
                let Some(operation) = machine.observe_resident_hook(|machine| {
                    let (observed_cycle, vi_reschedules) = prepare_resident_memory_access(machine);
                    let mut size = 0;
                    let result = match MachineRuntimeHooks::write_quantized_classified_at(
                        &mut machine.system,
                        Address(address),
                        QuantReg::from_bits(gqr),
                        value,
                        &mut size,
                        observed_cycle,
                    ) {
                        Ok(result) => result,
                        Err(error) => {
                            machine.publish_resident_device_error(error);
                            return None;
                        }
                    };
                    Some((result, size, observed_cycle, vi_reschedules))
                }) else {
                    return 0;
                };
                let Some((result, size, observed_cycle, vi_reschedules)) = operation else {
                    return 0;
                };
                if machine.apply_memory_hook_result(result, observed_cycle, vi_reschedules)
                    == HookOutcome::Complete
                {
                    u32::from(size)
                } else {
                    0
                }
            })
            .unwrap_or(0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_13(context: u32, address: u32) {
        state_hook(context, ResidentHookBoundary::Always, |machine| {
            MachineRuntimeHooks::invalidate_instruction_cache_line(
                &mut machine.system,
                Address(address),
            )
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_14(context: u32) {
        state_hook(context, ResidentHookBoundary::Always, |_| {
            synchronize_resident_instruction_stream()
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_15(context: u32) {
        state_hook(context, ResidentHookBoundary::Always, |machine| {
            MachineRuntimeHooks::locked_cache_dma(&mut machine.system)
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_16(context: u32) {
        state_hook(context, ResidentHookBoundary::Always, |machine| {
            machine.runtime_hooks.msr_changed(&mut machine.system)
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_17(context: u32) {
        state_hook(context, ResidentHookBoundary::Always, |machine| {
            machine
                .runtime_hooks
                .instruction_bat_changed(&mut machine.system)
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_18(context: u32) {
        state_hook(context, ResidentHookBoundary::Always, |machine| {
            MachineRuntimeHooks::data_bat_changed(&mut machine.system)
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_19(context: u32) {
        state_hook(context, ResidentHookBoundary::TimeOnly, |machine| {
            machine.system.update_time_base();
            HookResult::COMPLETE
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_20(context: u32) {
        state_hook(context, ResidentHookBoundary::TimeOnly, |machine| {
            machine.system.lazy.last_updated_tb = machine.system.scheduler.elapsed_time_base();
            HookResult::COMPLETE
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_21(context: u32) {
        state_hook(context, ResidentHookBoundary::TimeOnly, |machine| {
            machine.system.update_decrementer();
            HookResult::COMPLETE
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_22(context: u32) {
        state_hook(context, ResidentHookBoundary::TimeOnly, |machine| {
            if machine.system.decrementer_changed().is_ok() {
                HookResult::COMPLETE
            } else {
                machine.publish_machine_exit(ResidentMachineExitDetail::HookScheduleRejected);
                HookResult {
                    outcome: HookOutcome::Fault,
                    ..HookResult::COMPLETE
                }
            }
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_23(context: u32) {
        state_hook(context, ResidentHookBoundary::Always, |machine| {
            machine
                .runtime_hooks
                .segment_register_changed(&machine.system)
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_24(context: u32) {
        state_hook(context, ResidentHookBoundary::Always, |machine| {
            machine.runtime_hooks.sdr1_changed(&machine.system)
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_25(context: u32, address: u32) {
        state_hook(context, ResidentHookBoundary::Always, |machine| {
            MachineRuntimeHooks::tlbie(&mut machine.system, Address(address))
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_26(context: u32) {
        state_hook(context, ResidentHookBoundary::Always, |machine| {
            MachineRuntimeHooks::tlbsync(&mut machine.system)
        });
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_27(context: u32, address: u32, output: u32) -> u32 {
        MACHINE
            .with(|machine| {
                if !output_pointer_is_valid::<i32>(machine, context, output) {
                    return reject_resident_call(machine);
                }
                let Some((result, value)) = machine.observe_resident_hook(|machine| {
                    let mut value = 0;
                    let result = MachineRuntimeHooks::load_reserve(
                        &mut machine.system,
                        Address(address),
                        &mut value,
                    );
                    (result, value)
                }) else {
                    return HookOutcome::Fault as u32;
                };
                let outcome = map_scalar_outcome(machine, result);
                if outcome == HookOutcome::Complete as u32 {
                    // SAFETY: The exact private scratch range and i32 alignment were authenticated.
                    unsafe { (output as *mut i32).write(value) };
                }
                outcome
            })
            .unwrap_or(HookOutcome::Fault as u32)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_0_28(context: u32, address: u32, value: i32) -> u32 {
        MACHINE
            .with(|machine| {
                if !context_matches(machine, context) {
                    return reject_resident_call(machine);
                }
                let Some((result, stored)) = machine.observe_resident_hook(|machine| {
                    let mut stored = false;
                    let result = MachineRuntimeHooks::store_conditional(
                        &mut machine.system,
                        Address(address),
                        value,
                        &mut stored,
                    );
                    (result, stored)
                }) else {
                    return 0;
                };
                match machine.apply_hook_result(result) {
                    HookOutcome::Complete if stored => 2,
                    HookOutcome::Complete => 1,
                    HookOutcome::Fault | HookOutcome::Yield | HookOutcome::Invalidated => 0,
                }
            })
            .unwrap_or(0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn user_1_0(cpu: u32, exception: u32) {
        let _ = MACHINE.with(|machine| {
            if cpu == 0 || cpu != machine.cpu_ptr() {
                reject_resident_call(machine);
                return;
            }
            let Some(result) = machine.observe_resident_hook(|machine| {
                machine
                    .runtime_hooks
                    .raise_exception_vector(&mut machine.system, exception)
            }) else {
                return;
            };
            machine.apply_hook_result(result);
            machine.resident_context.control.request_exit();
        });
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm_abi::{
    begin_resident_block_install, cancel_resident_block_install, commit_resident_block_install,
    core_address_space_generation_hi, core_address_space_generation_lo, core_begin_slice,
    core_capture_authority_snapshot, core_context_ptr, core_cpu_ptr, core_current_run_outcome,
    core_fastmem_ptr, core_finish_slice, core_init, core_input_publish, core_last_compile_status,
    core_machine_evidence_bytes, core_machine_evidence_snapshot,
    core_pending_compile_request_bytes, core_pending_module_bytes, core_prepare_current_pc_compile,
    core_render_complete, core_render_pending_count, core_render_request_ptr, user_0_3, user_0_4,
    user_0_5, user_0_6, user_0_7, user_0_8, user_0_9, user_0_10, user_0_11, user_0_12, user_0_13,
    user_0_14, user_0_15, user_0_16, user_0_17, user_0_18, user_0_19, user_0_20, user_0_21,
    user_0_22, user_0_23, user_0_24, user_0_25, user_0_26, user_0_27, user_0_28, user_1_0,
    validate_instruction_page_dependency,
};
#[cfg(all(target_arch = "wasm32", feature = "game-fidelity-probes"))]
pub use wasm_abi::{
    core_game_fidelity_bytes, core_game_fidelity_phase, core_game_fidelity_requested_buttons,
    core_game_fidelity_requested_stick_xy_cxy, core_game_fidelity_requested_trigger_lrab,
    core_game_fidelity_snapshot,
};

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::process::Command;

    use lazuli::disks::async_boot::CISO_HEADER_BYTES;
    use lazuli::gekko::disasm::{Extensions, Ins};
    use lazuli::gekko::{GPR, Reg, SPR};
    use lazuli::system::mmu::{TranslationEffect, TranslationSource, page_table_vector};
    use lazuli::system::vi::{
        Field, ScanoutDimensions, ScanoutPolicy, ScanoutSnapshot, ScanoutWork,
    };
    use lazuli_abi::{
        HostCompletion, HostCompletionStatus, RENDER_RECEIPT_HAS_EFB_VALUE,
        RENDER_RECEIPT_HAS_PRESENTATION, RENDER_REQUEST_VI_PRESENT, RecordHeader, RenderReceipt,
        RenderReceiptKind, RenderReceiptStatus,
    };
    use ppcwasmjit::{Jit, RegionBlock, link_region};
    use wasmparser::Validator;

    use super::*;

    fn test_system() -> System {
        System::new(
            nop_modules(),
            Config {
                ipl_lle: true,
                ipl: Some(vec![0; IPL_BYTES]),
                sideload: None,
                perform_efb_copies: false,
                uart_escape: false,
            },
        )
    }

    struct ConnectedInputModule;

    impl lazuli::modules::input::InputModule for ConnectedInputModule {
        fn controller(&mut self, index: usize) -> Option<lazuli::modules::input::ControllerState> {
            (index == 0).then_some(lazuli::modules::input::ControllerState::default())
        }
    }

    fn gx_bp(register: u8, value: u32) -> Vec<u8> {
        let mut command = vec![0x61];
        command.extend_from_slice(&(u32::from(register) << 24 | value & 0x00ff_ffff).to_be_bytes());
        command
    }

    fn gx_xfb_terminal(destination: u32) -> Vec<u8> {
        let mut stream = gx_bp(0x49, 0);
        stream.extend(gx_bp(0x4a, 3 | (3 << 10)));
        stream.extend(gx_bp(0x4b, destination >> 5));
        stream.extend(gx_bp(0x4d, 32 >> 5));
        stream.extend(gx_bp(0x4e, 256));
        stream.extend(gx_bp(0x52, 0x4000));
        stream
    }

    fn gx_texture_terminal(destination: u32) -> Vec<u8> {
        let mut stream = gx_bp(0x49, 0);
        stream.extend(gx_bp(0x4a, 7 | (7 << 10)));
        stream.extend(gx_bp(0x4b, destination >> 5));
        stream.extend(gx_bp(0x4d, 32 >> 5));
        stream.extend(gx_bp(0x4e, 256));
        stream.extend(gx_bp(0x52, 0));
        stream
    }

    #[test]
    fn resident_gx_call_display_list_reads_the_cached_mem1_alias() {
        let mut runtime = ResidentGxRuntime::try_new(GxRuntimeLimits::default()).unwrap();
        let mut ram = vec![0; 0x80];
        ram[0x60] = 0x5a;
        let mut memory = ResidentMem1 { bytes: &mut ram };
        let mut stream = vec![0x40];
        stream.extend_from_slice(&0x8000_0020_u32.to_be_bytes());
        stream.extend_from_slice(&32_u32.to_be_bytes());
        stream.push(0x10);
        stream.extend_from_slice(&((11_u32 << 16) | 0x500).to_be_bytes());
        assert_eq!(stream.len(), 14);

        let progress = runtime.append(&stream, &mut memory, 1).unwrap();

        assert_eq!(
            progress.status,
            DecodeStatus::NeedMore { command_bytes: 53 }
        );
        assert_eq!(runtime.decoder().buffered_bytes(), 5);
        assert_eq!(runtime.decoder().stats().display_list_calls, 1);

        let mut alias_byte = [0];
        memory.read_exact(0xc000_0060, &mut alias_byte).unwrap();
        assert_eq!(alias_byte, [0x5a]);
        assert_eq!(
            memory.read_exact(0x4000_0060, &mut alias_byte),
            Err(GxMemoryError::Unmapped)
        );
    }

    fn queue_gx_bytes(machine: &mut BrowserMachine, bytes: &[u8]) {
        for byte in bytes {
            machine.system.gpu.cmd.queue.push_be(*byte);
        }
    }

    fn render_sequence(request: HostRequest) -> u64 {
        u64::from(request.arg0) | (u64::from(request.arg1) << 32)
    }

    fn render_completion(
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

    fn stage_completed_render(
        machine: &mut BrowserMachine,
        request: HostRequest,
        kind: RenderReceiptKind,
        generation: u32,
        payload_byte: u8,
    ) -> usize {
        let staging = machine.render_receipt_staging_mut(request).unwrap();
        let payload_len = staging.len() - RenderReceipt::BYTE_LEN;
        let mut receipt = RenderReceipt::new(
            render_sequence(request),
            kind,
            RenderReceiptStatus::Completed,
            generation,
        );
        receipt.payload_len = u32::try_from(payload_len).unwrap();
        assert!(receipt.encode_le(staging));
        staging[RenderReceipt::BYTE_LEN..].fill(payload_byte);
        staging.len()
    }

    fn stage_completed_efb_render(
        machine: &mut BrowserMachine,
        request: HostRequest,
        sequence: u64,
        generation: u32,
        value: u32,
    ) -> usize {
        let staging = machine.render_receipt_staging_mut(request).unwrap();
        assert_eq!(staging.len(), RenderReceipt::BYTE_LEN);
        let mut receipt = RenderReceipt::new(
            sequence,
            RenderReceiptKind::EfbPeek,
            RenderReceiptStatus::Completed,
            generation,
        );
        receipt.flags = RENDER_RECEIPT_HAS_EFB_VALUE;
        receipt.efb_value = value;
        assert!(receipt.encode_le(staging));
        staging.len()
    }

    fn direct_controller_poll(
        machine: &mut BrowserMachine,
        observed_cycle: u64,
    ) -> si::ControllerPublication {
        machine
            .system
            .serial
            .clear_poll_timing(&mut machine.event_deadlines);
        machine.system.serial.buffer[0] = 0x40;
        let identity = machine
            .system
            .serial
            .write_comm_control_at(si::CommControl::from_bits(1), observed_cycle)
            .unwrap()
            .started
            .unwrap();
        machine
            .system
            .serial
            .publish_deadlines(&mut machine.event_deadlines);
        let transition = machine
            .system
            .serial
            .service_next_due(
                si::ViSerialTiming::disabled_at(identity.completion_cycle),
                identity.completion_cycle,
                &mut machine.event_deadlines,
            )
            .unwrap();
        let Some(si::SerialServiceResult::Transfer(completion)) = transition else {
            panic!("due direct controller transfer was not serviced")
        };
        assert_eq!(completion.outcome, si::SerialTransferOutcome::Success);
        completion.publication.unwrap()
    }

    #[test]
    fn integer_controller_publication_preserves_press_release_order_and_packed_bytes() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let sticks = u32::from_le_bytes([0x11, 0x22, 0x33, 0x44]);
        let triggers = u32::from_le_bytes([0x55, 0x66, 0x77, 0x88]);
        let buttons = 0x1149;
        let press_sequence = (1_u64 << 32) | u64::from(u32::MAX);
        let release_sequence = 2_u64 << 32;

        let decoded = BrowserMachine::controller_input_sample(
            press_sequence as u32,
            (press_sequence >> 32) as u32,
            buttons,
            sticks,
            triggers,
        )
        .unwrap();
        assert_eq!(decoded.sequence, press_sequence);
        assert_eq!(
            decoded.state,
            si::ControllerInputState {
                buttons: buttons as u16,
                stick_x: 0x11,
                stick_y: 0x22,
                c_stick_x: 0x33,
                c_stick_y: 0x44,
                trigger_l: 0x55,
                trigger_r: 0x66,
                analog_a: 0x77,
                analog_b: 0x88,
            }
        );
        assert_eq!(
            machine.publish_controller_input(
                press_sequence as u32,
                (press_sequence >> 32) as u32,
                buttons,
                sticks,
                triggers,
            ),
            BrowserInputPublication::Queued
        );
        assert_eq!(
            machine.publish_controller_input(
                release_sequence as u32,
                (release_sequence >> 32) as u32,
                0,
                u32::from_le_bytes([0x80; 4]),
                0,
            ),
            BrowserInputPublication::Queued
        );

        let pressed = direct_controller_poll(&mut machine, 0);
        assert_eq!(pressed.sequence, press_sequence);
        assert_eq!(pressed.buttons, buttons as u16);
        assert_eq!(
            pressed.packet,
            [0x11, 0xc9, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]
        );
        let released = direct_controller_poll(&mut machine, 1_000);
        assert_eq!(released.sequence, release_sequence);
        assert_eq!(released.buttons, 0);
        assert_eq!(released.packet, [0x00, 0x80, 0x80, 0x80, 0x80, 0x80, 0, 0]);
    }

    #[test]
    fn integer_controller_publication_reports_equivalence_and_rust_queue_coalescing() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let centered = u32::from_le_bytes([0x80; 4]);
        assert_eq!(
            machine.publish_controller_input(1, 0, 0, centered, 0),
            BrowserInputPublication::Equivalent
        );
        assert_eq!(machine.system.serial.controller_applied_sequence(), 1);
        assert_eq!(machine.system.serial.controller_queue_len(), 0);

        assert_eq!(
            machine.publish_controller_input(2, 0, 0x0100, centered, 0),
            BrowserInputPublication::Queued
        );
        assert_eq!(
            machine.publish_controller_input(3, 0, 0x0100, centered, 0),
            BrowserInputPublication::Coalesced
        );
        assert_eq!(machine.system.serial.controller_queue_len(), 1);
        assert_eq!(machine.system.serial.controller_last_received_sequence(), 3);
        let publication = direct_controller_poll(&mut machine, 0);
        assert_eq!((publication.sequence, publication.buttons), (3, 0x0100));
    }

    #[test]
    fn rejected_controller_publications_leave_identity_and_full_queue_untouched() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let centered = u32::from_le_bytes([0x80; 4]);
        assert_eq!(
            machine.publish_controller_input(0, 0, 0, centered, 0),
            BrowserInputPublication::Rejected
        );
        for reserved in [0x0080, 0x2000, 0x4000, 0x8000, 0x0001_0000] {
            assert_eq!(
                machine.publish_controller_input(1, 0, reserved, centered, 0),
                BrowserInputPublication::Rejected
            );
        }
        assert_eq!(machine.system.serial.controller_last_received_sequence(), 0);
        assert_eq!(machine.system.serial.controller_queue_len(), 0);
        assert_eq!(machine.system.serial.controller_applied_sequence(), 0);

        assert_eq!(
            machine.publish_controller_input(1, 0, 0x0100, centered, 0),
            BrowserInputPublication::Queued
        );
        let before_stale = (
            machine.system.serial.controller_last_received_sequence(),
            machine.system.serial.controller_queue_len(),
            machine.system.serial.controller_applied_sequence(),
        );
        assert_eq!(
            machine.publish_controller_input(1, 0, 0x0200, centered, 0),
            BrowserInputPublication::Rejected
        );
        assert_eq!(
            (
                machine.system.serial.controller_last_received_sequence(),
                machine.system.serial.controller_queue_len(),
                machine.system.serial.controller_applied_sequence(),
            ),
            before_stale
        );

        for sequence in 2..=si::CONTROLLER_INPUT_QUEUE_CAPACITY as u32 {
            let buttons = if sequence.is_multiple_of(2) {
                0x0200
            } else {
                0x0100
            };
            assert_eq!(
                machine.publish_controller_input(sequence, 0, buttons, centered, 0),
                BrowserInputPublication::Queued
            );
        }
        let full_identity = (
            machine.system.serial.controller_last_received_sequence(),
            machine.system.serial.controller_queue_len(),
            machine.system.serial.controller_applied_sequence(),
        );
        assert_eq!(
            full_identity,
            (
                si::CONTROLLER_INPUT_QUEUE_CAPACITY as u64,
                si::CONTROLLER_INPUT_QUEUE_CAPACITY,
                0
            )
        );
        let retry_sequence = si::CONTROLLER_INPUT_QUEUE_CAPACITY as u32 + 1;
        assert_eq!(
            machine.publish_controller_input(retry_sequence, 0, 0x0100, centered, 0),
            BrowserInputPublication::Rejected
        );
        assert_eq!(
            (
                machine.system.serial.controller_last_received_sequence(),
                machine.system.serial.controller_queue_len(),
                machine.system.serial.controller_applied_sequence(),
            ),
            full_identity
        );

        for sequence in 1..=si::CONTROLLER_INPUT_QUEUE_CAPACITY as u64 {
            let publication = direct_controller_poll(&mut machine, sequence * 1_000);
            let expected_buttons = if sequence.is_multiple_of(2) {
                0x0200
            } else {
                0x0100
            };
            assert_eq!(
                (publication.sequence, publication.buttons),
                (sequence, expected_buttons)
            );
        }
        assert_eq!(machine.system.serial.controller_queue_len(), 0);
        assert_eq!(
            machine.publish_controller_input(retry_sequence, 0, 0x0100, centered, 0),
            BrowserInputPublication::Queued
        );
        assert_eq!(
            machine.system.serial.controller_last_received_sequence(),
            u64::from(retry_sequence)
        );
    }

    #[test]
    fn machine_evidence_preserves_periodic_backpressure_then_direct_si_order() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let centered = u32::from_le_bytes([0x80; 4]);
        assert_eq!(
            machine.publish_controller_input(1, 0, 0x0100, centered, 0),
            BrowserInputPublication::Queued
        );
        assert_eq!(
            machine.publish_controller_input(2, 0, 0x0200, centered, 0),
            BrowserInputPublication::Queued
        );

        let timing = si::ViSerialTiming {
            display_enabled: true,
            anchor_cycle: 0,
            anchor_half_line: 0,
            cycles_into_half_line: 0,
            cycles_per_half_line: 100,
            odd_half_lines: 20,
            total_half_lines: 40,
        };
        machine.system.serial.poll = si::Poll::from_bits(2 << 16);
        assert_eq!(
            machine
                .system
                .serial
                .synchronize_poll_timing(timing, 0, &mut machine.event_deadlines)
                .unwrap(),
            Some(1_600)
        );
        machine.system.serial.buffer[0] = 0x40;
        machine
            .system
            .serial
            .write_comm_control_at(si::CommControl::from_bits(1), 1_450)
            .unwrap();
        machine
            .system
            .serial
            .publish_deadlines(&mut machine.event_deadlines);

        machine.system.scheduler.advance(2_100);
        machine.refresh_machine_evidence_scheduler(None);
        let summary = si::service_due(
            &mut machine.system,
            timing,
            2_100,
            &mut machine.event_deadlines,
        )
        .unwrap();
        assert_eq!(summary.backpressured_polls, 1);
        assert_eq!(summary.periodic_publication.unwrap().sequence, 1);
        assert_eq!(
            summary
                .transfer
                .and_then(|completion| completion.publication)
                .unwrap()
                .sequence,
            2
        );
        machine.record_machine_evidence_si_summary(summary);

        let snapshot = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(snapshot.si.periodic_polls.get(), 1);
        assert_eq!(snapshot.si.direct_polls.get(), 1);
        assert_eq!(snapshot.si.backpressured_polls.get(), 1);
        assert_eq!(snapshot.si.poll_index.get(), 2);
        assert_eq!(snapshot.si.applied_sequence.get(), 2);
        assert_eq!(snapshot.si.last_received_sequence.get(), 2);
        assert_eq!(snapshot.si.queue_depth, 0);
        assert_eq!(
            snapshot.si.source(),
            Ok(lazuli_abi::MachineSiPollSource::Direct)
        );
    }

    #[test]
    fn resident_mmio_si_publication_waits_for_dispatch_commit_then_stays_exact() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.event_deadlines = MachineEventDeadlines::default();
        machine
            .system
            .serial
            .clear_poll_timing(&mut machine.event_deadlines);
        machine.system.serial.buffer[0] = 0x40;
        let transfer = machine
            .system
            .serial
            .write_comm_control_at(si::CommControl::from_bits(1), 0)
            .unwrap()
            .started
            .unwrap();
        machine
            .system
            .serial
            .publish_deadlines(&mut machine.event_deadlines);
        machine.refresh_machine_evidence_scheduler(None);

        let token = arm_resident_dispatch(&mut machine, transfer.completion_cycle, 1);
        machine.resident_context.control.instruction_cycle_offset =
            transfer.completion_cycle as u32;
        let operation = machine
            .observe_resident_hook(|machine| {
                let observed_cycle = machine.system.scheduler.elapsed();
                let prior_vi_reschedules = machine.system.video.resident_timing_reschedules();
                let mut value = 0_u32;
                let result = MachineRuntimeHooks::read_slow_classified_at(
                    &mut machine.system,
                    Address(0x0c00_3000),
                    &mut value,
                    observed_cycle,
                )
                .unwrap();
                (result, observed_cycle, prior_vi_reschedules)
            })
            .unwrap();
        assert_eq!(machine.system.serial.controller_poll_index(), 1);
        assert_eq!(machine.system.scheduler.canonical_elapsed(), 0);
        assert!(machine.pending_resident_si_summary.is_none());

        assert_eq!(
            machine.apply_memory_hook_result(operation.0, operation.1, operation.2),
            HookOutcome::Complete
        );
        assert!(machine.pending_resident_si_summary.is_some());
        let before_dispatch_commit = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(before_dispatch_commit.si.poll_index.get(), 0);
        assert_eq!(before_dispatch_commit.scheduler.canonical_cycle.get(), 0);

        let report = core_run::DispatchReport {
            instructions: 1,
            cycles: transfer.completion_cycle,
            blocks: 1,
            reason: ppcwasmjit::DispatchReason::HookExit,
        };
        assert_eq!(
            machine.run_coordinator.finish_slice(token, report).unwrap(),
            core_run::FinishSlice::Resume
        );
        assert!(machine.commit_resident_dispatch_cycles(report.cycles));
        machine.record_machine_evidence_dispatch(report);
        assert!(machine.pending_resident_si_summary.is_some());
        assert!(machine.commit_resident_si_summary());
        assert!(machine.pending_resident_si_summary.is_none());
        let after_dispatch_commit = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(after_dispatch_commit.scheduler.canonical_cycle.get(), 200);
        assert_eq!(after_dispatch_commit.si.poll_index.get(), 1);
        assert_eq!(after_dispatch_commit.si.direct_polls.get(), 1);

        // A following periodic publication remains exactly consecutive, including when semantic
        // idle advances directly to its fixed deadline before the outer event service.
        machine.system.serial.poll = si::Poll::from_bits(2 << 16);
        let timing = si::ViSerialTiming {
            display_enabled: true,
            anchor_cycle: transfer.completion_cycle,
            anchor_half_line: 0,
            cycles_into_half_line: 0,
            cycles_per_half_line: 100,
            odd_half_lines: 20,
            total_half_lines: 40,
        };
        let next_poll = machine
            .system
            .serial
            .synchronize_poll_timing(
                timing,
                transfer.completion_cycle,
                &mut machine.event_deadlines,
            )
            .unwrap()
            .unwrap();
        let idle_cycles = next_poll - machine.system.scheduler.canonical_elapsed();
        assert!(machine.system.scheduler.try_advance(idle_cycles).is_ok());
        assert!(machine.machine_evidence.commit_idle_cycles(
            next_poll,
            machine.system.cpu.pc.value(),
            machine.runtime_hooks.current_generation().0,
            idle_cycles,
        ));
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        let after_next_poll = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(after_next_poll.si.poll_index.get(), 2);
        assert_eq!(after_next_poll.si.periodic_polls.get(), 1);
        assert_eq!(after_next_poll.si.direct_polls.get(), 1);
        assert_eq!(after_next_poll.semantic_idle_jumps, 1);
        assert!(machine.machine_evidence.is_healthy());
    }

    #[test]
    fn resident_si_staging_accepts_one_due_summary_across_thirty_two_device_hooks() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.event_deadlines = MachineEventDeadlines::default();
        machine
            .system
            .serial
            .clear_poll_timing(&mut machine.event_deadlines);
        machine.system.serial.buffer[0] = 0x40;
        let transfer = machine
            .system
            .serial
            .write_comm_control_at(si::CommControl::from_bits(1), 0)
            .unwrap()
            .started
            .unwrap();
        machine
            .system
            .serial
            .publish_deadlines(&mut machine.event_deadlines);
        machine.refresh_machine_evidence_scheduler(None);

        let token = arm_resident_dispatch(&mut machine, transfer.completion_cycle, 1);
        machine.resident_context.control.instruction_cycle_offset =
            transfer.completion_cycle as u32;
        for access in 0..32 {
            let operation = machine
                .observe_resident_hook(|machine| {
                    let observed_cycle = machine.system.scheduler.elapsed();
                    let prior_vi_reschedules = machine.system.video.resident_timing_reschedules();
                    let mut value = 0_u32;
                    let result = MachineRuntimeHooks::read_slow_classified_at(
                        &mut machine.system,
                        Address(0x0c00_3000),
                        &mut value,
                        observed_cycle,
                    )
                    .unwrap();
                    (result, observed_cycle, prior_vi_reschedules)
                })
                .unwrap();
            assert_eq!(
                operation
                    .0
                    .serial_service
                    .is_some_and(BrowserMachine::si_summary_has_machine_evidence),
                access == 0
            );
            assert_eq!(
                machine.apply_memory_hook_result(operation.0, operation.1, operation.2),
                HookOutcome::Complete
            );
        }
        assert!(machine.pending_resident_si_summary.is_some());
        let report = core_run::DispatchReport {
            instructions: 1,
            cycles: transfer.completion_cycle,
            blocks: 1,
            reason: ppcwasmjit::DispatchReason::HookExit,
        };
        assert_eq!(
            machine.run_coordinator.finish_slice(token, report).unwrap(),
            core_run::FinishSlice::Resume
        );
        assert!(machine.commit_resident_dispatch_cycles(report.cycles));
        machine.record_machine_evidence_dispatch(report);
        assert!(machine.commit_resident_si_summary());
        assert!(machine.pending_resident_si_summary.is_none());
        let snapshot = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(snapshot.si.poll_index.get(), 1);
        assert_eq!(snapshot.si.direct_polls.get(), 1);
        assert!(machine.machine_evidence.is_healthy());

        let mut duplicate = BrowserMachine::from_system(test_system()).unwrap();
        duplicate.machine_evidence_outer_active = true;
        let evidence = si::SerialServiceSummary {
            backpressured_polls: 1,
            ..si::SerialServiceSummary::default()
        };
        assert!(duplicate.stage_resident_si_summary(evidence));
        assert!(!duplicate.stage_resident_si_summary(evidence));
        assert!(duplicate.pending_resident_si_summary.is_some());
        assert!(!duplicate.machine_evidence.is_healthy());
    }

    #[test]
    fn uncommitted_resident_si_summary_fails_outer_slice_closed() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.machine_evidence_outer_active = true;
        assert!(machine.stage_resident_si_summary(si::SerialServiceSummary {
            backpressured_polls: 1,
            ..si::SerialServiceSummary::default()
        }));
        machine.complete_machine_evidence_outer_slice();
        assert!(machine.pending_resident_si_summary.is_none());
        assert!(!machine.machine_evidence.is_healthy());
        assert_eq!(
            machine.machine_exit.map(|outcome| outcome.detail),
            Some(ResidentMachineExitDetail::HookObservationRejected as u32)
        );
    }

    const EFB_COLOR_PIXEL: Address = Address(0x0801_7044);
    const EFB_DEPTH_PIXEL: Address = Address(0x0841_7044);

    fn issue_efb_word(machine: &mut BrowserMachine, address: Address) -> ResidentI32Read {
        let observed_cycle = machine.system.scheduler.elapsed();
        machine
            .read_resident_i32_at(address, observed_cycle)
            .unwrap()
    }

    fn interpose_before_efb_retry(system: &mut System) {
        system.cpu.pc = Address(0x8000_dead);
        system.cpu.user.gpr[4] = 0xfeed_face;
    }

    #[test]
    fn efb_word_yields_without_guest_mutation_then_consumes_authenticated_value_once() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.system.cpu.pc = Address(0x8000_1004);
        machine.system.cpu.user.gpr[4] = 0x1122_3344;
        machine.system.cpu.supervisor.exception.dar = 0x5566_7788;
        machine.system.cpu.supervisor.exception.dsisr = 0x99aa_bbcc;
        machine.system.gpu.pix.alpha_read = 3;

        assert_eq!(
            issue_efb_word(&mut machine, EFB_DEPTH_PIXEL),
            ResidentI32Read::Yield
        );
        assert_eq!(machine.system.cpu.pc, Address(0x8000_1004));
        assert_eq!(machine.system.cpu.user.gpr[4], 0x1122_3344);
        assert_eq!(machine.system.cpu.supervisor.exception.dar, 0x5566_7788);
        assert_eq!(machine.system.cpu.supervisor.exception.dsisr, 0x99aa_bbcc);
        let Some(EfbLoadContinuation::AwaitingReceipt { identity, .. }) = machine.pending_efb_load
        else {
            panic!("valid EFB load did not retain a receipt continuation")
        };
        assert_eq!(identity.physical, EFB_DEPTH_PIXEL.value());
        assert_eq!(identity.alpha_read_mode, 0, "raw mode three must be Read00");

        let request = machine.render_request(0).unwrap();
        let value = 0xa1b2_c3d4;
        let filled_len =
            stage_completed_efb_render(&mut machine, request, render_sequence(request), 1, value);
        assert_eq!(
            machine.complete_render_request(
                request,
                render_completion(request, HostCompletionStatus::Ok, filled_len as u32),
            ),
            Ok(BrowserRenderCompletion::Committed)
        );
        assert!(matches!(
            machine.pending_efb_load,
            Some(EfbLoadContinuation::Ready { value: ready, .. }) if ready == value
        ));
        assert_eq!(machine.system.cpu.pc, Address(0x8000_1004));
        assert_eq!(machine.system.cpu.user.gpr[4], 0x1122_3344);

        // An already-due legacy effect may not interpose between receipt and unchanged load.
        machine
            .system
            .scheduler
            .schedule_now(interpose_before_efb_retry);
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        assert_eq!(machine.system.cpu.pc, Address(0x8000_1004));
        assert_eq!(machine.system.cpu.user.gpr[4], 0x1122_3344);

        assert_eq!(
            issue_efb_word(&mut machine, EFB_DEPTH_PIXEL),
            ResidentI32Read::Complete(value as i32)
        );
        assert!(machine.pending_efb_load.is_none());
        assert_eq!(machine.system.cpu.user.gpr[4], 0x1122_3344);

        // Once consumed, the same address starts a new operation instead of replaying the value.
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        assert_eq!(machine.system.cpu.pc, Address(0x8000_dead));
        machine.system.cpu.pc = Address(0x8000_1004);
        assert_eq!(
            issue_efb_word(&mut machine, EFB_DEPTH_PIXEL),
            ResidentI32Read::Yield
        );
        assert!(matches!(
            machine.pending_efb_load,
            Some(EfbLoadContinuation::AwaitingReceipt {
                terminal_sequence: 2,
                ..
            })
        ));
    }

    #[test]
    fn resident_boundary_defers_pi_until_ready_efb_load_retires() {
        use lazuli::system::gx::cmd::Control;
        use lazuli::system::pi::InterruptSources;

        let retry_pc = Address(0x8000_1800);
        let value = 0x89ab_cdef;
        let mut system = test_system();
        system.cpu.pc = retry_pc;
        system.cpu.supervisor.config.msr.set_interrupts(true);
        system.cpu.supervisor.config.msr.set_exception_prefix(false);
        system.gpu.cmd.control = Control::from_bits(0x0005);
        system.gpu.cmd.fifo.high_mark = 0x40;
        system.gpu.cmd.fifo.distance = 0x60;
        system.gpu.cmd.refresh_interrupt_latches();
        let mut mask = InterruptSources::default();
        mask.set_command_processor(true);
        system.processor.mask.set_sources(mask);

        let mut machine = BrowserMachine::from_system(system).unwrap();
        machine.pending_efb_load = Some(EfbLoadContinuation::Ready {
            identity: EfbLoadIdentity {
                effective: EFB_DEPTH_PIXEL.value(),
                physical: EFB_DEPTH_PIXEL.value(),
                observed_cycle: machine.system.scheduler.elapsed(),
                alpha_read_mode: 0,
            },
            terminal_sequence: 1,
            retry_pc,
            value,
        });

        assert!(machine.prepare_resident_dispatch_boundary());
        assert_eq!(machine.system.cpu.pc, retry_pc);
        assert_eq!(machine.system.cpu.supervisor.exception.srr[0], 0);
        assert_eq!(
            issue_efb_word(&mut machine, EFB_DEPTH_PIXEL),
            ResidentI32Read::Complete(value as i32)
        );
        assert!(machine.pending_efb_load.is_none());

        assert!(machine.prepare_resident_dispatch_boundary());
        assert_eq!(machine.system.cpu.pc, Address(0x0000_0500));
        assert_eq!(
            machine.system.cpu.supervisor.exception.srr[0],
            retry_pc.value()
        );
    }

    #[test]
    fn stale_mutated_and_wrong_efb_receipts_never_publish_a_retry_value() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.system.cpu.pc = Address(0x8000_2000);
        machine.system.cpu.user.gpr[5] = 0x1357_9bdf;
        assert_eq!(
            issue_efb_word(&mut machine, EFB_COLOR_PIXEL),
            ResidentI32Read::Yield
        );
        let request = machine.render_request(0).unwrap();

        let mut stale = request;
        stale.request_nonce_lo ^= 1;
        assert_eq!(
            machine.complete_render_request(
                stale,
                render_completion(stale, HostCompletionStatus::Ok, 0),
            ),
            Err(BrowserRenderError::Completion(
                RenderCompletionError::StaleRequest
            ))
        );
        let mut mutated = request;
        mutated.flags ^= 1;
        assert_eq!(
            machine.complete_render_request(
                mutated,
                render_completion(request, HostCompletionStatus::Ok, 0),
            ),
            Err(BrowserRenderError::Completion(
                RenderCompletionError::MutatedRequestRecord
            ))
        );
        assert_eq!(machine.pending_render_requests(), 1);
        assert!(matches!(
            machine.pending_efb_load,
            Some(EfbLoadContinuation::AwaitingReceipt { .. })
        ));
        assert!(machine.machine_exit.is_none());
        assert_eq!(machine.system.cpu.user.gpr[5], 0x1357_9bdf);

        let wrong_len = stage_completed_efb_render(
            &mut machine,
            request,
            render_sequence(request) + 1,
            1,
            0xffff_ffff,
        );
        assert_eq!(
            machine.complete_render_request(
                request,
                render_completion(request, HostCompletionStatus::Ok, wrong_len as u32),
            ),
            Err(BrowserRenderError::Completion(
                RenderCompletionError::WrongSequence
            ))
        );
        assert!(matches!(
            machine.pending_efb_load,
            Some(EfbLoadContinuation::AwaitingReceipt { .. })
        ));
        assert!(machine.machine_exit.is_some());
        assert_eq!(machine.system.cpu.pc, Address(0x8000_2000));
        assert_eq!(machine.system.cpu.user.gpr[5], 0x1357_9bdf);
    }

    #[test]
    fn efb_combined_and_out_of_bounds_words_complete_zero_even_with_renderer_work() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        queue_gx_bytes(&mut machine, &gx_xfb_terminal(0x4000));
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Deferred
        );
        assert_eq!(machine.pending_render_requests(), 1);

        for address in [
            Address(0x0880_0000), // combined plane
            Address(0x0800_0a00), // x = 640
            Address(0x0821_0000), // y = 528
        ] {
            assert_eq!(
                issue_efb_word(&mut machine, address),
                ResidentI32Read::Complete(0)
            );
            assert!(machine.pending_efb_load.is_none());
            assert_eq!(machine.pending_render_requests(), 1);
        }
    }

    #[test]
    fn efb_nonword_and_unaligned_shapes_keep_the_architected_fault_path() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let ResidentI32Read::Memory { result, .. } =
            issue_efb_word(&mut machine, Address(0x0800_0102))
        else {
            panic!("unaligned EFB word did not use the guest fault path")
        };
        assert_eq!(result.result.outcome, HookOutcome::Fault);
        assert_eq!(machine.system.cpu.supervisor.exception.dar, 0x0800_0102);
        assert!(machine.pending_efb_load.is_none());

        for address in [Address(0x0800_0100), Address(0x0800_0104)] {
            let mut value = 0_i16;
            let result = MachineRuntimeHooks::read_slow_classified_at_deferred(
                &mut machine.system,
                address,
                &mut value,
                0,
            )
            .unwrap();
            let ResidentMemoryRead::Complete(result) = result else {
                panic!("halfword EFB access was incorrectly deferred")
            };
            assert_eq!(result.result.outcome, HookOutcome::Fault);
        }
    }

    #[test]
    fn efb_waits_for_an_issued_renderer_terminal_then_reuses_its_translation() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.system.cpu.pc = Address(0x8000_3000);
        queue_gx_bytes(&mut machine, &gx_xfb_terminal(0x4000));
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Deferred
        );
        let earlier = machine.render_request(0).unwrap();
        assert_eq!(
            issue_efb_word(&mut machine, EFB_COLOR_PIXEL),
            ResidentI32Read::Yield
        );
        let Some(EfbLoadContinuation::Ordering { identity }) = machine.pending_efb_load else {
            panic!("EFB load did not retain its translated ordering continuation")
        };
        assert_eq!(machine.pending_render_requests(), 1);

        let earlier_len =
            stage_completed_render(&mut machine, earlier, RenderReceiptKind::XfbCopy, 1, 0);
        assert_eq!(
            machine.complete_render_request(
                earlier,
                render_completion(earlier, HostCompletionStatus::Ok, earlier_len as u32),
            ),
            Ok(BrowserRenderCompletion::Committed)
        );
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        assert_eq!(
            machine.pending_efb_load,
            Some(EfbLoadContinuation::Ordering { identity })
        );

        // Change the live translation mode while the CPU is stopped. The retry must consume the
        // retained physical identity rather than performing a second architectural translation.
        machine
            .system
            .cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        assert_eq!(
            issue_efb_word(&mut machine, EFB_COLOR_PIXEL),
            ResidentI32Read::Yield
        );
        assert!(matches!(
            machine.pending_efb_load,
            Some(EfbLoadContinuation::AwaitingReceipt {
                identity: retained,
                ..
            }) if retained == identity
        ));
        assert_eq!(machine.pending_render_requests(), 1);
    }

    #[test]
    fn dormant_fifo_and_partial_gather_bytes_do_not_deadlock_efb_reads() {
        let mut partial = BrowserMachine::from_system(test_system()).unwrap();
        pi::fifo_push(&mut partial.system, 0x61_u8);
        assert_eq!(pi::fifo_pending_bytes(&partial.system), 1);
        assert_eq!(
            issue_efb_word(&mut partial, EFB_COLOR_PIXEL),
            ResidentI32Read::Yield
        );
        assert!(matches!(
            partial.pending_efb_load,
            Some(EfbLoadContinuation::AwaitingReceipt { .. })
        ));

        for (control, malformed) in [(0_u16, false), (3, false), (1, true)] {
            let mut machine = BrowserMachine::from_system(test_system()).unwrap();
            machine.system.gpu.cmd.control = lazuli::system::gx::cmd::Control::from_bits(control);
            machine.system.gpu.cmd.fifo.start = Address(0x100);
            machine.system.gpu.cmd.fifo.end = Address(0x1e0);
            machine.system.gpu.cmd.fifo.read_ptr = Address(0x120);
            machine.system.gpu.cmd.fifo.write_ptr = Address(0x140);
            machine.system.gpu.cmd.fifo.breakpoint = Address(0x120);
            machine.system.gpu.cmd.fifo.distance = if malformed { 31 } else { 32 };
            assert!(!machine.system.gpu.cmd.resident_fifo_drainable());
            assert_eq!(
                issue_efb_word(&mut machine, EFB_COLOR_PIXEL),
                ResidentI32Read::Yield
            );
            assert!(matches!(
                machine.pending_efb_load,
                Some(EfbLoadContinuation::AwaitingReceipt { .. })
            ));
        }
    }

    fn observe_texture_copy_destination(system: &mut System) {
        system.cpu.user.gpr[0] = u32::from(system.mem.ram()[0x4000]);
    }

    #[test]
    fn browser_machine_cancels_legacy_device_callbacks_at_construction() {
        let mut system = test_system();
        system.modules.input = Box::new(ConnectedInputModule);
        system.serial.poll = si::Poll::from_bits((1 << 16) | (1 << 4));
        system
            .scheduler
            .schedule_now(lazuli::system::gx::cmd::consume);
        system
            .scheduler
            .schedule_now(lazuli::system::vi::vertical_count);
        assert!(system.scheduler.contains(lazuli::system::gx::cmd::process));
        assert!(system.scheduler.contains(lazuli::system::gx::cmd::consume));
        assert!(
            system
                .scheduler
                .contains(lazuli::system::vi::vertical_count)
        );

        let mut machine = BrowserMachine::from_system(system).unwrap();
        assert!(
            !machine
                .system
                .scheduler
                .contains(lazuli::system::gx::cmd::process)
        );
        assert!(
            !machine
                .system
                .scheduler
                .contains(lazuli::system::gx::cmd::consume)
        );
        assert!(
            !machine
                .system
                .scheduler
                .contains(lazuli::system::vi::vertical_count)
        );

        // If the due callback survived, it would publish controller poll one and schedule its
        // successor. Resident takeover must leave neither untracked effect behind.
        machine.system.scheduler.advance(1_000_000);
        machine.system.process_events();
        assert_eq!(machine.system.serial.controller_poll_index(), 0);
        assert!(
            !machine
                .system
                .scheduler
                .contains(lazuli::system::vi::vertical_count)
        );
        assert!(machine.system.resident_pixel_engine_pi_delivery_enabled());
    }

    #[test]
    fn ninth_terminal_remains_owned_when_the_eight_request_renderer_queue_fills() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let mut stream = Vec::new();
        for index in 0..=MAX_PENDING_RENDER_REQUESTS {
            stream.extend(gx_xfb_terminal(0x1000 + (index as u32) * 0x100));
        }
        queue_gx_bytes(&mut machine, &stream);

        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Deferred
        );
        assert_eq!(
            machine.pending_render_requests(),
            MAX_PENDING_RENDER_REQUESTS
        );
        assert!(machine.pending_gx_progress.is_some());
        assert!(machine.gx_runtime.pending_bytes().unwrap() != 0);
        assert!(machine.host_render_request.is_some());
        assert_eq!(
            machine.render_wait_outcome.reason(),
            Ok(RunReason::HostRequest)
        );
        assert!(!machine.render_wait_outcome.request_ptr.is_null());
    }

    #[test]
    fn terminal_admission_charges_packet_capacity_not_only_semantic_length() {
        let response_bytes = RenderReceipt::BYTE_LEN;
        let oversized_capacity = MAX_PENDING_RENDER_BYTES - response_bytes + 1;
        assert!(oversized_capacity > 1);
        assert!(!BrowserMachine::render_charge_can_admit(
            0,
            0,
            1,
            oversized_capacity,
            0,
        ));
        assert!(BrowserMachine::render_charge_can_admit(0, 0, 1, 1, 0));
    }

    #[test]
    fn renderer_deferral_fences_same_cycle_legacy_and_fixed_device_effects() {
        const DESTINATION: u32 = 0x4000;

        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.event_deadlines = MachineEventDeadlines::default();
        machine.system.scheduler.advance(768);
        machine
            .event_deadlines
            .schedule(MachineEventKind::DspExecution, 768);
        machine
            .system
            .scheduler
            .schedule_now(observe_texture_copy_destination);
        machine.system.mem.ram_mut()[DESTINATION as usize] = 0x6d;
        queue_gx_bytes(&mut machine, &gx_texture_terminal(DESTINATION));

        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Deferred
        );
        assert_eq!(machine.system.cpu.user.gpr[0], 0);
        assert_eq!(machine.system.dsp.lle.execution_slices(), 0);
        assert_eq!(machine.system.gpu.pix.resident.last_observed_cycle(), None);
        assert_eq!(
            machine
                .event_deadlines
                .deadline(MachineEventKind::DspExecution),
            Some(768)
        );
        assert_eq!(machine.system.mem.ram()[DESTINATION as usize], 0x6d);

        // A reset notification cannot revoke the renderer-owned terminal. (A real guest hook
        // cannot execute while this host request is outstanding, so inject the already-authored
        // PI semantic here without running the hook's pre-MMIO device synchronization.)
        pi::reset_fifo(&mut machine.system);
        assert!(machine.system.gpu.cmd.resident_fifo_reset_pending());
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Deferred
        );
        assert!(machine.system.gpu.cmd.resident_fifo_reset_pending());
        assert_eq!(machine.system.cpu.user.gpr[0], 0);
        assert_eq!(machine.system.dsp.lle.execution_slices(), 0);

        let request = machine.render_request(0).unwrap();
        let filled_len = stage_completed_render(
            &mut machine,
            request,
            RenderReceiptKind::TextureCopy,
            1,
            0xa7,
        );
        assert_eq!(
            machine.complete_render_request(
                request,
                render_completion(request, HostCompletionStatus::Ok, filled_len as u32),
            ),
            Ok(BrowserRenderCompletion::Committed)
        );
        assert_eq!(machine.system.mem.ram()[DESTINATION as usize], 0xa7);
        assert_eq!(machine.system.cpu.user.gpr[0], 0);

        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        assert_eq!(machine.system.cpu.user.gpr[0], 0xa7);
        assert_eq!(machine.system.dsp.lle.execution_slices(), 1);
        assert!(
            machine
                .system
                .gpu
                .pix
                .resident
                .last_observed_cycle()
                .is_some()
        );
        assert!(!machine.system.gpu.cmd.resident_fifo_reset_pending());
    }

    #[test]
    fn incomplete_resident_opcode_and_pi_gather_carry_block_disc_boot() {
        let mut decoder_carry = BrowserMachine::from_system(test_system()).unwrap();
        queue_gx_bytes(&mut decoder_carry, &[0x61]);
        assert_eq!(
            decoder_carry.service_due_resident_events(),
            ResidentEventService::Complete
        );
        assert_eq!(decoder_carry.gx_runtime.decoder().buffered_bytes(), 1);
        assert_eq!(
            decoder_carry.begin_disc_boot(u64::from(CISO_HEADER_BYTES)),
            Err(BrowserDiscBootError::MachineBusy)
        );
        assert_eq!(
            decoder_carry.disc_boot.status(),
            BrowserDiscBootStatus::Idle
        );

        let mut gather_carry = BrowserMachine::from_system(test_system()).unwrap();
        pi::fifo_push(&mut gather_carry.system, 0x61_u8);
        assert_eq!(pi::fifo_pending_bytes(&gather_carry.system), 1);
        assert_eq!(
            gather_carry.begin_disc_boot(u64::from(CISO_HEADER_BYTES)),
            Err(BrowserDiscBootError::MachineBusy)
        );
        assert_eq!(gather_carry.disc_boot.status(), BrowserDiscBootStatus::Idle);
    }

    #[test]
    fn guest_pi_fifo_reset_clears_decoder_carry_without_rewriting_fifo_position() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        queue_gx_bytes(&mut machine, &[0x61]);
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        assert_eq!(machine.gx_runtime.decoder().buffered_bytes(), 1);

        {
            let fifo = &mut machine.system.gpu.cmd.fifo;
            fifo.start = Address(0x100);
            fifo.end = Address(0x1e0);
            fifo.write_ptr = Address(0x160);
            fifo.read_ptr = Address(0x120);
            fifo.distance = 0x40;
        }
        let before = machine.system.gpu.cmd.fifo.clone();
        resident_mmio_write(&mut machine, 0x0c00_3018, 1, 0);
        assert!(machine.system.gpu.cmd.resident_fifo_reset_pending());
        assert_eq!(machine.gx_runtime.decoder().buffered_bytes(), 1);

        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        assert!(!machine.system.gpu.cmd.resident_fifo_reset_pending());
        assert_eq!(machine.gx_runtime.decoder().buffered_bytes(), 0);
        assert_eq!(machine.system.gpu.cmd.fifo.start, before.start);
        assert_eq!(machine.system.gpu.cmd.fifo.end, before.end);
        assert_eq!(machine.system.gpu.cmd.fifo.write_ptr, before.write_ptr);
        assert_eq!(machine.system.gpu.cmd.fifo.read_ptr, before.read_ptr);
        assert_eq!(machine.system.gpu.cmd.fifo.distance, before.distance);

        // This standalone NOP must decode independently. If the pre-reset SetBP opcode survived,
        // it would instead remain buffered waiting for its four-byte payload.
        queue_gx_bytes(&mut machine, &[0]);
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        assert_eq!(machine.gx_runtime.decoder().buffered_bytes(), 0);
    }

    #[test]
    fn texture_receipt_preflights_atomically_then_scatters_hashes_and_releases_barrier() {
        const DESTINATION: u32 = 0x4000;

        let mut malformed = BrowserMachine::from_system(test_system()).unwrap();
        queue_gx_bytes(&mut malformed, &gx_texture_terminal(DESTINATION));
        assert_eq!(
            malformed.service_due_resident_events(),
            ResidentEventService::Deferred
        );
        let malformed_request = malformed.render_request(0).unwrap();
        malformed.system.mem.ram_mut()[DESTINATION as usize..DESTINATION as usize + 128].fill(0x6d);
        let before =
            malformed.system.mem.ram()[DESTINATION as usize..DESTINATION as usize + 128].to_vec();
        assert_eq!(
            malformed.complete_render_request(
                malformed_request,
                render_completion(
                    malformed_request,
                    HostCompletionStatus::Ok,
                    (RenderReceipt::BYTE_LEN - 1) as u32,
                ),
            ),
            Err(BrowserRenderError::Completion(
                RenderCompletionError::InvalidFilledLength
            ))
        );
        assert_eq!(
            &malformed.system.mem.ram()[DESTINATION as usize..DESTINATION as usize + 128],
            before.as_slice()
        );
        assert!(malformed.machine_exit.is_some());

        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        queue_gx_bytes(&mut machine, &gx_texture_terminal(DESTINATION));
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Deferred
        );
        let request = machine.render_request(0).unwrap();
        let filled_len = stage_completed_render(
            &mut machine,
            request,
            RenderReceiptKind::TextureCopy,
            1,
            0xa7,
        );
        machine.system.cpu.reservation.reserve(Address(DESTINATION));
        assert_eq!(
            machine.complete_render_request(
                request,
                render_completion(request, HostCompletionStatus::Ok, filled_len as u32),
            ),
            Ok(BrowserRenderCompletion::Committed)
        );
        assert!(!machine.system.cpu.reservation.is_valid());
        assert_eq!(
            machine.gx_runtime.pending_barrier(),
            None,
            "the compact bytes must be hashed and recorded before decoder acknowledgement"
        );
        assert!(
            machine.system.mem.ram()[DESTINATION as usize..DESTINATION as usize + 32]
                .iter()
                .all(|byte| *byte == 0xa7)
        );
    }

    #[test]
    fn vi_transient_invalid_dimensions_are_consumed_before_authenticated_presentation() {
        const DESTINATION: u32 = 0x8000;
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.system.scheduler.advance(1);
        machine.refresh_machine_evidence_scheduler(None);
        queue_gx_bytes(&mut machine, &gx_xfb_terminal(DESTINATION));
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Deferred
        );
        let xfb_request = machine.render_request(0).unwrap();
        let work = ScanoutWork {
            scheduled_cycle: 1,
            observed_cycle: 1,
            cycles_late: 0,
            field: Field::Top,
            address: Some(Address(DESTINATION)),
            dimensions: ScanoutDimensions {
                picture_configuration: 0,
                words_per_line: 0,
                standard_words_per_line: 0,
                active_lines: 4,
                width: 4,
                field_stride_bytes: 32,
                field_height: 4,
                row_repeat: 1,
                height: 4,
                policy: ScanoutPolicy::Direct,
            },
            snapshot: ScanoutSnapshot::default(),
        };
        machine.pending_vi_work = Some(work);
        assert_eq!(
            machine.service_pending_vi_presentation(),
            ResidentEventService::Deferred
        );
        assert_eq!(machine.pending_vi_work, Some(work));

        let filled_len =
            stage_completed_render(&mut machine, xfb_request, RenderReceiptKind::XfbCopy, 1, 0);
        assert_eq!(
            machine.complete_render_request(
                xfb_request,
                render_completion(xfb_request, HostCompletionStatus::Ok, filled_len as u32,),
            ),
            Ok(BrowserRenderCompletion::Committed)
        );

        let invalid_dimensions = [
            ScanoutDimensions {
                width: 0,
                ..work.dimensions
            },
            ScanoutDimensions {
                field_stride_bytes: 0,
                ..work.dimensions
            },
            ScanoutDimensions {
                active_lines: 0,
                field_height: 0,
                height: 0,
                ..work.dimensions
            },
        ];
        for dimensions in invalid_dimensions {
            machine.pending_vi_work = Some(ScanoutWork { dimensions, ..work });
            assert_eq!(
                machine.service_pending_vi_presentation(),
                ResidentEventService::Complete
            );
            assert!(machine.pending_vi_work.is_none());
            assert_eq!(machine.pending_render_requests(), 0);
            assert!(machine.machine_exit.is_none());
        }

        machine.pending_vi_work = Some(work);
        assert_eq!(
            machine.service_pending_vi_presentation(),
            ResidentEventService::Deferred
        );
        assert!(machine.pending_vi_work.is_none());
        let vi_request = machine.render_request(0).unwrap();
        assert_ne!(vi_request.flags & RENDER_REQUEST_VI_PRESENT, 0);

        let staging = machine.render_receipt_staging_mut(vi_request).unwrap();
        assert_eq!(staging.len(), RenderReceipt::BYTE_LEN);
        let mut receipt = RenderReceipt::new(
            render_sequence(vi_request),
            RenderReceiptKind::ViPresent,
            RenderReceiptStatus::Completed,
            1,
        );
        receipt.flags = RENDER_RECEIPT_HAS_PRESENTATION;
        receipt.presentation_epoch = 1;
        receipt.presentation_width = 4;
        receipt.presentation_height = 4;
        receipt.presentation_serial_lo = 7;
        receipt.presentation_status_raw = lazuli_abi::RenderPresentationStatus::Presented as u32;
        assert!(receipt.encode_le(staging));
        assert_eq!(
            machine.complete_render_request(
                vi_request,
                render_completion(
                    vi_request,
                    HostCompletionStatus::Ok,
                    RenderReceipt::BYTE_LEN as u32,
                ),
            ),
            Ok(BrowserRenderCompletion::Committed)
        );

        let snapshot = *machine.machine_evidence_snapshot().unwrap();
        assert_ne!(snapshot.flags & lazuli_abi::MACHINE_EVIDENCE_HAS_XFB_VI, 0);
        assert_eq!(snapshot.graphics.xfb_copies.get(), 1);
        assert_eq!(snapshot.graphics.presented_frames.get(), 1);
        assert_eq!(snapshot.xfb_vi.xfb_generation, 1);
        assert_eq!(snapshot.xfb_vi.xfb_completion_cycle.get(), 1);
        assert_eq!(snapshot.xfb_vi.vi_selection_cycle.get(), 1);
        assert_eq!(snapshot.xfb_vi.render_completion_cycle.get(), 1);
        assert_eq!(snapshot.xfb_vi.render_sequence.get(), 2);
        assert_eq!(snapshot.xfb_vi.presentation_serial.get(), 7);
        assert_eq!(snapshot.xfb_vi.output_width, 4);
        assert_eq!(snapshot.xfb_vi.output_height, 4);
    }

    #[test]
    fn vi_all_other_scanout_rejections_remain_fail_closed_at_machine_policy() {
        let rejections = [
            ViScanoutRejection::SubmissionInProgress,
            ViScanoutRejection::MissingAddress,
            ViScanoutRejection::InvalidTiming,
            ViScanoutRejection::XfbWidthMismatch {
                scanout_width: 4,
                xfb_width: 8,
            },
            ViScanoutRejection::XfbStrideMismatch {
                field_stride_bytes: 32,
                xfb_stride: 24,
            },
            ViScanoutRejection::XfbRowsOutOfRange,
            ViScanoutRejection::StaleScanout {
                scheduled_cycle: 1,
                last_accepted_cycle: 1,
            },
            ViScanoutRejection::PairEpochExhausted,
            ViScanoutRejection::HandoffIdentityExhausted,
            ViScanoutRejection::InternalPlanInvariant,
        ];
        for rejection in rejections {
            let mut machine = BrowserMachine::from_system(test_system()).unwrap();
            assert_eq!(
                machine.handle_vi_scanout_rejection(rejection),
                ResidentEventService::MachineExit
            );
            let outcome = machine
                .machine_exit
                .expect("VI rejection must publish a fault");
            assert_eq!(outcome.reason(), Ok(RunReason::Fault));
            assert_eq!(
                outcome.detail,
                ResidentMachineExitDetail::ViRenderError as u32
            );
        }
    }

    fn write_be_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
    }

    fn disc_fixture() -> Vec<u8> {
        const GAMECUBE_MAGIC: u32 = 0xc233_9f3d;
        const BOOT_OFFSET: usize = 0x3000;
        const FST_OFFSET: usize = 0xf_0000;
        const TEXT_FILE_OFFSET: usize = 0x100;
        const TEXT_TARGET: u32 = 0x8001_0000;
        const TEXT_BYTES: usize = 0x9_0005;

        let mut image = vec![0; 0x10_0000];
        image[..10].copy_from_slice(b"GZLE01\0\x02\0\x20");
        image[0x20..0x38].copy_from_slice(b"Rust Browser DI Slice\0\0\0");
        write_be_u32(&mut image, 0x1c, GAMECUBE_MAGIC);
        write_be_u32(&mut image, 0x420, BOOT_OFFSET as u32);
        write_be_u32(&mut image, 0x424, FST_OFFSET as u32);
        write_be_u32(&mut image, 0x428, 13);
        write_be_u32(&mut image, 0x42c, 47);
        image[0x440..0x600].fill(0x41);
        image[0x800..0xa00].fill(0x82);
        image[0xc00..0xe00].fill(0xc3);

        let dol = &mut image[BOOT_OFFSET..BOOT_OFFSET + 0x100];
        write_be_u32(dol, 0x00, TEXT_FILE_OFFSET as u32);
        write_be_u32(dol, 0x48, TEXT_TARGET);
        write_be_u32(dol, 0x90, TEXT_BYTES as u32);
        write_be_u32(dol, 0xe0, TEXT_TARGET);
        for (index, byte) in image
            [BOOT_OFFSET + TEXT_FILE_OFFSET..BOOT_OFFSET + TEXT_FILE_OFFSET + TEXT_BYTES]
            .iter_mut()
            .enumerate()
        {
            *byte = 1 + (index as u8 % 251);
        }
        image[FST_OFFSET..FST_OFFSET + 13]
            .copy_from_slice(&[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
        image
    }

    fn sparse_ciso_fixture(logical: &[u8], block_bytes: usize) -> Vec<u8> {
        let mut header = vec![0; CISO_HEADER_BYTES as usize];
        header[..4].copy_from_slice(b"CISO");
        header[4..8].copy_from_slice(&(block_bytes as u32).to_le_bytes());
        let mut physical = Vec::new();
        for (index, block) in logical.chunks(block_bytes).enumerate() {
            if block.iter().any(|byte| *byte != 0) {
                header[8 + index] = 1;
                let mut padded = vec![0; block_bytes];
                padded[..block.len()].copy_from_slice(block);
                physical.extend_from_slice(&padded);
            }
        }
        header.extend(physical);
        header
    }

    fn commit_disc_fixture(machine: &mut BrowserMachine, source: &[u8]) {
        machine.begin_disc_boot(source.len() as u64).unwrap();
        while machine.disc_boot().status() != BrowserDiscBootStatus::Committed {
            let requests: Vec<_> = (0..machine.disc_boot().pending_count())
                .filter_map(|index| machine.disc_boot_request(index))
                .collect();
            assert!(!requests.is_empty());
            for request in requests {
                let start = request.container_offset as usize;
                let end = start + request.length as usize;
                machine
                    .disc_boot_staging_mut(request)
                    .unwrap()
                    .copy_from_slice(&source[start..end]);
                machine.complete_disc_boot(request, request.length).unwrap();
            }
        }
    }

    fn resident_mmio_write(machine: &mut BrowserMachine, address: u32, value: u32, cycle: u64) {
        let prior_vi_reschedules = machine.system.video.resident_timing_reschedules();
        let result = MachineRuntimeHooks::write_slow_classified_at(
            &mut machine.system,
            Address(address),
            value,
            cycle,
        )
        .unwrap();
        assert_eq!(result.boundary, HookMemoryBoundary::Device);
        assert_eq!(
            machine.apply_memory_hook_result(result, cycle, prior_vi_reschedules),
            HookOutcome::Complete
        );
    }

    fn program_resident_mmio_read(
        machine: &mut BrowserMachine,
        disc_offset: u32,
        dma_address: u32,
        length: u32,
        cycle: u64,
    ) -> u64 {
        // A committed HLE boot enables DR and the default Dolphin OS DBAT1, so guest MMIO uses
        // its canonical uncached effective alias rather than a real-mode physical address.
        resident_mmio_write(machine, 0xcc00_6008, 0xa800_0000, cycle);
        resident_mmio_write(machine, 0xcc00_600c, disc_offset / 4, cycle);
        resident_mmio_write(machine, 0xcc00_6010, length, cycle);
        resident_mmio_write(machine, 0xcc00_6014, dma_address, cycle);
        resident_mmio_write(machine, 0xcc00_6018, length, cycle);
        resident_mmio_write(machine, 0xcc00_601c, 3, cycle);
        machine
            .system
            .disk
            .resident_deadlines()
            .completion
            .expect("the scalar control write must begin the resident DI command")
    }

    fn enable_hashed_mapping(system: &mut System, effective_page: u32, physical_page: u32) -> u32 {
        let segment = 0x0000_0042;
        system
            .cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(true);
        system.cpu.supervisor.memory.sr[(effective_page >> 28) as usize] = segment;
        system.cpu.supervisor.memory.sdr1 = 0;
        let vector = page_table_vector(effective_page, segment, 0);
        system.write_phys_slow(Address(vector.primary_pteg), vector.primary_pte0);
        system.write_phys_slow(Address(vector.primary_pteg + 4), physical_page | 2_u32);
        vector.primary_pteg + 4
    }

    fn write_dsp_ucode(system: &mut System, words: &[u16]) {
        const BOOTSTRAP: u32 = 0x0100_0000;
        system.mem.ram_mut()[BOOTSTRAP as usize..BOOTSTRAP as usize + 1024].fill(0);
        for (index, word) in words.iter().copied().enumerate() {
            system.write_phys_slow(Address(BOOTSTRAP + index as u32 * 2), word);
        }
        system.dsp.control.set_reset(true);
        system.dsp.control.set_reset_high(false);
        system.dsp.control.set_halt(false);
    }

    fn mark_legacy_event(system: &mut System) {
        system.cpu.user.gpr[0] = 0xfeed_beef;
    }

    fn arm_compile_install(machine: &mut BrowserMachine, identity: ResidentBlockInstallIdentity) {
        let bindings = core_run::SliceBindings {
            context: 0x1000,
            cpu: 0x2000,
            fastmem: 0x3000,
            pc_offset: 0x40,
            control: 0x1000,
            generation: 1,
            pc: machine.system.cpu.pc.value(),
            now: 0,
            next_deadline: Some(lazuli::system::dspi::DSP_EXECUTION_QUANTUM_CPU_CYCLES),
            current_block: None,
        };
        let begins_outer_slice = machine.run_coordinator.is_quiescent();
        machine
            .run_coordinator
            .begin_slice(bindings, 1_000, 100)
            .unwrap();
        if begins_outer_slice {
            machine.machine_evidence_outer_active = true;
        }
        let token = machine.run_coordinator.plan().token();
        assert_eq!(
            machine
                .run_coordinator
                .finish_slice(
                    token,
                    core_run::DispatchReport {
                        instructions: 0,
                        cycles: 0,
                        blocks: 0,
                        reason: ppcwasmjit::DispatchReason::MetadataMiss,
                    },
                )
                .unwrap(),
            core_run::FinishSlice::PrepareCompile(ppcwasmjit::DispatchReason::MetadataMiss)
        );
        machine
            .run_coordinator
            .compile_required(identity, lazuli_abi::SharedPtr(0x4000))
            .unwrap();
    }

    fn arm_resident_dispatch(
        machine: &mut BrowserMachine,
        cycle_budget: u64,
        block_budget: u32,
    ) -> u64 {
        let bindings = core_run::SliceBindings {
            context: 0x1000,
            cpu: 0x2000,
            fastmem: 0x3000,
            pc_offset: 0x40,
            control: 0x1000,
            generation: 1,
            pc: machine.system.cpu.pc.value(),
            now: machine.system.scheduler.canonical_elapsed(),
            next_deadline: None,
            current_block: None,
        };
        let begins_outer_slice = machine.run_coordinator.is_quiescent();
        assert_eq!(
            machine
                .run_coordinator
                .begin_slice(bindings, cycle_budget, block_budget),
            Ok(core_run::BeginSlice::Dispatch)
        );
        if begins_outer_slice {
            machine.machine_evidence_outer_active = true;
        }
        machine.resident_context.control.clear_for_slice();
        machine.run_coordinator.plan().token()
    }

    fn install_volatile_idle_test_block(
        machine: &mut BrowserMachine,
    ) -> core_run::CurrentBlockMetadata {
        const PC: u32 = 0x1000;
        // lwz r3, 0(r4); cmpwi r3, 0; beq -8. This is the shared frontend's generic
        // IdleVolatileRead pattern, not a BrowserMachine-local loop classifier.
        for (index, word) in [0x8064_0000_u32, 0x2c03_0000, 0x4182_fff8]
            .into_iter()
            .enumerate()
        {
            machine
                .system_mut()
                .write_phys_slow(Address(PC + index as u32 * 4), word);
        }
        machine.system_mut().cpu.pc = Address(PC);
        let prepared = machine
            .prepare_current_pc_compile_at(lazuli_abi::SharedPtr(0x0020_0000))
            .unwrap();
        let identity = prepared.request.install_identity();
        machine
            .cold_compile
            .begin_self_install(identity, AddressSpaceGeneration(1))
            .unwrap();
        let installed = machine
            .cold_compile
            .commit_self_install(identity, AddressSpaceGeneration(1))
            .unwrap();
        assert!(machine.discard_pending_installable(identity));
        assert_eq!(
            installed.block.pattern,
            ppcwasmjit::Pattern::IdleVolatileRead as u8 as u32
        );
        let metadata = machine.current_block_metadata().unwrap();
        assert_eq!(metadata.generation, 1);
        assert_eq!(metadata.pc, PC);
        assert_eq!(metadata.table_slot, installed.block.table_slot);
        assert_eq!(metadata.slot_nonce, installed.block.slot_nonce);
        assert_eq!(metadata.pattern, installed.block.pattern);
        assert_eq!(metadata.maximum_cycles, installed.block.maximum_cycles);
        metadata
    }

    fn idle_test_bindings(
        machine: &BrowserMachine,
        current_block: core_run::CurrentBlockMetadata,
    ) -> core_run::SliceBindings {
        let now = machine.system.scheduler.canonical_elapsed();
        core_run::SliceBindings {
            context: 0x1000,
            cpu: 0x2000,
            fastmem: 0x3000,
            pc_offset: 0x40,
            control: 0x4000,
            generation: machine.runtime_hooks.current_generation().0,
            pc: machine.system.cpu.pc.value(),
            now,
            next_deadline: machine.next_resident_deadline_at(now),
            current_block: Some(current_block),
        }
    }

    #[test]
    fn active_disc_boot_seals_cpu_dispatch_until_commit_or_cancel() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.system.cpu.pc = Address(0x8000_3100);
        let pc_before = machine.system.cpu.pc;
        let plan_before = *machine.run_coordinator.plan();

        machine
            .begin_disc_boot(u64::from(CISO_HEADER_BYTES))
            .unwrap();
        assert_eq!(machine.disc_boot.status(), BrowserDiscBootStatus::Planning);
        assert!(machine.disc_boot_blocks_cpu_dispatch());
        assert_eq!(machine.system.cpu.pc, pc_before);
        assert_eq!(*machine.run_coordinator.plan(), plan_before);
        assert_eq!(
            machine.disc_boot_wait_outcome.reason(),
            Ok(RunReason::BudgetExhausted)
        );
        assert_eq!(
            machine.disc_boot_wait_outcome.detail,
            core_run::RunOutcomeDetail::DiscBootWait as u32
        );

        assert!(machine.cancel_disc_boot());
        assert!(!machine.disc_boot_blocks_cpu_dispatch());
    }

    #[test]
    fn disc_boot_start_rejects_an_active_core_slice_without_mutation() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let token = arm_resident_dispatch(&mut machine, 100, 2);
        assert_eq!(
            machine.begin_disc_boot(u64::from(CISO_HEADER_BYTES)),
            Err(BrowserDiscBootError::MachineBusy)
        );
        assert_eq!(machine.disc_boot.status(), BrowserDiscBootStatus::Idle);
        assert_eq!(machine.run_coordinator.plan().token(), token);
        assert!(machine.run_coordinator.authorizes_resident_hook_cycle(0));
    }

    #[test]
    fn terminal_disc_boot_identity_is_published_only_after_the_machine_handoff() {
        let source = disc_fixture();
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        commit_disc_fixture(&mut machine, &source);

        let snapshot = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(
            snapshot.header.byte_len as usize,
            MachineEvidenceV1::BYTE_LEN
        );
        assert_eq!(
            snapshot.boot.status(),
            Ok(lazuli_abi::MachineBootStatus::Committed)
        );
        assert_eq!(snapshot.boot.identifier(), *b"GZLE01");
        assert_eq!(snapshot.boot.revision, 2);
        assert_eq!(snapshot.boot.disc_number, 0);
        assert_eq!(snapshot.boot.logical_bytes.get(), source.len() as u64);
        assert_ne!(
            snapshot.flags & lazuli_abi::MACHINE_EVIDENCE_HAS_BOOT_IDENTITY,
            0
        );
    }

    #[test]
    fn post_commit_disc_configuration_failure_never_publishes_committed_evidence() {
        let source = disc_fixture();
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.begin_disc_boot(source.len() as u64).unwrap();
        let mut configuration_blocked = false;
        let (terminal_error, failed_request) = 'boot: loop {
            let requests: Vec<_> = (0..machine.disc_boot().pending_count())
                .filter_map(|index| machine.disc_boot_request(index))
                .collect();
            assert!(!requests.is_empty());
            for request in requests {
                let start = request.container_offset as usize;
                let end = start + request.length as usize;
                machine
                    .disc_boot_staging_mut(request)
                    .unwrap()
                    .copy_from_slice(&source[start..end]);
                if machine.disc_boot().status() == BrowserDiscBootStatus::Loading
                    && !configuration_blocked
                {
                    machine.system.disk.program_resident_control(1).unwrap();
                    configuration_blocked = true;
                }
                if let Err(error) = machine.complete_disc_boot(request, request.length) {
                    break 'boot (error, request);
                }
            }
        };

        assert!(configuration_blocked);
        assert_eq!(
            terminal_error,
            BrowserDiscBootError::DiscConfiguration(
                lazuli::system::di::ResidentDiscConfigError::StartPending
            )
        );
        assert_ne!(
            terminal_error.call_result(),
            crate::disc_boot::BrowserDiscBootCallResult::Committed
        );
        assert_eq!(
            machine.disc_boot().status(),
            BrowserDiscBootStatus::Committed
        );
        let snapshot = *machine.machine_evidence_snapshot().unwrap();
        assert_ne!(
            snapshot.boot.status(),
            Ok(lazuli_abi::MachineBootStatus::Committed)
        );
        assert_eq!(
            snapshot.flags & lazuli_abi::MACHINE_EVIDENCE_HAS_BOOT_IDENTITY,
            0
        );
        assert_eq!(snapshot.boot.identifier(), [0; 6]);
        assert!(
            machine
                .complete_disc_boot(failed_request, failed_request.length)
                .is_err()
        );
        let retried_snapshot = *machine.machine_evidence_snapshot().unwrap();
        assert_ne!(
            retried_snapshot.boot.status(),
            Ok(lazuli_abi::MachineBootStatus::Committed)
        );
        assert_eq!(
            retried_snapshot.flags & lazuli_abi::MACHINE_EVIDENCE_HAS_BOOT_IDENTITY,
            0
        );
    }

    #[test]
    fn poisoned_terminal_boot_handoff_returns_machine_handoff_and_retains_loading_snapshot() {
        let source = disc_fixture();
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.begin_disc_boot(source.len() as u64).unwrap();
        let mut poisoned_loading_snapshot = None;
        let terminal_error = loop {
            let requests: Vec<_> = (0..machine.disc_boot().pending_count())
                .filter_map(|index| machine.disc_boot_request(index))
                .collect();
            assert!(!requests.is_empty());
            let mut terminal_error = None;
            for request in requests {
                let start = request.container_offset as usize;
                let end = start + request.length as usize;
                machine
                    .disc_boot_staging_mut(request)
                    .unwrap()
                    .copy_from_slice(&source[start..end]);
                if machine.disc_boot().status() == BrowserDiscBootStatus::Loading
                    && poisoned_loading_snapshot.is_none()
                {
                    poisoned_loading_snapshot = Some(*machine.machine_evidence_snapshot().unwrap());
                    machine.machine_evidence.refresh_scheduler_identity(
                        machine.system.scheduler.elapsed(),
                        machine.system.cpu.pc.0,
                        0,
                        None,
                    );
                    assert!(!machine.machine_evidence.is_healthy());
                }
                if let Err(error) = machine.complete_disc_boot(request, request.length) {
                    terminal_error = Some(error);
                    break;
                }
            }
            if let Some(error) = terminal_error {
                break error;
            }
        };

        assert_eq!(terminal_error, BrowserDiscBootError::MachineHandoff);
        assert_ne!(
            terminal_error.call_result(),
            crate::disc_boot::BrowserDiscBootCallResult::Committed
        );
        assert_eq!(
            machine.disc_boot().status(),
            BrowserDiscBootStatus::Committed
        );
        assert!(machine.machine_evidence_snapshot().is_none());
        let retained = machine.machine_evidence.snapshot;
        assert_eq!(Some(retained), poisoned_loading_snapshot);
        assert_eq!(
            retained.boot.status(),
            Ok(lazuli_abi::MachineBootStatus::Loading)
        );
        assert_eq!(
            retained.flags & lazuli_abi::MACHINE_EVIDENCE_HAS_BOOT_IDENTITY,
            0
        );
        assert_eq!(retained.boot.identifier(), [0; 6]);
    }

    #[test]
    fn resident_scalar_di_mmio_reaches_physical_host_read_and_exact_atomic_commit() {
        let source = disc_fixture();
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        commit_disc_fixture(&mut machine, &source);
        let dma_address = 0x20_000;
        let disc_offset = 0x800;
        let length = 0x400;
        machine.system.mem.ram_mut()[dma_address as usize..(dma_address + length) as usize]
            .fill(0xcc);
        machine.system.cpu.reservation.reserve(Address(dma_address));

        let cycle = machine.system.scheduler.elapsed();
        let completion =
            program_resident_mmio_read(&mut machine, disc_offset, dma_address, length, cycle);
        assert_eq!(
            machine
                .event_deadlines
                .deadline(MachineEventKind::DiskCompletion),
            Some(completion)
        );
        let before_host = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(before_host.di.command_starts.get(), 1);
        assert_eq!(before_host.di.read_starts.get(), 1);
        assert_eq!(before_host.di.read_sector_starts.get(), 1);
        assert_eq!(before_host.di.read_disc_id_starts.get(), 0);
        assert_eq!(
            before_host.di.current_state(),
            Ok(MachineDiLifecycleState::AwaitingHost)
        );
        assert_eq!(
            before_host.di.current_kind(),
            Ok(MachineDiCommandKind::ReadSector)
        );
        assert_eq!(before_host.di.physical_host_requests_issued.get(), 0);
        assert_eq!(before_host.di.physical_host_request_pending, 0);

        // Isolate this vector to the authored disk deadline. The normal selector/order is still
        // used; unrelated periodic devices are covered by their own resident phase vectors.
        machine.event_deadlines = MachineEventDeadlines::default();
        machine
            .system
            .disk
            .publish_resident_deadlines(&mut machine.event_deadlines);
        machine.system.scheduler.advance(completion);
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Deferred
        );
        let request = machine.di_read_request().unwrap().unwrap();
        assert_eq!(request.container_offset, u64::from(disc_offset));
        assert_eq!(request.length, length);
        assert_eq!(machine.di_read_request(), Ok(Some(request)));
        let host_pending = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(host_pending.di.physical_host_requests_issued.get(), 1);
        assert_eq!(host_pending.di.physical_host_request_pending, 1);
        assert_eq!(host_pending.di.host_receipts_succeeded.get(), 0);
        assert_eq!(host_pending.di.host_receipts_failed.get(), 0);
        assert_eq!(host_pending.di.physical_host_requests_cancelled.get(), 0);

        let malformed = ReadRequest {
            id: request.id + 1,
            ..request
        };
        assert!(
            machine
                .complete_di_read(malformed, malformed.length, HostCompletionStatus::Ok as u32,)
                .is_err()
        );
        assert_eq!(
            machine.complete_di_read(request, request.length, u32::MAX),
            Err(BrowserDiError::InvalidHostStatus(u32::MAX))
        );
        assert_eq!(machine.di_read_request(), Ok(Some(request)));
        let rejected = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(rejected.di.physical_host_requests_issued.get(), 1);
        assert_eq!(rejected.di.host_receipts_rejected.get(), 2);
        assert_eq!(rejected.di.physical_host_request_pending, 1);
        assert_eq!(rejected.di.host_receipts_succeeded.get(), 0);
        assert_eq!(rejected.di.host_receipts_failed.get(), 0);
        assert_eq!(rejected.di.physical_host_requests_cancelled.get(), 0);
        assert_eq!(
            &machine.system.mem.ram()[dma_address as usize..(dma_address + length) as usize],
            &[0xcc; 0x400]
        );
        assert_eq!(machine.system.disk.dma_base, Address(dma_address));
        assert_eq!(machine.system.disk.dma_length, length);
        assert!(machine.system.cpu.reservation.is_valid());

        let fetched = source[disc_offset as usize..(disc_offset + length) as usize].to_vec();
        machine
            .di_read_staging_mut(request)
            .unwrap()
            .copy_from_slice(&fetched);
        assert_eq!(
            machine.complete_di_read(request, request.length, HostCompletionStatus::Ok as u32,),
            Ok(BrowserDiCallResult::LogicalWindowReady)
        );
        let host_completed = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(host_completed.di.physical_host_requests_issued.get(), 1);
        assert_eq!(host_completed.di.host_receipts_succeeded.get(), 1);
        assert_eq!(host_completed.di.host_receipts_failed.get(), 0);
        assert_eq!(host_completed.di.physical_host_request_pending, 0);
        assert_eq!(host_completed.di.logical_windows_ready.get(), 1);
        assert_eq!(host_completed.di.read_completions.get(), 0);
        assert_eq!(
            host_completed.di.current_state(),
            Ok(MachineDiLifecycleState::ReadReady)
        );
        // Host completion only seals DI's private payload; MEM1 and DMA registers remain atomic
        // until the exact already-authored Rust completion deadline is serviced.
        assert_eq!(
            &machine.system.mem.ram()[dma_address as usize..(dma_address + length) as usize],
            &[0xcc; 0x400]
        );
        assert_eq!(machine.system.disk.dma_base, Address(dma_address));
        assert_eq!(machine.system.disk.dma_length, length);
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        assert_eq!(
            &machine.system.mem.ram()[dma_address as usize..(dma_address + length) as usize],
            &source[disc_offset as usize..(disc_offset + length) as usize]
        );
        assert_eq!(machine.system.disk.dma_base, Address(dma_address + length));
        assert_eq!(machine.system.disk.dma_length, 0);
        assert!(!machine.system.cpu.reservation.is_valid());
        let completed = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(completed.di.command_completions.get(), 1);
        assert_eq!(completed.di.read_completions.get(), 1);
        assert_eq!(
            completed.di.current_state(),
            Ok(MachineDiLifecycleState::Idle)
        );
        assert_eq!(completed.di.current_kind(), Ok(MachineDiCommandKind::None));
        assert_eq!(
            machine.complete_di_read(request, request.length, HostCompletionStatus::Ok as u32,),
            Err(BrowserDiError::Mapper(
                lazuli::disks::async_boot::CommittedDiscReadError::StaleRequest { id: request.id }
            ))
        );
        let duplicate = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(duplicate.di.physical_host_requests_issued.get(), 1);
        assert_eq!(duplicate.di.host_receipts_succeeded.get(), 1);
        assert_eq!(duplicate.di.host_receipts_rejected.get(), 3);
        assert_eq!(duplicate.di.physical_host_request_pending, 0);
    }

    #[test]
    fn inquiry_snapshots_distinguish_never_started_pending_and_completed() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let never_started = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(never_started.di.command_starts.get(), 0);
        assert_eq!(never_started.di.inquiry_starts.get(), 0);
        assert_eq!(
            never_started.di.current_state(),
            Ok(MachineDiLifecycleState::Idle)
        );

        let start = {
            let System { disk, mem, cpu, .. } = &mut machine.system;
            disk.write_resident_command_word(0, 0x1200_0000).unwrap();
            disk.write_resident_dma_address(0x200).unwrap();
            disk.write_resident_dma_length(0x20).unwrap();
            disk.write_resident_control(3, 100, mem.ram_mut(), &mut cpu.reservation)
                .unwrap()
                .unwrap()
        };
        let pending = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(pending.di.command_starts.get(), 1);
        assert_eq!(pending.di.inquiry_starts.get(), 1);
        assert_eq!(pending.di.command_completions.get(), 0);
        assert_eq!(pending.di.inquiry_completions.get(), 0);
        assert_eq!(pending.di.physical_host_requests_issued.get(), 0);
        assert_eq!(
            pending.di.current_state(),
            Ok(MachineDiLifecycleState::AwaitingDeadline)
        );
        assert_eq!(pending.di.current_kind(), Ok(MachineDiCommandKind::Inquiry));

        machine.system.scheduler.advance(start.completion_cycle);
        let completion = {
            let System { disk, mem, cpu, .. } = &mut machine.system;
            disk.service_resident(start.completion_cycle, mem.ram_mut(), &mut cpu.reservation)
                .command
        };
        assert!(matches!(completion, ResidentServiceState::Completed(_)));
        let completed = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(completed.di.command_starts.get(), 1);
        assert_eq!(completed.di.command_completions.get(), 1);
        assert_eq!(completed.di.inquiry_starts.get(), 1);
        assert_eq!(completed.di.inquiry_completions.get(), 1);
        assert_eq!(completed.di.command_cancellations.get(), 0);
        assert_eq!(completed.di.inquiry_cancellations.get(), 0);
        assert_eq!(completed.di.physical_host_requests_issued.get(), 0);
        assert_eq!(
            completed.di.current_state(),
            Ok(MachineDiLifecycleState::Idle)
        );
        assert_eq!(completed.di.current_kind(), Ok(MachineDiCommandKind::None));
    }

    #[test]
    fn fully_sparse_di_window_is_ready_without_issuing_a_host_request() {
        const SPARSE_OFFSET: u32 = 0xa_0000;
        const LENGTH: u32 = 0x400;
        const DMA_ADDRESS: u32 = 0x22_000;

        let logical = disc_fixture();
        assert!(
            logical[SPARSE_OFFSET as usize..(SPARSE_OFFSET + LENGTH) as usize]
                .iter()
                .all(|byte| *byte == 0)
        );
        let ciso = sparse_ciso_fixture(&logical, 0x200);
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        commit_disc_fixture(&mut machine, &ciso);
        machine.system.mem.ram_mut()[DMA_ADDRESS as usize..(DMA_ADDRESS + LENGTH) as usize]
            .fill(0xcc);

        let cycle = machine.system.scheduler.elapsed();
        let completion =
            program_resident_mmio_read(&mut machine, SPARSE_OFFSET, DMA_ADDRESS, LENGTH, cycle);
        machine.event_deadlines = MachineEventDeadlines::default();
        machine
            .system
            .disk
            .publish_resident_deadlines(&mut machine.event_deadlines);
        let started = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(started.di.physical_host_requests_issued.get(), 0);
        assert_eq!(started.di.logical_windows_ready.get(), 0);
        assert_eq!(
            started.di.current_state(),
            Ok(MachineDiLifecycleState::AwaitingHost)
        );
        machine.system.scheduler.advance(completion);
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );

        assert_eq!(machine.di_read_request(), Ok(None));
        let completed = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(completed.di.command_starts.get(), 1);
        assert_eq!(completed.di.command_completions.get(), 1);
        assert_eq!(completed.di.read_starts.get(), 1);
        assert_eq!(completed.di.read_completions.get(), 1);
        assert_eq!(completed.di.physical_host_requests_issued.get(), 0);
        assert_eq!(completed.di.physical_host_request_pending, 0);
        assert_eq!(completed.di.logical_windows_ready.get(), 1);
        assert_eq!(
            completed.di.current_state(),
            Ok(MachineDiLifecycleState::Idle)
        );
        assert_eq!(
            &machine.system.mem.ram()[DMA_ADDRESS as usize..(DMA_ADDRESS + LENGTH) as usize],
            &[0; LENGTH as usize]
        );
    }

    #[test]
    fn initial_authoritative_ai_state_schedules_the_first_resident_dtk_batch() {
        let mut system = test_system();
        // AISFR=1 is the effective 48,043 Hz auxiliary rate; PLAY is already asserted before the
        // browser machine takes ownership, so no later AISCR write can be required for coupling.
        system.audio.control = lazuli::system::ai::Control::from_bits(0x0000_0003);
        let mut machine = BrowserMachine::from_system(system).unwrap();

        let config = {
            let System { disk, mem, cpu, .. } = &mut machine.system;
            disk.write_resident_command_word(0, 0xe401_000a).unwrap();
            disk.write_resident_control(1, 0, mem.ram_mut(), &mut cpu.reservation)
                .unwrap()
                .unwrap()
        };
        {
            let System { disk, mem, cpu, .. } = &mut machine.system;
            disk.service_resident(config.completion_cycle, mem.ram_mut(), &mut cpu.reservation);
        }
        const STREAM_CYCLE: u64 = 200_000;
        {
            let System { disk, mem, cpu, .. } = &mut machine.system;
            disk.write_resident_command_word(0, 0xe100_0000).unwrap();
            disk.write_resident_command_word(1, 0x100).unwrap();
            disk.write_resident_command_word(2, 0x1000).unwrap();
            disk.write_resident_control(1, STREAM_CYCLE, mem.ram_mut(), &mut cpu.reservation)
                .unwrap()
                .unwrap();
        }

        let first_batch = STREAM_CYCLE + lazuli::system::di::AUDIO_BATCH_CYCLES;
        assert_eq!(
            machine.system.disk.resident_deadlines().audio,
            Some(first_batch)
        );
        let summary = {
            let System { disk, mem, cpu, .. } = &mut machine.system;
            disk.service_resident(first_batch, mem.ram_mut(), &mut cpu.reservation)
        };
        assert_eq!(summary.audio.batches, 1);
        assert_eq!(summary.audio.blocks, 6);
    }

    #[test]
    fn authenticated_disc_header_seeds_dtk_buffer_before_the_first_e1_command() {
        let mut source = disc_fixture();
        source[8] = 1;
        source[9] = 0x20;
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        commit_disc_fixture(&mut machine, &source);

        assert_eq!(
            machine.system.disk.resident_audio_buffer_configuration(),
            ResidentAudioBufferConfiguration {
                enabled: true,
                buffer_length: 0x20,
            }
        );

        // No E4 configuration command is issued. The first E1 must therefore use only the
        // authenticated commit record derived from header bytes 8 and 9.
        let cycle = machine.system.scheduler.elapsed();
        let stream = {
            let System { disk, mem, cpu, .. } = &mut machine.system;
            disk.write_resident_command_word(0, 0xe100_0000).unwrap();
            disk.write_resident_command_word(1, 0x100).unwrap();
            disk.write_resident_command_word(2, 0x1000).unwrap();
            disk.write_resident_control(1, cycle, mem.ram_mut(), &mut cpu.reservation)
                .unwrap()
                .unwrap()
        };
        assert_eq!(
            stream.kind,
            lazuli::system::di::ResidentCommandKind::AudioStream
        );
        assert_eq!(machine.system.disk.resident_deadlines().audio, None);
        let completion = {
            let System { disk, mem, cpu, .. } = &mut machine.system;
            disk.service_resident(stream.completion_cycle, mem.ram_mut(), &mut cpu.reservation)
        };
        let ResidentServiceState::Completed(completion) = completion.command else {
            panic!("expected header-seeded DTK command completion");
        };
        assert!(completion.successful);
        assert_eq!(completion.error_code, lazuli::system::di::ERROR_NONE);
    }

    #[test]
    fn guest_dvd_reset_retires_inflight_host_identity_without_poisoning_next_read() {
        let source = disc_fixture();
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        commit_disc_fixture(&mut machine, &source);
        let dma_address = 0x28_000;
        let disc_offset = 0x800;
        let length = 0x200;
        machine.system.mem.ram_mut()[dma_address as usize..(dma_address + length) as usize]
            .fill(0xcc);

        let first_cycle = machine.system.scheduler.elapsed();
        let first_completion =
            program_resident_mmio_read(&mut machine, disc_offset, dma_address, length, first_cycle);
        machine.event_deadlines = MachineEventDeadlines::default();
        machine
            .system
            .disk
            .publish_resident_deadlines(&mut machine.event_deadlines);
        machine.system.scheduler.advance(first_completion);
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Deferred
        );
        let stale_request = machine.di_read_request().unwrap().unwrap();
        assert!(machine.di_runtime.active_logical_request().is_some());
        assert!(
            machine
                .disc_boot
                .committed_disc_reader()
                .unwrap()
                .active_identity()
                .is_some()
        );

        let reset_generation = machine.system.disk.resident_reset_generation().value();
        // PI DVD reset is bit 2 at the canonical uncached effective MMIO alias.
        resident_mmio_write(&mut machine, 0xcc00_3024, 1 << 2, first_completion);
        assert_eq!(
            machine.system.disk.resident_reset_generation().value(),
            reset_generation.wrapping_add(1)
        );
        assert!(!machine.system.disk.resident_reset_pending());
        assert!(machine.system.disk.resident_read_request().is_none());
        assert!(machine.di_runtime.active_logical_request().is_none());
        assert!(
            machine
                .disc_boot
                .committed_disc_reader()
                .unwrap()
                .active_identity()
                .is_none()
        );
        assert_eq!(
            machine
                .event_deadlines
                .deadline(MachineEventKind::DiskCompletion),
            None
        );

        let second_cycle = first_completion + 1;
        let second_completion = program_resident_mmio_read(
            &mut machine,
            disc_offset,
            dma_address,
            length,
            second_cycle,
        );
        machine.event_deadlines = MachineEventDeadlines::default();
        machine
            .system
            .disk
            .publish_resident_deadlines(&mut machine.event_deadlines);
        machine
            .system
            .scheduler
            .advance(second_completion - first_completion);
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Deferred
        );
        let current_request = machine.di_read_request().unwrap().unwrap();
        assert_ne!(current_request, stale_request);

        // The late receipt is classified entirely by the committed reader's retired request
        // identity. It cannot consume or mutate the new live request.
        assert_eq!(
            machine.complete_di_read(
                stale_request,
                stale_request.length,
                HostCompletionStatus::Ok as u32,
            ),
            Err(BrowserDiError::Mapper(
                lazuli::disks::async_boot::CommittedDiscReadError::StaleRequest {
                    id: stale_request.id
                }
            ))
        );
        assert_eq!(machine.di_read_request(), Ok(Some(current_request)));
        assert_eq!(
            &machine.system.mem.ram()[dma_address as usize..(dma_address + length) as usize],
            &[0xcc; 0x200]
        );

        machine
            .di_read_staging_mut(current_request)
            .unwrap()
            .copy_from_slice(&source[disc_offset as usize..(disc_offset + length) as usize]);
        assert_eq!(
            machine.complete_di_read(
                current_request,
                current_request.length,
                HostCompletionStatus::Ok as u32,
            ),
            Ok(BrowserDiCallResult::LogicalWindowReady)
        );
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        assert_eq!(
            &machine.system.mem.ram()[dma_address as usize..(dma_address + length) as usize],
            &source[disc_offset as usize..(disc_offset + length) as usize]
        );
        assert!(machine.machine_exit.is_none());
    }

    #[test]
    fn new_boot_is_busy_during_di_and_cancelled_host_receipt_cannot_touch_mem1() {
        let source = disc_fixture();
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        commit_disc_fixture(&mut machine, &source);
        let dma_address = 0x24_000;
        let length = 0x200;
        machine.system.mem.ram_mut()[dma_address as usize..(dma_address + length) as usize]
            .fill(0xcc);
        let cycle = machine.system.scheduler.elapsed();
        program_resident_mmio_read(&mut machine, 0x800, dma_address, length, cycle);
        let request = machine.di_read_request().unwrap().unwrap();

        assert_eq!(
            machine.begin_disc_boot(source.len() as u64),
            Err(BrowserDiscBootError::MachineBusy)
        );
        assert_eq!(
            machine.disc_boot().status(),
            BrowserDiscBootStatus::Committed
        );
        assert_eq!(machine.di_read_request(), Ok(Some(request)));

        assert!(machine.cancel_disc_boot());
        assert_eq!(
            machine.disc_boot().status(),
            BrowserDiscBootStatus::Cancelled
        );
        let cancelled = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(cancelled.di.command_starts.get(), 1);
        assert_eq!(cancelled.di.command_completions.get(), 0);
        assert_eq!(cancelled.di.command_cancellations.get(), 1);
        assert_eq!(cancelled.di.read_starts.get(), 1);
        assert_eq!(cancelled.di.read_completions.get(), 0);
        assert_eq!(cancelled.di.read_cancellations.get(), 1);
        assert_eq!(cancelled.di.physical_host_requests_issued.get(), 1);
        assert_eq!(cancelled.di.physical_host_requests_cancelled.get(), 1);
        assert_eq!(cancelled.di.physical_host_request_pending, 0);
        assert_eq!(
            cancelled.di.current_state(),
            Ok(MachineDiLifecycleState::Idle)
        );
        assert_eq!(
            machine.complete_di_read(request, request.length, HostCompletionStatus::Ok as u32,),
            Err(BrowserDiError::NoCommittedDisc)
        );
        assert_eq!(
            &machine.system.mem.ram()[dma_address as usize..(dma_address + length) as usize],
            &[0xcc; 0x200]
        );
        assert_eq!(machine.system.disk.dma_base, Address(0));
        assert_eq!(machine.system.disk.dma_length, 0);
        assert!(machine.system.disk.resident_read_request().is_none());
        assert_eq!(
            machine
                .event_deadlines
                .deadline(MachineEventKind::DiskCompletion),
            None
        );
    }

    #[test]
    fn resident_time_hooks_observe_exact_two_block_cycle_and_service_the_authored_event() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.system.scheduler.advance(119);
        let token = arm_resident_dispatch(&mut machine, 100, 2);

        // The first block reaches mftb two cycles after the slice began. Canonical time stays put
        // while the lazy time-base read observes the exact instruction boundary.
        machine.resident_context.control.slice_cycle_prefix = 0;
        machine.resident_context.control.instruction_cycle_offset = 2;
        assert_eq!(
            machine.observe_resident_hook(|machine| {
                machine.system.update_time_base();
                HookResult::COMPLETE
            }),
            Some(HookResult::COMPLETE)
        );
        assert_eq!(machine.system.scheduler.canonical_elapsed(), 119);
        assert_eq!(machine.system.lazy.last_updated_tb, 10);
        assert_eq!(machine.system.cpu.supervisor.misc.tb, 10);
        assert!(!machine.system.scheduler.is_observing());
        assert!(!machine.resident_context.control.should_exit());

        // The second block has a 20-cycle completed prefix and reaches mtspr DEC three cycles in.
        // Its relative event is based at 119 + 20 + 3, then forces a hook exit before block three.
        machine.resident_context.control.slice_cycle_prefix = 20;
        machine.resident_context.control.instruction_cycle_offset = 3;
        machine.system.cpu.supervisor.misc.dec = 7;
        machine
            .observe_resident_hook(|machine| machine.system.decrementer_changed())
            .unwrap()
            .unwrap();
        assert_eq!(machine.system.lazy.last_updated_dec, 11);
        assert_eq!(machine.system.scheduler.canonical_elapsed(), 119);
        assert_eq!(machine.system.scheduler.until_next(), Some(109));
        assert!(!machine.system.scheduler.is_observing());
        assert!(machine.resident_context.control.should_exit());

        assert_eq!(
            machine
                .run_coordinator
                .finish_slice(
                    token,
                    core_run::DispatchReport {
                        instructions: 2,
                        cycles: 23,
                        blocks: 2,
                        reason: ppcwasmjit::DispatchReason::HookExit,
                    },
                )
                .unwrap(),
            core_run::FinishSlice::Resume
        );
        assert!(machine.commit_resident_dispatch_cycles(23));
        assert_eq!(machine.system.scheduler.canonical_elapsed(), 142);
        assert_eq!(machine.system.scheduler.until_next(), Some(86));

        machine.system.scheduler.advance(86);
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        assert_eq!(machine.system.cpu.supervisor.misc.dec, u32::MAX);
        assert_eq!(machine.system.scheduler.until_next(), Some(32));
    }

    #[test]
    fn resident_device_hook_defers_pi_until_committed_outer_boundary_and_resynchronizes() {
        use lazuli::runtime_hooks::{HookMemoryBoundary, MemoryHookResult};
        use lazuli::system::gx::cmd::Control;
        use lazuli::system::pi::InterruptSources;

        let mut system = test_system();
        let next_pc = Address(0x8000_1004);
        system.cpu.pc = next_pc;
        system
            .cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(true);
        system
            .cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        system.cpu.supervisor.config.msr.set_interrupts(true);
        system.cpu.supervisor.config.msr.set_exception_prefix(false);
        system.gpu.cmd.control = Control::from_bits(0x0005);
        system.gpu.cmd.fifo.high_mark = 0x40;
        system.gpu.cmd.fifo.distance = 0x60;
        system.gpu.cmd.refresh_interrupt_latches();
        let mut mask = InterruptSources::default();
        mask.set_command_processor(true);
        system.processor.mask.set_sources(mask);

        let mut machine = BrowserMachine::from_system(system).unwrap();
        let generation_before = machine.runtime_hooks.current_generation();
        let token = arm_resident_dispatch(&mut machine, 10, 1);
        let observed = machine
            .observe_resident_hook(|machine| {
                let prior_vi_reschedules = machine.system.video.resident_timing_reschedules();
                machine.apply_memory_hook_result(
                    MemoryHookResult {
                        result: HookResult::COMPLETE,
                        boundary: HookMemoryBoundary::Device,
                        serial_service: Some(si::SerialServiceSummary::default()),
                    },
                    0,
                    prior_vi_reschedules,
                )
            })
            .unwrap();

        assert_eq!(observed, HookOutcome::Complete);
        assert_eq!(machine.system.cpu.pc, next_pc);
        assert_eq!(machine.system.cpu.supervisor.exception.srr[0], 0);
        assert!(machine.resident_context.control.should_exit());
        assert_eq!(
            machine
                .run_coordinator
                .finish_slice(
                    token,
                    core_run::DispatchReport {
                        instructions: 1,
                        cycles: 2,
                        blocks: 1,
                        reason: ppcwasmjit::DispatchReason::HookExit,
                    },
                )
                .unwrap(),
            core_run::FinishSlice::Resume
        );
        assert!(machine.commit_resident_dispatch_cycles(2));

        assert!(machine.prepare_resident_dispatch_boundary());
        assert_eq!(machine.system.cpu.pc, Address(0x0000_0500));
        assert_eq!(
            machine.system.cpu.supervisor.exception.srr[0],
            next_pc.value()
        );
        assert_ne!(
            machine.runtime_hooks.current_generation(),
            generation_before
        );
    }

    #[test]
    fn machine_evidence_counts_every_dispatch_commit_but_only_one_terminal_outer_slice() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.system.cpu.pc = Address(0x8000_3100);
        machine.refresh_machine_evidence_scheduler(None);

        let first_token = arm_resident_dispatch(&mut machine, 100, 4);
        let first = core_run::DispatchReport {
            instructions: 3,
            cycles: 10,
            blocks: 1,
            reason: ppcwasmjit::DispatchReason::HookExit,
        };
        assert_eq!(
            machine
                .run_coordinator
                .finish_slice(first_token, first)
                .unwrap(),
            core_run::FinishSlice::Resume
        );
        assert!(machine.commit_resident_dispatch_cycles(first.cycles));
        machine.record_machine_evidence_dispatch(first);
        let resumed = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(resumed.scheduler.canonical_cycle.get(), 10);
        assert_eq!(resumed.scheduler.executed_cycles.get(), 10);
        assert_eq!(resumed.scheduler.executed_instructions.get(), 3);
        assert_eq!(resumed.scheduler.retired_blocks.get(), 1);
        assert_eq!(resumed.scheduler.completed_outer_slices.get(), 0);

        let second_token = arm_resident_dispatch(&mut machine, 100, 4);
        let second = core_run::DispatchReport {
            instructions: 4,
            cycles: 13,
            blocks: 1,
            reason: ppcwasmjit::DispatchReason::CycleBudgetExhausted,
        };
        assert_eq!(
            machine
                .run_coordinator
                .finish_slice(second_token, second)
                .unwrap(),
            core_run::FinishSlice::Outcome
        );
        assert!(machine.commit_resident_dispatch_cycles(second.cycles));
        machine.record_machine_evidence_dispatch(second);
        machine.complete_machine_evidence_outer_slice();
        let terminal = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(terminal.scheduler.canonical_cycle.get(), 23);
        assert_eq!(terminal.scheduler.executed_cycles.get(), 23);
        assert_eq!(terminal.scheduler.executed_instructions.get(), 7);
        assert_eq!(terminal.scheduler.retired_blocks.get(), 2);
        assert_eq!(terminal.scheduler.completed_outer_slices.get(), 1);
        assert_eq!(terminal.scheduler.pc, 0x8000_3100);
    }

    #[test]
    fn resident_volatile_idle_requires_two_stable_cpu_transitions_then_jumps_exactly() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let current_block = install_volatile_idle_test_block(&mut machine);
        // Exact CPU stability compares floating-point payload bits, so a retained NaN neither
        // creates a false mismatch nor receives host-language NaN equality semantics.
        machine.system.cpu.user.fpr[0].0[0] = f64::from_bits(0x7ff8_0000_0000_0042);
        machine.refresh_machine_evidence_scheduler(None);
        let block_cycles = u64::from(current_block.maximum_cycles);
        let expected_deadline = machine
            .next_resident_deadline_at(0)
            .expect("the resident test machine publishes a DSP deadline");
        assert_eq!(expected_deadline, 768);

        for iteration in 0..4 {
            let bindings = idle_test_bindings(&machine, current_block);
            let begins_outer_slice = machine.run_coordinator.is_quiescent();
            assert_eq!(
                machine.run_coordinator.begin_slice(bindings, 800, 10),
                Ok(core_run::BeginSlice::Dispatch)
            );
            if begins_outer_slice {
                machine.machine_evidence_outer_active = true;
            }
            assert_eq!(machine.run_coordinator.plan().block_budget(), 1);
            let token = machine.run_coordinator.plan().token();
            let report = core_run::DispatchReport {
                instructions: 3,
                cycles: block_cycles,
                blocks: 1,
                reason: ppcwasmjit::DispatchReason::BlockBudgetExhausted,
            };
            let identity = match machine.run_coordinator.finish_slice(token, report).unwrap() {
                core_run::FinishSlice::IdleProbe(identity) => identity,
                other => panic!("expected exact idle probe, got {other:?}"),
            };
            assert!(machine.commit_resident_dispatch_cycles(report.cycles));
            machine.record_machine_evidence_dispatch(report);

            // Model a changed volatile observation after the first block. Full Cpu equality,
            // including the load destination and CR, must reset rather than advance the witness.
            if iteration == 1 {
                machine.system.cpu.user.gpr[3] = 1;
            }
            let resolved = machine.resolve_resident_idle_probe(identity).unwrap();
            if iteration < 3 {
                assert_eq!(resolved, core_run::FinishSlice::Resume);
                assert_eq!(
                    machine.system.scheduler.canonical_elapsed(),
                    block_cycles * (iteration + 1)
                );
                assert_eq!(
                    machine
                        .resident_idle_witness
                        .as_ref()
                        .map(|witness| witness.stable_transitions),
                    Some(iteration.saturating_sub(1) as u8)
                );
            } else {
                assert_eq!(resolved, core_run::FinishSlice::ServiceEvents);
                assert_eq!(
                    machine.system.scheduler.canonical_elapsed(),
                    expected_deadline
                );
                assert!(machine.resident_idle_witness.is_none());
            }
        }

        let snapshot = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(snapshot.scheduler.canonical_cycle.get(), expected_deadline);
        assert_eq!(snapshot.scheduler.executed_cycles.get(), expected_deadline);
        assert_eq!(snapshot.scheduler.executed_instructions.get(), 12);
        assert_eq!(snapshot.scheduler.retired_blocks.get(), 4);
        assert_eq!(
            snapshot.semantic_idle_cycles.get(),
            expected_deadline - block_cycles * 4
        );
        assert_eq!(snapshot.semantic_idle_jumps, 1);
        assert_eq!(
            machine.run_coordinator.outcome().executed_cycles(),
            0,
            "the in-flight outcome is not published before the event boundary completes"
        );

        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        machine.run_coordinator.events_serviced().unwrap();
        let mut exhausted = idle_test_bindings(&machine, current_block);
        exhausted.next_deadline = None;
        assert_eq!(
            machine.run_coordinator.begin_slice(exhausted, 0, 10),
            Ok(core_run::BeginSlice::Outcome)
        );
        assert_eq!(
            machine.run_coordinator.outcome().executed_cycles(),
            expected_deadline
        );
        assert_eq!(
            machine.run_coordinator.outcome().executed_instructions(),
            12
        );
        machine.complete_machine_evidence_outer_slice();
        let terminal = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(terminal.scheduler.canonical_cycle.get(), expected_deadline);
        assert_eq!(terminal.scheduler.executed_cycles.get(), expected_deadline);
        assert_eq!(terminal.scheduler.executed_instructions.get(), 12);
        assert_eq!(terminal.scheduler.retired_blocks.get(), 4);
        assert_eq!(terminal.scheduler.completed_outer_slices.get(), 1);
        assert_eq!(
            terminal.semantic_idle_cycles.get(),
            expected_deadline - block_cycles * 4
        );
        assert_eq!(terminal.semantic_idle_jumps, 1);
    }

    #[test]
    fn resident_idle_repeek_rejects_post_block_identity_drift_without_skipping() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let current_block = install_volatile_idle_test_block(&mut machine);
        machine.refresh_machine_evidence_scheduler(None);
        let block_cycles = u64::from(current_block.maximum_cycles);
        let bindings = idle_test_bindings(&machine, current_block);
        machine
            .run_coordinator
            .begin_slice(bindings, 800, 10)
            .unwrap();
        let report = core_run::DispatchReport {
            instructions: 3,
            cycles: block_cycles,
            blocks: 1,
            reason: ppcwasmjit::DispatchReason::BlockBudgetExhausted,
        };
        let identity = match machine
            .run_coordinator
            .finish_slice(machine.run_coordinator.plan().token(), report)
            .unwrap()
        {
            core_run::FinishSlice::IdleProbe(identity) => identity,
            other => panic!("expected exact idle probe, got {other:?}"),
        };
        assert!(machine.commit_resident_dispatch_cycles(report.cycles));
        machine.record_machine_evidence_dispatch(report);

        machine.system.cpu.pc += 4;
        assert_eq!(
            machine.resolve_resident_idle_probe(identity),
            Some(core_run::FinishSlice::Resume)
        );
        assert!(machine.resident_idle_witness.is_none());
        assert_eq!(machine.system.scheduler.canonical_elapsed(), block_cycles);
        let snapshot = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(snapshot.scheduler.executed_cycles.get(), block_cycles);
        assert_eq!(snapshot.semantic_idle_cycles.get(), 0);
        assert_eq!(snapshot.semantic_idle_jumps, 0);
    }

    #[test]
    fn semantic_idle_evidence_counter_overflow_poison_is_nonmutating() {
        let mut evidence = MachineEvidenceIntegration::try_new(10, 0x8000_1000, 1).unwrap();
        evidence.scheduler.semantic_idle_jumps = u64::from(u32::MAX);
        let before = evidence.scheduler;

        assert!(!evidence.commit_idle_cycles(11, 0x8000_1000, 1, 1));
        assert!(!evidence.is_healthy());
        assert_eq!(evidence.scheduler, before);
    }

    #[test]
    fn di_evidence_regression_permanently_suppresses_snapshots() {
        let mut evidence = MachineEvidenceIntegration::try_new(10, 0x8000_1000, 1).unwrap();
        let live = ResidentDiLifecycleEvidence {
            command_starts: 1,
            read_starts: 1,
            read_sector_starts: 1,
            current_state: ResidentDiLifecycleState::AwaitingHost,
            current_kind: Some(ResidentCommandKind::ReadSector),
            ..ResidentDiLifecycleEvidence::default()
        };
        evidence.accept_di(Some(live), Some(BrowserDiLifecycleEvidence::default()));
        let accepted = *evidence.issue_snapshot().unwrap();
        assert_eq!(accepted.di.command_starts.get(), 1);
        assert_eq!(accepted.di.read_starts.get(), 1);

        evidence.accept_di(
            Some(ResidentDiLifecycleEvidence::default()),
            Some(BrowserDiLifecycleEvidence::default()),
        );
        assert!(!evidence.is_healthy());
        assert!(evidence.issue_snapshot().is_none());
    }

    #[test]
    fn capture_authority_v2_has_exact_header_and_pristine_zero_si_payload() {
        assert_eq!(core::mem::size_of::<CaptureAuthorityV2>(), 108);
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();

        let authority = *machine.capture_authority_snapshot().unwrap();

        assert_eq!(authority.magic, u32::from_be_bytes(*b"LZCA"));
        assert_eq!(authority.version, 2);
        assert_eq!(authority.bytes, 108);
        assert_eq!(authority.si_poll_index_lo, 0);
        assert_eq!(authority.si_poll_index_hi, 0);
        assert_eq!(authority.si_scheduled_cycle_lo, 0);
        assert_eq!(authority.si_scheduled_cycle_hi, 0);
        assert_eq!(authority.si_observed_cycle_lo, 0);
        assert_eq!(authority.si_observed_cycle_hi, 0);
        assert_eq!(authority.si_applied_sequence_lo, 0);
        assert_eq!(authority.si_applied_sequence_hi, 0);
        assert_eq!(authority.si_packet_word_0, 0);
        assert_eq!(authority.si_packet_word_1, 0);
        assert_eq!(authority.si_source, 0);
        assert_eq!(authority.si_controller_mode, 0);
        assert_eq!(authority.si_buttons, 0);
        assert_eq!(authority.si_stick_xy_cxy, 0);
        assert_eq!(authority.si_trigger_lrab, 0);
        assert_eq!(authority.reserved, 0);
    }

    #[test]
    fn capture_authority_v2_retains_authenticated_mode_semantics_and_packet() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let state = si::ControllerInputState {
            buttons: 0x1108,
            stick_x: 0x12,
            stick_y: 0x34,
            c_stick_x: 0x56,
            c_stick_y: 0x78,
            trigger_l: 0x9a,
            trigger_r: 0xbc,
            analog_a: 0xde,
            analog_b: 0xf0,
        };

        for mode in 0_u8..=7 {
            let poll_index = u64::from(mode) + 1;
            let sequence = 0x1_0000_0000_u64 + poll_index;
            let packet = state.packet(mode);
            machine.machine_evidence.record_si_publication(
                lazuli_abi::MachineSiPollSource::Periodic,
                si::ControllerPublication {
                    source: si::ControllerPollSource::Periodic,
                    poll_index,
                    scheduled_cycle: 0,
                    observed_cycle: 0,
                    sequence,
                    buttons: state.buttons,
                    state,
                    mode,
                    packet,
                },
                0,
                sequence,
            );
            assert!(machine.machine_evidence.is_healthy());

            let authority = *machine.capture_authority_snapshot().unwrap();
            assert_eq!(authority.si_poll_index_lo, poll_index as u32);
            assert_eq!(authority.si_poll_index_hi, 0);
            assert_eq!(authority.si_applied_sequence_lo, sequence as u32);
            assert_eq!(authority.si_applied_sequence_hi, (sequence >> 32) as u32);
            assert_eq!(
                authority.si_packet_word_0,
                u32::from_be_bytes(packet[0..4].try_into().unwrap())
            );
            assert_eq!(
                authority.si_packet_word_1,
                u32::from_be_bytes(packet[4..8].try_into().unwrap())
            );
            assert_eq!(authority.si_source, 0);
            assert_eq!(authority.si_controller_mode, u32::from(mode));
            assert_eq!(authority.si_buttons, u32::from(state.buttons));
            assert_eq!(authority.si_stick_xy_cxy, 0x7856_3412);
            assert_eq!(authority.si_trigger_lrab, 0xf0de_bc9a);
            assert_eq!(authority.reserved, 0);
        }
    }

    #[test]
    fn actual_wasm_two_block_tb_and_dec_hooks_publish_exact_prefix_plus_instruction_cycle() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping WebAssembly runtime timing vector");
            return;
        }

        fn instruction(word: u32) -> Ins {
            Ins::new(word, Extensions::gekko_broadway())
        }
        fn mftb(rd: u8, tbr: u16) -> Ins {
            let encoded = (u32::from(tbr) & 0x1f) << 16 | (u32::from(tbr) >> 5) << 11;
            instruction(31 << 26 | u32::from(rd) << 21 | encoded | 371 << 1)
        }
        fn mtspr(rs: u8, spr: u16) -> Ins {
            let encoded = (u32::from(spr) & 0x1f) << 16 | (u32::from(spr) >> 5) << 11;
            instruction(31 << 26 | u32::from(rs) << 21 | encoded | 467 << 1)
        }
        fn branch(displacement: i32) -> Ins {
            instruction(18 << 26 | (displacement as u32 & 0x03ff_fffc))
        }
        fn hex(bytes: &[u8]) -> String {
            bytes.iter().map(|byte| format!("{byte:02x}")).collect()
        }

        const PC: u32 = 0x8000_1000;
        let block = Jit::with_slow_memory_resident()
            // mftb starts at offset 0, mtspr DEC starts at offset 1, and the final branch returns
            // to this block so the linked runner can prove the next completed-block prefix.
            .build([mftb(3, 268), mtspr(4, SPR::DEC as u16), branch(-8)])
            .unwrap();
        let maximum_cycles = block.metadata().executed.cycles;
        let maximum_instructions = block.metadata().executed.instructions;
        assert_eq!(maximum_cycles, 4);
        assert_eq!(maximum_instructions, 3);
        let region = link_region(&[RegionBlock {
            pc: PC,
            maximum_cycles,
        }])
        .unwrap();
        Validator::new().validate_all(block.wasm()).unwrap();
        Validator::new().validate_all(&region).unwrap();

        let script = r#"
const [blockHex, regionHex, pcOffsetText, r4OffsetText, pcText, maximumCyclesText,
  maximumInstructionsText, initialPagesText, maximumPagesText] = process.argv.slice(1);
const pcOffset = Number(pcOffsetText);
const r4Offset = Number(r4OffsetText);
const pc = Number(pcText) >>> 0;
const maximumCycles = Number(maximumCyclesText);
const maximumInstructions = Number(maximumInstructionsText);
const memory = new WebAssembly.Memory({
  initial: Number(initialPagesText),
  maximum: Number(maximumPagesText),
});
const view = new DataView(memory.buffer);
const control = 0x1000;
const cpu = 0x2000;
const log = [];
let decrementerHooks = 0;
const machine = {
  memory,
  user_0_19(context) {
    if (context !== control) throw new Error(`bad TB context ${context}`);
    log.push([19, view.getUint32(control, true), view.getUint32(control + 8, true)]);
  },
  user_0_22(context) {
    if (context !== control) throw new Error(`bad DEC context ${context}`);
    log.push([22, view.getUint32(control, true), view.getUint32(control + 8, true)]);
    decrementerHooks++;
    // Models Rust detecting the second block's newly earlier DEC deadline. The region must stop
    // before a third block, while retaining both blocks' authenticated accounting.
    if (decrementerHooks === 2) view.setUint32(control + 4, 1, true);
  },
};
const block = new WebAssembly.Instance(
  new WebAssembly.Module(Buffer.from(blockHex, "hex")),
  { lazuli: machine },
);
const region = new WebAssembly.Instance(
  new WebAssembly.Module(Buffer.from(regionHex, "hex")),
  { lazuli: { memory }, lazuli_blocks: { b0: block.exports.run } },
);
view.setUint32(cpu + pcOffset, pc, true);
view.setUint32(cpu + r4Offset, 7, true);
view.setUint32(control, 0, true);
view.setUint32(control + 4, 0, true);
view.setUint32(control + 8, 0xfeedbeef, true);
const result = region.exports.run(
  control,
  cpu,
  0,
  pcOffset,
  control,
  maximumCycles * 3,
  10,
);
const expectedResult = [maximumInstructions * 2, maximumCycles * 2, 2];
if (result.length !== expectedResult.length ||
    result.some((value, index) => value !== expectedResult[index])) {
  throw new Error(`bad two-block accounting: ${result} vs ${expectedResult}`);
}
const expectedLog = [
  [19, 0, 0],
  [22, 0, 1],
  [19, maximumCycles, 0],
  [22, maximumCycles, 1],
];
if (JSON.stringify(log) !== JSON.stringify(expectedLog)) {
  throw new Error(`bad observed hook cycles: ${JSON.stringify(log)}`);
}
if (view.getUint32(cpu + pcOffset, true) !== pc || view.getUint32(control + 4, true) !== 1) {
  throw new Error("hook exit did not stop exactly before block three");
}
"#;
        let output = Command::new("node")
            .args([
                "--input-type=module",
                "--eval",
                script,
                &hex(block.wasm()),
                &hex(&region),
                &Reg::PC.offset().to_string(),
                &GPR::R4.offset().to_string(),
                &PC.to_string(),
                &maximum_cycles.to_string(),
                &maximum_instructions.to_string(),
                &RESIDENT_MEMORY_INITIAL_PAGES.to_string(),
                &RESIDENT_MEMORY_MAXIMUM_PAGES.to_string(),
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "node failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    #[test]
    fn resident_observation_closes_on_yield_fault_and_pc_change() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        arm_resident_dispatch(&mut machine, 100, 4);

        machine.resident_context.control.instruction_cycle_offset = 5;
        let yielded = machine
            .observe_resident_hook(|_| HookResult::YIELD)
            .unwrap();
        assert_eq!(machine.apply_hook_result(yielded), HookOutcome::Yield);
        assert!(!machine.system.scheduler.is_observing());

        machine.resident_context.control.instruction_cycle_offset = 6;
        let fault = HookResult {
            outcome: HookOutcome::Fault,
            ..HookResult::COMPLETE
        };
        let fault = machine.observe_resident_hook(|_| fault).unwrap();
        assert_eq!(machine.apply_hook_result(fault), HookOutcome::Fault);
        assert!(!machine.system.scheduler.is_observing());

        machine.resident_context.control.exit_requested = 0;
        machine.resident_context.control.instruction_cycle_offset = 7;
        let old_pc = machine.system.cpu.pc;
        assert_eq!(
            machine.observe_resident_hook(|machine| {
                machine.system.cpu.pc += 4;
                HookResult::COMPLETE
            }),
            Some(HookResult::COMPLETE)
        );
        assert_eq!(machine.system.cpu.pc, old_pc + 4);
        assert!(machine.resident_context.control.should_exit());
        assert!(!machine.system.scheduler.is_observing());
    }

    #[test]
    fn resident_observation_rejects_out_of_plan_cycles_before_machine_mutation() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        arm_resident_dispatch(&mut machine, 10, 1);
        machine.resident_context.control.instruction_cycle_offset = 11;

        assert_eq!(
            machine.observe_resident_hook(|machine| {
                machine.system.cpu.user.gpr[0] = 0xdead_beef;
            }),
            None
        );
        assert_eq!(machine.system.cpu.user.gpr[0], 0);
        assert!(!machine.system.scheduler.is_observing());
        let outcome = machine.machine_exit.as_ref().unwrap();
        assert_eq!(outcome.reason(), Ok(RunReason::Fault));
        assert_eq!(
            outcome.detail,
            ResidentMachineExitDetail::HookObservationRejected as u32
        );
    }

    #[test]
    fn dispatcher_report_before_observed_hook_time_fails_without_advancing_canonical_time() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let token = arm_resident_dispatch(&mut machine, 100, 1);
        machine.resident_context.control.instruction_cycle_offset = 25;
        assert_eq!(machine.observe_resident_hook(|_| ()), Some(()));

        assert_eq!(
            machine
                .run_coordinator
                .finish_slice(
                    token,
                    core_run::DispatchReport {
                        instructions: 1,
                        cycles: 24,
                        blocks: 1,
                        reason: ppcwasmjit::DispatchReason::HookExit,
                    },
                )
                .unwrap(),
            core_run::FinishSlice::Resume
        );
        assert!(!machine.commit_resident_dispatch_cycles(24));
        assert_eq!(machine.system.scheduler.canonical_elapsed(), 0);
        let outcome = machine.machine_exit.as_ref().unwrap();
        assert_eq!(outcome.reason(), Ok(RunReason::Fault));
        assert_eq!(
            outcome.detail,
            ResidentMachineExitDetail::SchedulerAdvanceRejected as u32
        );
    }

    #[test]
    fn observed_hook_detects_new_fixed_machine_deadline() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        arm_resident_dispatch(&mut machine, 100, 2);
        machine.resident_context.control.instruction_cycle_offset = 9;

        assert_eq!(
            machine.observe_resident_hook(|machine| {
                let now = machine.system.scheduler.elapsed();
                machine
                    .event_deadlines
                    .schedule(MachineEventKind::PeFinish, now);
            }),
            Some(())
        );
        assert!(machine.resident_context.control.should_exit());
        assert!(!machine.system.scheduler.is_observing());
    }

    #[test]
    fn observed_decrementer_schedule_overflow_fails_closed_without_panicking() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.system.scheduler.advance(u64::MAX - 2);
        arm_resident_dispatch(&mut machine, 2, 1);
        machine.resident_context.control.instruction_cycle_offset = 1;
        machine.system.cpu.supervisor.misc.dec = 10;

        let result = machine
            .observe_resident_hook(|machine| {
                if machine.system.decrementer_changed().is_err() {
                    machine.publish_machine_exit(ResidentMachineExitDetail::HookScheduleRejected);
                    HookResult {
                        outcome: HookOutcome::Fault,
                        ..HookResult::COMPLETE
                    }
                } else {
                    HookResult::COMPLETE
                }
            })
            .unwrap();
        assert_eq!(result.outcome, HookOutcome::Fault);
        assert!(!machine.system.scheduler.is_observing());
        assert_eq!(machine.system.scheduler.canonical_elapsed(), u64::MAX - 2);
        let outcome = machine.machine_exit.as_ref().unwrap();
        assert_eq!(
            outcome.detail,
            ResidentMachineExitDetail::HookScheduleRejected as u32
        );
    }

    #[test]
    fn resident_dsp_deadline_services_exact_overshoot_and_legacy_due_callbacks() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        assert_eq!(
            machine
                .event_deadlines()
                .deadline(MachineEventKind::DspExecution),
            Some(lazuli::system::dspi::DSP_EXECUTION_QUANTUM_CPU_CYCLES)
        );
        machine.system.scheduler.schedule(1_000, mark_legacy_event);
        machine.system.scheduler.advance(1_000);

        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        assert_eq!(machine.system.cpu.user.gpr[0], 0xfeed_beef);
        assert_eq!(machine.system.dsp.lle.execution_slices(), 1);
        assert_eq!(machine.system.dsp.lle.budgeted_instructions(), 83);
        assert_eq!(machine.system.dsp.lle.pending_cpu_cycles(), 4);
        assert_eq!(
            machine.system.dsp.lle.last_stop_reason(),
            lazuli::system::dspi::DspLleStopReason::CpuMailboxEmpty
        );
        assert_eq!(
            machine
                .event_deadlines()
                .deadline(MachineEventKind::DspExecution),
            Some(1_764)
        );
        assert_eq!(machine.system.scheduler.elapsed(), 1_000);
    }

    #[test]
    fn resident_service_drains_aram_and_lle_in_one_rust_dsp_phase() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine
            .event_deadlines_mut()
            .schedule(MachineEventKind::AramDmaCompletion, 768);
        machine.system.scheduler.advance(768);
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        assert_eq!(machine.system.dsp.lle.execution_slices(), 1);
        assert_eq!(
            machine
                .event_deadlines()
                .deadline(MachineEventKind::DspExecution),
            Some(1_536)
        );
        assert_eq!(
            machine
                .event_deadlines()
                .deadline(MachineEventKind::AramDmaCompletion),
            None
        );
    }

    #[test]
    fn resident_aid_mmio_publishes_and_services_the_rust_dsp_phase() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let legacy_callbacks = machine.system.scheduler.len();

        // The resident AID control register occupies the low half of this accepted word write.
        // Starting three blocks publishes the exact +200 initial interrupt without a callback.
        resident_mmio_write(&mut machine, 0x0c00_5034, 0x0000_8003, 100);
        assert_eq!(machine.system.scheduler.len(), legacy_callbacks);
        assert_eq!(
            machine
                .event_deadlines()
                .deadline(MachineEventKind::DspAudioDmaInterrupt),
            Some(300)
        );
        assert!(
            machine
                .event_deadlines()
                .deadline(MachineEventKind::DspAudioDmaBlock)
                .is_some()
        );

        machine.system.scheduler.advance(300);
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::Complete
        );
        assert!(machine.system.dsp.control.ai_dma_interrupt());
        assert_eq!(machine.system.dsp.lle.execution_slices(), 0);
        assert_eq!(
            machine
                .event_deadlines()
                .deadline(MachineEventKind::DspAudioDmaInterrupt),
            None
        );
        assert!(
            machine
                .event_deadlines()
                .deadline(MachineEventKind::DspAudioDmaBlock)
                .is_some()
        );
        assert_eq!(machine.system.scheduler.len(), legacy_callbacks);
    }

    #[test]
    fn fatal_dsp_stop_publishes_a_sticky_rust_machine_exit() {
        let mut system = test_system();
        write_dsp_ucode(
            &mut system,
            &[
                0x16c9, 0x0001, // DSP-to-RAM DMEM DMA
                0x16cd, 0x0003, // DMEM word 3
                0x16ce, 0x017f, // last MEM1 byte, high
                0x16cf, 0xffff, // last MEM1 byte, low
                0x16cb, 0x0004, // start an out-of-range four-byte DMA
                0x0021,
            ],
        );
        let mut machine = BrowserMachine::from_system(system).unwrap();
        machine.system.scheduler.advance(768);
        assert_eq!(
            machine.service_due_resident_events(),
            ResidentEventService::MachineExit
        );
        let outcome = machine.machine_exit.as_ref().unwrap();
        assert_eq!(outcome.reason(), Ok(RunReason::Fault));
        assert_eq!(
            outcome.detail,
            ResidentMachineExitDetail::DspFatalStop as u32
        );
        assert_eq!(outcome.executed_cycles(), 0);
        assert_eq!(outcome.executed_instructions(), 0);
        assert!(machine.resident_context.control.should_exit());
        assert!(matches!(
            machine.system.dsp.lle.last_stop_reason(),
            lazuli::system::dspi::DspLleStopReason::BusFault(_)
        ));
        assert_eq!(machine.system.dsp.lle.budgeted_instructions(), 64);
        let snapshot = *machine.machine_evidence_snapshot().unwrap();
        assert_eq!(
            snapshot.flags & lazuli_abi::MACHINE_EVIDENCE_DSP_LLE_VALID,
            0
        );
        assert_ne!(
            snapshot.flags & lazuli_abi::MACHINE_EVIDENCE_TERMINAL_ERROR,
            0
        );
        assert_eq!(
            snapshot.scheduler.machine_fault_reason_raw,
            RunReason::Fault as u32
        );
        assert_eq!(
            snapshot.scheduler.machine_fault_detail,
            ResidentMachineExitDetail::DspFatalStop as u32
        );
    }

    #[test]
    fn resident_isync_preserves_the_exact_installed_block() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let installed = install_volatile_idle_test_block(&mut machine);
        let generation = AddressSpaceGeneration(installed.generation);
        let pc = Address(installed.pc);
        let retained = machine
            .cold_compile()
            .peek(generation, pc)
            .expect("the resident block must be installed before isync");
        assert_eq!(machine.cold_compile().cache_len(), 1);

        assert_eq!(
            machine.apply_hook_result(synchronize_resident_instruction_stream()),
            HookOutcome::Complete
        );

        assert_eq!(machine.cold_compile().cache_len(), 1);
        assert_eq!(machine.cold_compile().peek(generation, pc), Some(retained));
        assert!(!machine.resident_context.control.should_exit());
    }

    #[test]
    fn invalidation_exact_cancels_all_pending_compile_owners() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.system.cpu.pc = Address(0x1000);
        machine
            .system
            .write_phys_slow(Address(0x1000), 0x4800_0000_u32);
        let prepared = machine
            .prepare_current_pc_compile_at(lazuli_abi::SharedPtr(0x0020_0000))
            .unwrap();
        let identity = prepared.request.install_identity();
        arm_compile_install(&mut machine, identity);

        assert_eq!(
            machine.apply_hook_result(MachineRuntimeHooks::clear_instruction_cache()),
            HookOutcome::Invalidated
        );
        assert!(!machine.cold_compile.has_pending_compile());
        assert!(machine.pending_installable.is_none());
        assert!(!machine.run_coordinator.is_awaiting_install());
        assert_eq!(
            machine.run_coordinator.outcome().reason(),
            Ok(RunReason::Fault)
        );
        assert_eq!(
            machine.run_coordinator.outcome().detail,
            core_run::RunOutcomeDetail::CompileCancelled as u32
        );
    }

    #[test]
    fn post_commit_failure_terminally_cancels_the_remaining_run_owner() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.system.cpu.pc = Address(0x1000);
        machine
            .system
            .write_phys_slow(Address(0x1000), 0x4800_0000_u32);
        let prepared = machine
            .prepare_current_pc_compile_at(lazuli_abi::SharedPtr(0x0020_0000))
            .unwrap();
        let identity = prepared.request.install_identity();
        arm_compile_install(&mut machine, identity);
        machine
            .cold_compile
            .begin_self_install(identity, AddressSpaceGeneration(1))
            .unwrap();
        machine
            .cold_compile
            .commit_self_install(identity, AddressSpaceGeneration(1))
            .unwrap();

        assert!(machine.cancel_run_install_if_awaiting(identity));
        assert!(!machine.run_coordinator.is_awaiting_install());
        assert_eq!(
            machine.run_coordinator.outcome().reason(),
            Ok(RunReason::Fault)
        );
        assert!(machine.run_coordinator.outcome().request_ptr.is_null());
    }

    #[test]
    fn dependency_validator_rejects_real_and_bat_mappings() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        let real = machine
            .system_mut()
            .translate_instruction_mmu(Address(0x0000_1000), TranslationEffect::Probe)
            .unwrap();
        assert!(matches!(real.source, TranslationSource::Real));
        assert!(!machine.validate_instruction_page_dependency(0x0000_1000, 0x0000_1000));

        machine
            .system_mut()
            .cpu
            .supervisor
            .memory
            .setup_default_bats();
        machine
            .system_mut()
            .cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(true);
        let mapping = machine
            .system_mut()
            .translate_instruction_mmu(Address(0x8000_1000), TranslationEffect::Probe)
            .unwrap();
        assert!(matches!(mapping.source, TranslationSource::Bat { .. }));
        assert!(!machine.validate_instruction_page_dependency(0x8000_1000, 0x0000_1000));
        assert!(!machine.validate_instruction_page_dependency(0x8000_1001, 0x0000_1000));
        assert!(!machine.validate_instruction_page_dependency(0x8000_1000, 0x0000_1001));
    }

    #[test]
    fn exact_hashed_dependency_sets_referenced_and_rejects_mapping_drift() {
        let mut system = test_system();
        let effective_page = 0x8000_1000;
        let old_physical_page = 0x0000_5000;
        let new_physical_page = 0x0000_9000;
        let pte1_address = enable_hashed_mapping(&mut system, effective_page, old_physical_page);
        let mut machine = BrowserMachine::from_system(system).unwrap();

        assert_eq!(
            machine.current_generation(),
            Some(AddressSpaceGeneration(1))
        );
        assert_eq!(machine.cold_compile().cache_capacity(), 4096);
        assert_eq!(
            machine.cold_compile().cache_capacity(),
            DISPATCH_ENTRY_CAPACITY
        );
        assert_eq!(
            machine
                .event_deadlines()
                .deadline(MachineEventKind::DspExecution),
            Some(lazuli::system::dspi::DSP_EXECUTION_QUANTUM_CPU_CYCLES)
        );

        assert_eq!(
            machine
                .system_mut()
                .read_phys_slow::<u32>(Address(pte1_address))
                & 0x100,
            0
        );
        assert!(machine.validate_instruction_page_dependency(effective_page, old_physical_page));
        assert_ne!(
            machine
                .system_mut()
                .read_phys_slow::<u32>(Address(pte1_address))
                & 0x100,
            0
        );

        // An architected PTE update becomes observable after the guest invalidates this TLB set.
        machine
            .system_mut()
            .write_phys_slow(Address(pte1_address), new_physical_page | 2_u32);
        machine
            .system_mut()
            .invalidate_translation(Address(effective_page));
        assert!(!machine.validate_instruction_page_dependency(effective_page, old_physical_page));
        assert!(machine.validate_instruction_page_dependency(effective_page, new_physical_page));
    }

    #[test]
    fn current_pc_compile_retains_exact_module_and_cancels_failed_publication() {
        let mut machine = BrowserMachine::from_system(test_system()).unwrap();
        machine.system_mut().cpu.pc = Address(0x1000);
        machine
            .system_mut()
            .write_phys_slow(Address(0x1000), 0x4800_0000_u32);

        let prepared = machine
            .prepare_current_pc_compile_at(lazuli_abi::SharedPtr(0x0020_0000))
            .unwrap();
        assert!(prepared.retirements.blocks.is_empty());
        assert!(prepared.retirements.reclaimed_slot.is_none());
        assert!(prepared.retirements.cancelled_preparation.is_none());
        assert_eq!(prepared.request.address_space_generation(), 1);
        let retained = machine.pending_installable().unwrap();
        assert_eq!(retained.identity(), prepared.request.install_identity());
        assert_eq!(
            retained.module().bytes().len(),
            prepared.request.module.len as usize
        );
        assert_eq!(retained.module().sha256(), prepared.request.module_sha256);

        let pending = machine
            .prepare_current_pc_compile_at(lazuli_abi::SharedPtr(0x0021_0000))
            .unwrap_err();
        assert!(matches!(
            pending.error,
            PrepareCurrentPcError::PendingRequest
        ));

        let mut failed = BrowserMachine::from_system(test_system()).unwrap();
        failed.system_mut().cpu.pc = Address(0x1000);
        failed
            .system_mut()
            .write_phys_slow(Address(0x1000), 0x4800_0000_u32);
        let failure = failed
            .prepare_current_pc_compile_at(lazuli_abi::SharedPtr::NULL)
            .unwrap_err();
        assert!(matches!(
            failure.error,
            PrepareCurrentPcError::SharedModuleUnavailable
        ));
        assert!(failure.retirements.cancelled_preparation.is_some());
        assert!(!failed.cold_compile().has_pending_compile());
        assert!(failed.pending_installable().is_none());
    }

    #[test]
    fn address_space_switch_retains_both_exact_namespaces_and_reuses_the_first() {
        let mut system = test_system();
        system.cpu.supervisor.memory.setup_default_bats();
        let mut machine = BrowserMachine::from_system(system).unwrap();
        machine.system_mut().cpu.pc = Address(0x1000);
        machine
            .system_mut()
            .write_phys_slow(Address(0x1000), 0x4800_0000_u32);
        let first = machine
            .prepare_current_pc_compile_at(lazuli_abi::SharedPtr(0x0020_0000))
            .unwrap();
        let identity = first.request.install_identity();
        machine
            .cold_compile
            .begin_self_install(identity, AddressSpaceGeneration(1))
            .unwrap();
        let installed = machine
            .cold_compile
            .commit_self_install(identity, AddressSpaceGeneration(1))
            .unwrap();
        assert_eq!(installed.block.pc, Address(0x1000));
        assert!(machine.discard_pending_installable(identity));

        machine
            .system_mut()
            .cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(true);
        machine.system_mut().cpu.pc = Address(0x8000_1000);
        let second = machine
            .prepare_current_pc_compile_at(lazuli_abi::SharedPtr(0x0021_0000))
            .unwrap();
        assert_eq!(second.request.address_space_generation(), 2);
        assert!(second.retirements.blocks.is_empty());
        let second_identity = second.request.install_identity();
        machine
            .cold_compile
            .begin_self_install(second_identity, AddressSpaceGeneration(2))
            .unwrap();
        let second_installed = machine
            .cold_compile
            .commit_self_install(second_identity, AddressSpaceGeneration(2))
            .unwrap();
        assert_eq!(second_installed.block.pc, Address(0x8000_1000));
        assert!(machine.discard_pending_installable(second_identity));

        machine
            .system_mut()
            .cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(false);
        machine.system_mut().cpu.pc = Address(0x1000);
        let synchronized = machine
            .runtime_hooks
            .synchronize_address_space(&machine.system);
        assert_eq!(
            machine.apply_hook_result(synchronized),
            HookOutcome::Invalidated
        );
        assert_eq!(machine.runtime_hooks.current_generation().0, 1);
        assert_eq!(
            machine
                .cold_compile
                .peek(AddressSpaceGeneration(1), Address(0x1000)),
            Some(installed.block)
        );
    }

    #[test]
    fn exclusive_slot_enforces_init_access_order_and_reentrancy() {
        let slot = ExclusiveSlot::<u32>::empty();
        let events = RefCell::new(Vec::new());
        let recursive_init_rejected = Cell::new(false);

        assert_eq!(slot.with(|_| 1), None);
        assert_eq!(
            slot.try_init(|| {
                events.borrow_mut().push("initializing");
                assert_eq!(slot.with(|_| 1), None);
                recursive_init_rejected.set(matches!(
                    slot.try_init(|| Ok::<u32, ()>(99)),
                    InitAttempt::Reentrant
                ));
                Ok::<u32, ()>(7)
            }),
            InitAttempt::Initialized
        );
        events.borrow_mut().push("initialized");
        assert!(recursive_init_rejected.get());
        assert_eq!(
            slot.try_init(|| Ok::<u32, ()>(11)),
            InitAttempt::AlreadyInitialized
        );

        assert_eq!(
            slot.with(|value| {
                events.borrow_mut().push("entered");
                assert_eq!(slot.with(|_| 99), None);
                *value += 1;
                *value
            }),
            Some(8)
        );
        assert_eq!(slot.with(|value| *value), Some(8));
        assert_eq!(
            events.into_inner(),
            vec!["initializing", "initialized", "entered"]
        );
    }

    #[test]
    fn failed_initialization_restores_empty_state() {
        let slot = ExclusiveSlot::<u32>::empty();
        assert_eq!(
            slot.try_init(|| Err("bad layout")),
            InitAttempt::Failed("bad layout")
        );
        assert_eq!(slot.with(|_| 1), None);
        assert_eq!(
            slot.try_init(|| Ok::<u32, &str>(23)),
            InitAttempt::Initialized
        );
        assert_eq!(slot.with(|value| *value), Some(23));
    }
}
