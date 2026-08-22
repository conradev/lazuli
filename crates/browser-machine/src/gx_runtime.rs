//! Rust-resident GX FIFO, materialization, and packet orchestration.
//!
//! This layer deliberately stops before the asynchronous renderer boundary. It owns the
//! incremental FIFO decoder, vertex and texture materializers, cross-batch packet accumulator,
//! version negotiation, and canonical LZGX bytes. JavaScript is not consulted for GX semantics.
//!
//! A terminal packet leaves through a one-use [`GxTerminalHandoff`]. Its heap capacity remains
//! charged to this runtime until the caller confirms that the exact handoff was moved into the
//! separately bounded render runtime. No further guest work is accepted while a handoff is live.

use core::fmt;
use core::fmt::Write as _;
use std::collections::VecDeque;
use std::string::String;
use std::vec::Vec;

use lazuli::system::gx::resident_fifo::{
    BarrierClass, CopyStateSnapshot, DecodeBatch, DecodeError, DecodeStatus, DecoderLimits,
    EfbPeekRequest, EfbPeekResult, GxMemory, SemanticRecord, TerminalKind as ResidentTerminalKind,
    TerminalSnapshot, TextureCopyLayout,
};
use lazuli::system::gx::resident_texture::{
    MaterializedTexture, ResidentTextureMaterializer, StrictV7Classification, StrictV7Preflight,
    TextureCopyReference, TextureError, TextureLimits, materialized_texture_hash,
};
use lazuli::system::gx::resident_vertex::{
    MaterializationRecord, MaterializeError, MaterializedDraw, MaterializedEvidence,
    MaterializerLimits, ResidentVertexMaterializer,
};
use lzgx_packet::{
    CopyState, DrawEvidence, DrawInput, ExactClipInput, FragmentState,
    INDIRECT_TEV_STATE_ENCODING_BP_WORDS_XF_V2, IndirectTevState, MAX_TEXTURES, PacketError,
    PacketInput, PacketVersion, SAMPLER_MODE0_MASK_V4, TEV_STATE_BYTES, TerminalKind,
    TerminalState, TextureBinding, TextureInput, encode,
};

pub const DEFAULT_MAXIMUM_PENDING_GX_BYTES: usize = 48 * 1024 * 1024;
pub const DEFAULT_MAXIMUM_GX_PACKET_BYTES: usize = 32 * 1024 * 1024;

/// Bounds that cover all guest-amplified state retained between FIFO batches and renderer
/// handoffs. The nested limits continue to protect their own short-lived workspaces.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GxRuntimeLimits {
    pub decoder: DecoderLimits,
    pub vertex: MaterializerLimits,
    pub texture: TextureLimits,
    pub maximum_pending_draws: usize,
    pub maximum_pending_textures: usize,
    pub maximum_pending_events: usize,
    pub maximum_pending_bytes: usize,
    pub maximum_packet_bytes: usize,
}

impl Default for GxRuntimeLimits {
    fn default() -> Self {
        Self {
            decoder: DecoderLimits::default(),
            vertex: MaterializerLimits::default(),
            texture: TextureLimits::default(),
            maximum_pending_draws: 65_536,
            maximum_pending_textures: 65_536,
            maximum_pending_events: 65_536,
            maximum_pending_bytes: DEFAULT_MAXIMUM_PENDING_GX_BYTES,
            maximum_packet_bytes: DEFAULT_MAXIMUM_GX_PACKET_BYTES,
        }
    }
}

impl GxRuntimeLimits {
    fn validate(self) -> Result<Self, GxRuntimeError> {
        for (name, value) in [
            ("maximum_pending_draws", self.maximum_pending_draws),
            ("maximum_pending_textures", self.maximum_pending_textures),
            ("maximum_pending_events", self.maximum_pending_events),
            ("maximum_pending_bytes", self.maximum_pending_bytes),
            ("maximum_packet_bytes", self.maximum_packet_bytes),
        ] {
            if value == 0 {
                return Err(GxRuntimeError::InvalidLimit(name));
            }
        }
        if self.maximum_packet_bytes > self.maximum_pending_bytes {
            return Err(GxRuntimeError::InvalidLimit("maximum_packet_bytes"));
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GxAllocationSite {
    PendingDraws,
    PendingTextures,
    Events,
    OutstandingHandoffs,
    PreparedDraws,
    DrawInputs,
    TextureInputs,
    V7Keys,
}

#[derive(Debug, PartialEq, Eq)]
pub enum GxRuntimeError {
    InvalidLimit(&'static str),
    Decode(DecodeError),
    Vertex(MaterializeError),
    Texture(TextureError),
    Packet(PacketError),
    Allocation(GxAllocationSite),
    PendingDrawLimit { requested: usize, maximum: usize },
    PendingTextureLimit { requested: usize, maximum: usize },
    PendingEventLimit { requested: usize, maximum: usize },
    PendingByteLimit { requested: usize, maximum: usize },
    PacketByteLimit { requested: usize, maximum: usize },
    OutstandingHandoffs,
    NoOutstandingHandoff,
    HandoffMismatch,
    HandoffCounterOverflow,
    BarrierKindMismatch,
    TextureCopyReceiptMismatch(&'static str),
    InternalInvariant(&'static str),
    Poisoned,
}

impl fmt::Display for GxRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLimit(name) => {
                write!(formatter, "invalid resident GX runtime limit {name}")
            }
            Self::Decode(error) => write!(formatter, "resident GX decode failed: {error}"),
            Self::Vertex(error) => write!(
                formatter,
                "resident GX vertex materialization failed: {error}"
            ),
            Self::Texture(error) => write!(
                formatter,
                "resident GX texture materialization failed: {error}"
            ),
            Self::Packet(error) => write!(formatter, "resident GX packet encoding failed: {error}"),
            Self::Allocation(site) => {
                write!(formatter, "resident GX allocation failed at {site:?}")
            }
            Self::PendingDrawLimit { requested, maximum } => write!(
                formatter,
                "resident GX pending draws exceed bound: {requested} > {maximum}"
            ),
            Self::PendingTextureLimit { requested, maximum } => write!(
                formatter,
                "resident GX pending textures exceed bound: {requested} > {maximum}"
            ),
            Self::PendingEventLimit { requested, maximum } => write!(
                formatter,
                "resident GX pending events exceed bound: {requested} > {maximum}"
            ),
            Self::PendingByteLimit { requested, maximum } => write!(
                formatter,
                "resident GX aggregate pending bytes exceed bound: {requested} > {maximum}"
            ),
            Self::PacketByteLimit { requested, maximum } => write!(
                formatter,
                "resident GX packet bytes exceed bound: {requested} > {maximum}"
            ),
            Self::OutstandingHandoffs => {
                formatter.write_str("resident GX terminal handoff is still outstanding")
            }
            Self::NoOutstandingHandoff => {
                formatter.write_str("resident GX has no outstanding terminal handoff")
            }
            Self::HandoffMismatch => formatter.write_str("resident GX terminal handoff mismatch"),
            Self::HandoffCounterOverflow => {
                formatter.write_str("resident GX terminal handoff counter overflow")
            }
            Self::BarrierKindMismatch => formatter.write_str("resident GX barrier kind mismatch"),
            Self::TextureCopyReceiptMismatch(field) => {
                write!(
                    formatter,
                    "resident GX texture-copy receipt mismatches {field}"
                )
            }
            Self::InternalInvariant(reason) => {
                write!(formatter, "resident GX runtime invariant failed: {reason}")
            }
            Self::Poisoned => formatter.write_str("resident GX runtime is poisoned"),
        }
    }
}

impl std::error::Error for GxRuntimeError {}

impl From<DecodeError> for GxRuntimeError {
    fn from(value: DecodeError) -> Self {
        Self::Decode(value)
    }
}

impl From<MaterializeError> for GxRuntimeError {
    fn from(value: MaterializeError) -> Self {
        Self::Vertex(value)
    }
}

impl From<TextureError> for GxRuntimeError {
    fn from(value: TextureError) -> Self {
        Self::Texture(value)
    }
}

impl From<PacketError> for GxRuntimeError {
    fn from(value: PacketError) -> Self {
        Self::Packet(value)
    }
}

/// One exact already-mask-resolved BP record. The caller must replay these records into the
/// resident PE in event order. Every BP load is exposed because any non-FE load consumes the
/// one-shot BP mask, even when that load is otherwise irrelevant to PE.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PeBpEffect {
    pub observed_cycle: u64,
    pub register: u8,
    pub value: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GxTerminalSupplement {
    TextureCopy { layout: Option<TextureCopyLayout> },
    XfbCopy,
    EfbPeek,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GxTerminalMetadata {
    pub terminal: TerminalSnapshot,
    pub version: PacketVersion,
    pub supplement: GxTerminalSupplement,
}

/// Private one-use identity returned only by [`GxTerminalHandoff::into_parts`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GxHandoffIdentity {
    id: u64,
    terminal_sequence: u64,
    packet_capacity: usize,
}

/// Owned packet output. This type is intentionally not `Clone`; moving its packet into the
/// renderer and then accepting its identity is the only supported lifecycle.
#[derive(Debug, PartialEq, Eq)]
pub struct GxTerminalHandoff {
    identity: GxHandoffIdentity,
    packet: Vec<u8>,
    metadata: GxTerminalMetadata,
}

impl GxTerminalHandoff {
    pub fn packet(&self) -> &[u8] {
        &self.packet
    }

    pub const fn metadata(&self) -> GxTerminalMetadata {
        self.metadata
    }

    /// Exact heap capacity that stays charged until this handoff is accepted.
    pub const fn pending_charge(&self) -> usize {
        self.identity.packet_capacity
    }

    pub fn into_parts(self) -> (GxHandoffIdentity, Vec<u8>, GxTerminalMetadata) {
        (self.identity, self.packet, self.metadata)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum GxRuntimeEvent {
    PeBpLoad(PeBpEffect),
    Terminal(GxTerminalHandoff),
}

/// One-use charge for the owned event-vector allocation. The caller accepts this only after every
/// event has been applied or moved into another independently bounded owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GxProgressIdentity {
    id: u64,
    event_capacity: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct GxRuntimeProgress {
    pub status: DecodeStatus,
    events: Vec<GxRuntimeEvent>,
    identity: Option<GxProgressIdentity>,
}

impl GxRuntimeProgress {
    pub fn events(&self) -> &[GxRuntimeEvent] {
        &self.events
    }

    pub const fn pending_charge(&self) -> usize {
        match self.identity {
            Some(identity) => identity.event_capacity,
            None => 0,
        }
    }

    pub fn into_parts(
        self,
    ) -> (
        Option<GxProgressIdentity>,
        DecodeStatus,
        Vec<GxRuntimeEvent>,
    ) {
        (self.identity, self.status, self.events)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum GxEfbPeekProgress {
    ImmediateZero { combined_plane: bool },
    YieldForEarlierTerminal,
    Terminal(GxTerminalHandoff),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GxRuntimeStats {
    pub batches: u64,
    pub draws_accumulated: u64,
    pub draws_discarded: u64,
    pub textures_accumulated: u64,
    pub texture_deduplications: u64,
    pub terminals: u64,
    pub packets_v4: u64,
    pub packets_v5: u64,
    pub packets_v6: u64,
    pub packets_v7: u64,
    pub packet_bytes: u64,
    pub handoffs_accepted: u64,
    pub maximum_pending_bytes: usize,
}

/// Authenticated EFB value and its exact aperture interpretation. A caller-provided sink receives
/// this record before the decoder receipt barrier is released.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EfbPeekCommit {
    pub sequence: u64,
    pub value: u32,
    pub combined_plane: bool,
    pub alpha_read_mode: u8,
}

#[derive(Debug)]
struct PendingDraw {
    draw: MaterializedDraw,
    texture_indices: [Option<u32>; MAX_TEXTURES],
}

#[derive(Debug, Default)]
struct PacketAccumulator {
    draws: Vec<PendingDraw>,
    textures: Vec<MaterializedTexture>,
    payload_bytes: usize,
}

impl PacketAccumulator {
    fn retained_bytes(&self) -> Result<usize, GxRuntimeError> {
        self.draws
            .capacity()
            .checked_mul(core::mem::size_of::<PendingDraw>())
            .and_then(|bytes| {
                self.textures
                    .capacity()
                    .checked_mul(core::mem::size_of::<MaterializedTexture>())
                    .and_then(|texture_bytes| bytes.checked_add(texture_bytes))
            })
            .and_then(|bytes| bytes.checked_add(self.payload_bytes))
            .ok_or(GxRuntimeError::PendingByteLimit {
                requested: usize::MAX,
                maximum: usize::MAX,
            })
    }

    fn clear_and_release(&mut self) {
        *self = Self::default();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct OutstandingHandoff {
    identity: GxHandoffIdentity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct OutstandingProgress {
    identity: GxProgressIdentity,
}

/// Complete synchronous GX machine state up to, but not including, renderer submission.
#[derive(Debug)]
pub struct ResidentGxRuntime {
    limits: GxRuntimeLimits,
    decoder: lazuli::system::gx::resident_fifo::ResidentGxDecoder,
    vertex: ResidentVertexMaterializer,
    texture: ResidentTextureMaterializer,
    pending: PacketAccumulator,
    outstanding: VecDeque<OutstandingHandoff>,
    outstanding_bytes: usize,
    outstanding_progress: VecDeque<OutstandingProgress>,
    outstanding_progress_bytes: usize,
    blocking_terminal: Option<TerminalSnapshot>,
    next_handoff_id: u64,
    next_progress_id: u64,
    poisoned: bool,
    stats: GxRuntimeStats,
}

impl ResidentGxRuntime {
    pub fn try_new(limits: GxRuntimeLimits) -> Result<Self, GxRuntimeError> {
        let limits = limits.validate()?;
        Ok(Self {
            decoder: lazuli::system::gx::resident_fifo::ResidentGxDecoder::try_new(limits.decoder)?,
            vertex: ResidentVertexMaterializer::try_new(limits.vertex)?,
            texture: ResidentTextureMaterializer::try_new(limits.texture)?,
            limits,
            pending: PacketAccumulator::default(),
            outstanding: VecDeque::new(),
            outstanding_bytes: 0,
            outstanding_progress: VecDeque::new(),
            outstanding_progress_bytes: 0,
            blocking_terminal: None,
            next_handoff_id: 0,
            next_progress_id: 0,
            poisoned: false,
            stats: GxRuntimeStats::default(),
        })
    }

    pub const fn limits(&self) -> GxRuntimeLimits {
        self.limits
    }

    pub const fn stats(&self) -> GxRuntimeStats {
        self.stats
    }

    pub const fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    pub fn decoder(&self) -> &lazuli::system::gx::resident_fifo::ResidentGxDecoder {
        &self.decoder
    }

    /// Recreate every resident GX component from the preserved limits. Reset is rejected while
    /// caller-owned progress or terminal allocations remain charged.
    pub fn reset(&mut self) -> Result<(), GxRuntimeError> {
        if !self.outstanding.is_empty() || !self.outstanding_progress.is_empty() {
            return Err(GxRuntimeError::OutstandingHandoffs);
        }
        let replacement = Self::try_new(self.limits)?;
        *self = replacement;
        Ok(())
    }

    pub fn pending_barrier(&self) -> Option<(u64, BarrierClass)> {
        self.decoder.pending_barrier()
    }

    pub fn pending_bytes(&self) -> Result<usize, GxRuntimeError> {
        self.pending
            .retained_bytes()?
            .checked_add(self.outstanding_bytes)
            .and_then(|bytes| bytes.checked_add(self.outstanding_progress_bytes))
            .ok_or(GxRuntimeError::PendingByteLimit {
                requested: usize::MAX,
                maximum: self.limits.maximum_pending_bytes,
            })
    }

    pub fn append<M: GxMemory>(
        &mut self,
        source: &[u8],
        memory: &mut M,
        observed_cycle: u64,
    ) -> Result<GxRuntimeProgress, GxRuntimeError> {
        self.ensure_can_run()?;
        let result = {
            let Self {
                limits,
                decoder,
                vertex,
                texture,
                pending,
                outstanding,
                outstanding_bytes,
                blocking_terminal,
                next_handoff_id,
                stats,
                ..
            } = self;
            match decoder.append(source, memory) {
                Ok(batch) => process_batch(ProcessContext {
                    limits: *limits,
                    vertex,
                    texture,
                    pending,
                    outstanding,
                    outstanding_bytes,
                    blocking_terminal,
                    next_handoff_id,
                    stats,
                    observed_cycle,
                    batch,
                    memory,
                }),
                Err(error) => Err(error.into()),
            }
        };
        self.finish_run(result)
    }

    pub fn resume<M: GxMemory>(
        &mut self,
        memory: &mut M,
        observed_cycle: u64,
    ) -> Result<GxRuntimeProgress, GxRuntimeError> {
        self.ensure_can_run()?;
        let result = {
            let Self {
                limits,
                decoder,
                vertex,
                texture,
                pending,
                outstanding,
                outstanding_bytes,
                blocking_terminal,
                next_handoff_id,
                stats,
                ..
            } = self;
            match decoder.resume(memory) {
                Ok(batch) => process_batch(ProcessContext {
                    limits: *limits,
                    vertex,
                    texture,
                    pending,
                    outstanding,
                    outstanding_bytes,
                    blocking_terminal,
                    next_handoff_id,
                    stats,
                    observed_cycle,
                    batch,
                    memory,
                }),
                Err(error) => Err(error.into()),
            }
        };
        self.finish_run(result)
    }

    /// Request one EFB aperture read after all earlier FIFO semantics have been accumulated.
    pub fn request_efb_peek(
        &mut self,
        request: EfbPeekRequest,
    ) -> Result<GxEfbPeekProgress, GxRuntimeError> {
        self.ensure_can_run()?;
        let decoded = match self.decoder.request_efb_peek(request) {
            Ok(decoded) => decoded,
            Err(error) => {
                self.poisoned = true;
                return Err(error.into());
            }
        };
        let result = match decoded {
            EfbPeekResult::ImmediateZero { combined_plane } => {
                Ok(GxEfbPeekProgress::ImmediateZero { combined_plane })
            }
            EfbPeekResult::YieldForEarlierTerminal => {
                Ok(GxEfbPeekProgress::YieldForEarlierTerminal)
            }
            EfbPeekResult::Terminal(terminal) => emit_terminal(
                TerminalContext {
                    limits: self.limits,
                    pending: &mut self.pending,
                    outstanding: &mut self.outstanding,
                    outstanding_bytes: &mut self.outstanding_bytes,
                    blocking_terminal: &mut self.blocking_terminal,
                    next_handoff_id: &mut self.next_handoff_id,
                    stats: &mut self.stats,
                },
                terminal,
                0,
            )
            .map(GxEfbPeekProgress::Terminal),
        };
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }

    /// Release the exact oldest handoff only after its packet has moved into the render runtime.
    pub fn accept_terminal_handoff(
        &mut self,
        identity: GxHandoffIdentity,
    ) -> Result<(), GxRuntimeError> {
        if self.poisoned {
            return Err(GxRuntimeError::Poisoned);
        }
        let Some(front) = self.outstanding.front() else {
            return Err(GxRuntimeError::NoOutstandingHandoff);
        };
        if front.identity != identity {
            return Err(GxRuntimeError::HandoffMismatch);
        }
        self.outstanding.pop_front();
        self.outstanding_bytes = self
            .outstanding_bytes
            .checked_sub(identity.packet_capacity)
            .ok_or(GxRuntimeError::InternalInvariant(
                "outstanding byte accounting",
            ))?;
        self.stats.handoffs_accepted = self.stats.handoffs_accepted.saturating_add(1);
        Ok(())
    }

    /// Release the exact event-vector charge after all records from that progress were drained.
    pub fn accept_progress(&mut self, identity: GxProgressIdentity) -> Result<(), GxRuntimeError> {
        if self.poisoned {
            return Err(GxRuntimeError::Poisoned);
        }
        let Some(front) = self.outstanding_progress.front() else {
            return Err(GxRuntimeError::NoOutstandingHandoff);
        };
        if front.identity != identity {
            return Err(GxRuntimeError::HandoffMismatch);
        }
        self.outstanding_progress.pop_front();
        self.outstanding_progress_bytes = self
            .outstanding_progress_bytes
            .checked_sub(identity.event_capacity)
            .ok_or(GxRuntimeError::InternalInvariant(
                "progress byte accounting",
            ))?;
        Ok(())
    }

    /// A renderer submission failure is terminal for this already-advanced GX stream.
    pub fn fail_terminal_handoff(
        &mut self,
        identity: GxHandoffIdentity,
    ) -> Result<(), GxRuntimeError> {
        let Some(front) = self.outstanding.front() else {
            return Err(GxRuntimeError::NoOutstandingHandoff);
        };
        if front.identity != identity {
            return Err(GxRuntimeError::HandoffMismatch);
        }
        self.poisoned = true;
        self.outstanding.clear();
        self.outstanding_bytes = 0;
        self.outstanding_progress.clear();
        self.outstanding_progress_bytes = 0;
        Err(GxRuntimeError::Poisoned)
    }

    /// Authenticate and record a materialized texture copy before releasing the decoder barrier.
    pub fn acknowledge_texture_copy<M: GxMemory>(
        &mut self,
        reference: TextureCopyReference,
        materialized_bytes: &[u8],
        memory: &mut M,
        observed_cycle: u64,
    ) -> Result<GxRuntimeProgress, GxRuntimeError> {
        self.ensure_handoffs_drained()?;
        let terminal = self
            .blocking_terminal
            .ok_or(GxRuntimeError::BarrierKindMismatch)?;
        if terminal.kind != ResidentTerminalKind::TextureCopy
            || terminal.barrier != Some(BarrierClass::TextureCopyReceipt)
        {
            return Err(GxRuntimeError::BarrierKindMismatch);
        }
        if let Err(error) = validate_texture_copy_receipt(terminal, reference) {
            self.poisoned = true;
            return Err(error);
        }
        let Some(expected_bytes) =
            usize::try_from(reference.row_bytes)
                .ok()
                .and_then(|row_bytes| {
                    usize::try_from(reference.row_count)
                        .ok()
                        .and_then(|row_count| row_bytes.checked_mul(row_count))
                })
        else {
            self.poisoned = true;
            return Err(GxRuntimeError::TextureCopyReceiptMismatch("byte length"));
        };
        if materialized_bytes.len() != expected_bytes
            || reference.materialized_hash != materialized_texture_hash(materialized_bytes)
        {
            self.poisoned = true;
            return Err(GxRuntimeError::TextureCopyReceiptMismatch(
                "materialized bytes",
            ));
        }
        if let Err(error) = self.texture.record_texture_copy(reference) {
            self.poisoned = true;
            return Err(error.into());
        }
        self.acknowledge_barrier_inner(terminal.sequence, memory, observed_cycle)
    }

    /// Release a texture-copy barrier whose reserved copy format has no physical layout or
    /// materialized receipt. The packet still orders and submits all preceding draws.
    pub fn acknowledge_legacy_texture_copy<M: GxMemory>(
        &mut self,
        sequence: u64,
        memory: &mut M,
        observed_cycle: u64,
    ) -> Result<GxRuntimeProgress, GxRuntimeError> {
        self.ensure_handoffs_drained()?;
        let terminal = self
            .blocking_terminal
            .ok_or(GxRuntimeError::BarrierKindMismatch)?;
        if terminal.kind != ResidentTerminalKind::TextureCopy
            || terminal.barrier != Some(BarrierClass::TextureCopyReceipt)
            || terminal.texture_layout.is_some()
            || terminal.sequence != sequence
        {
            return Err(GxRuntimeError::BarrierKindMismatch);
        }
        self.acknowledge_barrier_inner(sequence, memory, observed_cycle)
    }

    pub fn acknowledge_efb_peek<M: GxMemory, F>(
        &mut self,
        sequence: u64,
        value: u32,
        commit: F,
        memory: &mut M,
        observed_cycle: u64,
    ) -> Result<GxRuntimeProgress, GxRuntimeError>
    where
        F: FnOnce(EfbPeekCommit) -> Result<(), GxRuntimeError>,
    {
        self.ensure_handoffs_drained()?;
        let terminal = self
            .blocking_terminal
            .ok_or(GxRuntimeError::BarrierKindMismatch)?;
        if terminal.kind != ResidentTerminalKind::EfbPeek
            || terminal.barrier != Some(BarrierClass::EfbPeekReceipt)
            || terminal.sequence != sequence
        {
            return Err(GxRuntimeError::BarrierKindMismatch);
        }
        let Ok(alpha_read_mode) = u8::try_from(terminal.stride) else {
            self.poisoned = true;
            return Err(GxRuntimeError::InternalInvariant("EFB alpha-read mode"));
        };
        if let Err(error) = commit(EfbPeekCommit {
            sequence,
            value,
            // Combined-plane addresses retire as ImmediateZero before a renderer terminal is
            // authored. `destination` is the independent bit-22 color/depth plane selector.
            combined_plane: false,
            alpha_read_mode,
        }) {
            self.poisoned = true;
            return Err(error);
        }
        self.acknowledge_barrier_inner(sequence, memory, observed_cycle)
    }

    fn acknowledge_barrier_inner<M: GxMemory>(
        &mut self,
        sequence: u64,
        memory: &mut M,
        observed_cycle: u64,
    ) -> Result<GxRuntimeProgress, GxRuntimeError> {
        if self.poisoned {
            return Err(GxRuntimeError::Poisoned);
        }
        self.blocking_terminal = None;
        let result = {
            let Self {
                limits,
                decoder,
                vertex,
                texture,
                pending,
                outstanding,
                outstanding_bytes,
                blocking_terminal,
                next_handoff_id,
                stats,
                ..
            } = self;
            match decoder.acknowledge_terminal(sequence, memory) {
                Ok(batch) => process_batch(ProcessContext {
                    limits: *limits,
                    vertex,
                    texture,
                    pending,
                    outstanding,
                    outstanding_bytes,
                    blocking_terminal,
                    next_handoff_id,
                    stats,
                    observed_cycle,
                    batch,
                    memory,
                }),
                Err(error) => Err(error.into()),
            }
        };
        self.finish_run(result)
    }

    fn ensure_can_run(&self) -> Result<(), GxRuntimeError> {
        if self.poisoned {
            return Err(GxRuntimeError::Poisoned);
        }
        if !self.outstanding.is_empty() {
            return Err(GxRuntimeError::OutstandingHandoffs);
        }
        if !self.outstanding_progress.is_empty() {
            return Err(GxRuntimeError::OutstandingHandoffs);
        }
        Ok(())
    }

    fn ensure_handoffs_drained(&self) -> Result<(), GxRuntimeError> {
        self.ensure_can_run()
    }

    fn finish_run(
        &mut self,
        result: Result<GxRuntimeProgress, GxRuntimeError>,
    ) -> Result<GxRuntimeProgress, GxRuntimeError> {
        let mut progress = match result {
            Ok(progress) => progress,
            Err(error) => {
                self.poisoned = true;
                return Err(error);
            }
        };
        let charge = progress
            .events
            .capacity()
            .checked_mul(core::mem::size_of::<GxRuntimeEvent>())
            .ok_or(GxRuntimeError::PendingByteLimit {
                requested: usize::MAX,
                maximum: self.limits.maximum_pending_bytes,
            });
        let charge = match charge {
            Ok(charge) => charge,
            Err(error) => {
                self.poisoned = true;
                return Err(error);
            }
        };
        if charge != 0 {
            let next_bytes = self
                .outstanding_progress_bytes
                .checked_add(charge)
                .and_then(|bytes| bytes.checked_add(self.outstanding_bytes))
                .and_then(|bytes| self.pending.retained_bytes().ok()?.checked_add(bytes));
            let Some(next_bytes) = next_bytes else {
                self.poisoned = true;
                return Err(GxRuntimeError::PendingByteLimit {
                    requested: usize::MAX,
                    maximum: self.limits.maximum_pending_bytes,
                });
            };
            if let Err(error) = check_pending_bytes(next_bytes, self.limits.maximum_pending_bytes) {
                self.poisoned = true;
                return Err(error);
            }
            if self.outstanding_progress.len() >= self.limits.maximum_pending_events {
                self.poisoned = true;
                return Err(GxRuntimeError::PendingEventLimit {
                    requested: self.outstanding_progress.len().saturating_add(1),
                    maximum: self.limits.maximum_pending_events,
                });
            }
            if self.outstanding_progress.try_reserve(1).is_err() {
                self.poisoned = true;
                return Err(GxRuntimeError::Allocation(
                    GxAllocationSite::OutstandingHandoffs,
                ));
            }
            let Some(id) = self.next_progress_id.checked_add(1) else {
                self.poisoned = true;
                return Err(GxRuntimeError::HandoffCounterOverflow);
            };
            self.next_progress_id = id;
            let identity = GxProgressIdentity {
                id,
                event_capacity: charge,
            };
            self.outstanding_progress
                .push_back(OutstandingProgress { identity });
            let Some(outstanding_progress_bytes) =
                self.outstanding_progress_bytes.checked_add(charge)
            else {
                self.poisoned = true;
                return Err(GxRuntimeError::PendingByteLimit {
                    requested: usize::MAX,
                    maximum: self.limits.maximum_pending_bytes,
                });
            };
            self.outstanding_progress_bytes = outstanding_progress_bytes;
            progress.identity = Some(identity);
            self.stats.maximum_pending_bytes = self.stats.maximum_pending_bytes.max(next_bytes);
        }
        Ok(progress)
    }
}

struct ProcessContext<'runtime, 'decoder, 'memory, M> {
    limits: GxRuntimeLimits,
    vertex: &'runtime mut ResidentVertexMaterializer,
    texture: &'runtime mut ResidentTextureMaterializer,
    pending: &'runtime mut PacketAccumulator,
    outstanding: &'runtime mut VecDeque<OutstandingHandoff>,
    outstanding_bytes: &'runtime mut usize,
    blocking_terminal: &'runtime mut Option<TerminalSnapshot>,
    next_handoff_id: &'runtime mut u64,
    stats: &'runtime mut GxRuntimeStats,
    observed_cycle: u64,
    batch: DecodeBatch<'decoder>,
    memory: &'memory mut M,
}

fn process_batch<M: GxMemory>(
    context: ProcessContext<'_, '_, '_, M>,
) -> Result<GxRuntimeProgress, GxRuntimeError> {
    let ProcessContext {
        limits,
        vertex,
        texture,
        pending,
        outstanding,
        outstanding_bytes,
        blocking_terminal,
        next_handoff_id,
        stats,
        observed_cycle,
        batch,
        memory,
    } = context;
    let status = batch.status;
    let event_count = batch
        .records()
        .iter()
        .filter(|record| {
            matches!(
                record,
                SemanticRecord::BpLoad { .. } | SemanticRecord::Terminal(_)
            )
        })
        .count();
    if event_count > limits.maximum_pending_events {
        return Err(GxRuntimeError::PendingEventLimit {
            requested: event_count,
            maximum: limits.maximum_pending_events,
        });
    }
    let mut events = Vec::new();
    events
        .try_reserve_exact(event_count)
        .map_err(|_| GxRuntimeError::Allocation(GxAllocationSite::Events))?;
    let event_capacity_bytes = events
        .capacity()
        .checked_mul(core::mem::size_of::<GxRuntimeEvent>())
        .ok_or(GxRuntimeError::PendingByteLimit {
            requested: usize::MAX,
            maximum: limits.maximum_pending_bytes,
        })?;

    let materialized = vertex.materialize_batch(&batch, memory)?.into_owned();
    let (materialization_records, materialized_draws, _) = materialized.into_parts();
    let mut records = materialization_records.into_iter().peekable();
    let mut draws = materialized_draws.into_iter();
    let mut next_materialized_draw = 0u32;

    for semantic in batch.records() {
        match semantic {
            SemanticRecord::BpLoad { register, value } => {
                events.push(GxRuntimeEvent::PeBpLoad(PeBpEffect {
                    observed_cycle,
                    register: *register,
                    value: *value,
                }));
                if matches!(*register, 0x60..=0x66) {
                    match records.next() {
                        Some(MaterializationRecord::TextureState {
                            register: retained_register,
                            value: retained_value,
                        }) if retained_register == *register && retained_value == *value => {}
                        _ => {
                            return Err(GxRuntimeError::InternalInvariant(
                                "texture record ordering",
                            ));
                        }
                    }
                    texture.apply_bp_load(*register, *value, memory)?;
                }
                if matches!(*register, 0x45 | 0x47 | 0x48 | 0xfe) {
                    match records.next() {
                        Some(MaterializationRecord::PeState {
                            register: retained_register,
                            value: retained_value,
                        }) if retained_register == *register && retained_value == *value => {}
                        _ => {
                            return Err(GxRuntimeError::InternalInvariant("PE record ordering"));
                        }
                    }
                }
            }
            SemanticRecord::Draw { draw_index } => match records.next() {
                Some(MaterializationRecord::Ready {
                    source_draw_index,
                    materialized_draw_index,
                }) if source_draw_index == *draw_index
                    && materialized_draw_index == next_materialized_draw =>
                {
                    let draw = draws.next().ok_or(GxRuntimeError::InternalInvariant(
                        "missing materialized draw",
                    ))?;
                    next_materialized_draw = next_materialized_draw.checked_add(1).ok_or(
                        GxRuntimeError::InternalInvariant("materialized draw index overflow"),
                    )?;
                    accumulate_draw(
                        limits,
                        pending,
                        outstanding_bytes.checked_add(event_capacity_bytes).ok_or(
                            GxRuntimeError::PendingByteLimit {
                                requested: usize::MAX,
                                maximum: limits.maximum_pending_bytes,
                            },
                        )?,
                        texture,
                        draw,
                        memory,
                        stats,
                    )?;
                }
                Some(MaterializationRecord::Discarded {
                    source_draw_index, ..
                }) if source_draw_index == *draw_index => {
                    stats.draws_discarded = stats.draws_discarded.saturating_add(1);
                }
                _ => {
                    return Err(GxRuntimeError::InternalInvariant(
                        "materialized draw record ordering",
                    ));
                }
            },
            SemanticRecord::Terminal(terminal) => {
                match records.next() {
                    Some(MaterializationRecord::Terminal(retained)) if retained == *terminal => {}
                    _ => {
                        return Err(GxRuntimeError::InternalInvariant(
                            "terminal record ordering",
                        ));
                    }
                }
                let handoff = emit_terminal(
                    TerminalContext {
                        limits,
                        pending,
                        outstanding,
                        outstanding_bytes,
                        blocking_terminal,
                        next_handoff_id,
                        stats,
                    },
                    *terminal,
                    event_capacity_bytes,
                )?;
                events.push(GxRuntimeEvent::Terminal(handoff));
            }
            SemanticRecord::CpLoad { .. }
            | SemanticRecord::XfLoad { .. }
            | SemanticRecord::IndexedXfLoad { .. }
            | SemanticRecord::DisplayListCall { .. }
            | SemanticRecord::InvalidateVertexCache
            | SemanticRecord::UnsupportedOpcode { .. } => {}
        }
    }
    if records.next().is_some() || draws.next().is_some() {
        return Err(GxRuntimeError::InternalInvariant(
            "unconsumed materialization output",
        ));
    }
    stats.batches = stats.batches.saturating_add(1);
    update_high_water(
        pending,
        outstanding_bytes.checked_add(event_capacity_bytes).ok_or(
            GxRuntimeError::PendingByteLimit {
                requested: usize::MAX,
                maximum: limits.maximum_pending_bytes,
            },
        )?,
        stats,
        limits.maximum_pending_bytes,
    )?;
    Ok(GxRuntimeProgress {
        status,
        events,
        identity: None,
    })
}

fn accumulate_draw<M: GxMemory>(
    limits: GxRuntimeLimits,
    pending: &mut PacketAccumulator,
    outstanding_bytes: usize,
    texture_materializer: &mut ResidentTextureMaterializer,
    draw: MaterializedDraw,
    memory: &mut M,
    stats: &mut GxRuntimeStats,
) -> Result<(), GxRuntimeError> {
    let requested_draws =
        pending
            .draws
            .len()
            .checked_add(1)
            .ok_or(GxRuntimeError::PendingDrawLimit {
                requested: usize::MAX,
                maximum: limits.maximum_pending_draws,
            })?;
    if requested_draws > limits.maximum_pending_draws {
        return Err(GxRuntimeError::PendingDrawLimit {
            requested: requested_draws,
            maximum: limits.maximum_pending_draws,
        });
    }

    let used_map_mask = draw
        .texture_use_order
        .as_slice()
        .iter()
        .flatten()
        .fold(0u8, |mask, texture_use| {
            mask | (1u8 << texture_use.texture_map)
        });
    let texture_batch = texture_materializer
        .materialize_maps(&draw.textures, used_map_mask, memory)?
        .into_retained();
    let (textures, _, _) = texture_batch.into_parts();
    let mut texture_indices = [None; MAX_TEXTURES];
    let mut insert_texture = [false; MAX_TEXTURES];
    let mut new_textures = 0usize;
    let mut new_texture_payload = 0usize;
    for (offset, texture) in textures.iter().enumerate() {
        let map = usize::from(texture.map());
        if map >= MAX_TEXTURES || texture_indices[map].is_some() {
            return Err(GxRuntimeError::InternalInvariant(
                "materialized texture map",
            ));
        }
        if let Some(index) = pending
            .textures
            .iter()
            .position(|existing| existing.key() == texture.key())
        {
            if !texture_packet_equivalent(&pending.textures[index], texture) {
                return Err(GxRuntimeError::InternalInvariant("texture key collision"));
            }
            texture_indices[map] = Some(
                u32::try_from(index)
                    .map_err(|_| GxRuntimeError::InternalInvariant("texture index"))?,
            );
            stats.texture_deduplications = stats.texture_deduplications.saturating_add(1);
            continue;
        }
        if let Some(earlier) = textures[..offset]
            .iter()
            .find(|earlier| earlier.key() == texture.key())
        {
            if !texture_packet_equivalent(earlier, texture) {
                return Err(GxRuntimeError::InternalInvariant("texture key collision"));
            }
            texture_indices[map] = texture_indices[usize::from(earlier.map())];
            stats.texture_deduplications = stats.texture_deduplications.saturating_add(1);
            continue;
        }
        let index = pending
            .textures
            .len()
            .checked_add(new_textures)
            .ok_or(GxRuntimeError::InternalInvariant("texture index"))?;
        texture_indices[map] = Some(
            u32::try_from(index).map_err(|_| GxRuntimeError::InternalInvariant("texture index"))?,
        );
        insert_texture[map] = true;
        new_textures = new_textures
            .checked_add(1)
            .ok_or(GxRuntimeError::PendingTextureLimit {
                requested: usize::MAX,
                maximum: limits.maximum_pending_textures,
            })?;
        new_texture_payload = new_texture_payload
            .checked_add(texture.retained_bytes())
            .ok_or(GxRuntimeError::PendingByteLimit {
                requested: usize::MAX,
                maximum: limits.maximum_pending_bytes,
            })?;
    }
    let requested_textures = pending.textures.len().checked_add(new_textures).ok_or(
        GxRuntimeError::PendingTextureLimit {
            requested: usize::MAX,
            maximum: limits.maximum_pending_textures,
        },
    )?;
    if requested_textures > limits.maximum_pending_textures {
        return Err(GxRuntimeError::PendingTextureLimit {
            requested: requested_textures,
            maximum: limits.maximum_pending_textures,
        });
    }

    pending
        .draws
        .try_reserve_exact(1)
        .map_err(|_| GxRuntimeError::Allocation(GxAllocationSite::PendingDraws))?;
    pending
        .textures
        .try_reserve_exact(new_textures)
        .map_err(|_| GxRuntimeError::Allocation(GxAllocationSite::PendingTextures))?;
    let new_payload = pending
        .payload_bytes
        .checked_add(draw.retained_bytes())
        .and_then(|bytes| bytes.checked_add(new_texture_payload))
        .ok_or(GxRuntimeError::PendingByteLimit {
            requested: usize::MAX,
            maximum: limits.maximum_pending_bytes,
        })?;
    let prospective = pending
        .draws
        .capacity()
        .checked_mul(core::mem::size_of::<PendingDraw>())
        .and_then(|bytes| {
            pending
                .textures
                .capacity()
                .checked_mul(core::mem::size_of::<MaterializedTexture>())
                .and_then(|texture_bytes| bytes.checked_add(texture_bytes))
        })
        .and_then(|bytes| bytes.checked_add(new_payload))
        .and_then(|bytes| bytes.checked_add(outstanding_bytes))
        .ok_or(GxRuntimeError::PendingByteLimit {
            requested: usize::MAX,
            maximum: limits.maximum_pending_bytes,
        })?;
    check_pending_bytes(prospective, limits.maximum_pending_bytes)?;

    let original_texture_len = pending.textures.len();
    for texture in textures {
        let map = usize::from(texture.map());
        let index =
            texture_indices[map].ok_or(GxRuntimeError::InternalInvariant("texture binding"))?;
        if insert_texture[map] {
            let expected = usize::try_from(index)
                .map_err(|_| GxRuntimeError::InternalInvariant("texture index"))?;
            if expected != pending.textures.len() || expected < original_texture_len {
                return Err(GxRuntimeError::InternalInvariant("texture insertion order"));
            }
            pending.textures.push(texture);
        }
    }
    if pending.textures.len() != requested_textures {
        return Err(GxRuntimeError::InternalInvariant("texture insertion count"));
    }
    pending.payload_bytes = new_payload;
    pending.draws.push(PendingDraw {
        draw,
        texture_indices,
    });
    stats.draws_accumulated = stats.draws_accumulated.saturating_add(1);
    stats.textures_accumulated = stats
        .textures_accumulated
        .saturating_add(u64::try_from(new_textures).unwrap_or(u64::MAX));
    Ok(())
}

struct TerminalContext<'runtime> {
    limits: GxRuntimeLimits,
    pending: &'runtime mut PacketAccumulator,
    outstanding: &'runtime mut VecDeque<OutstandingHandoff>,
    outstanding_bytes: &'runtime mut usize,
    blocking_terminal: &'runtime mut Option<TerminalSnapshot>,
    next_handoff_id: &'runtime mut u64,
    stats: &'runtime mut GxRuntimeStats,
}

fn emit_terminal(
    context: TerminalContext<'_>,
    terminal: TerminalSnapshot,
    transient_bytes: usize,
) -> Result<GxTerminalHandoff, GxRuntimeError> {
    let TerminalContext {
        limits,
        pending,
        outstanding,
        outstanding_bytes,
        blocking_terminal,
        next_handoff_id,
        stats,
    } = context;
    if terminal.barrier.is_some() && blocking_terminal.is_some() {
        return Err(GxRuntimeError::InternalInvariant(
            "multiple blocking terminals",
        ));
    }
    let version = select_packet_version(pending)?;
    let (packet, workspace_charge) = encode_pending_packet(pending, terminal, version)?;
    if packet.len() > limits.maximum_packet_bytes {
        return Err(GxRuntimeError::PacketByteLimit {
            requested: packet.len(),
            maximum: limits.maximum_packet_bytes,
        });
    }
    let pending_charge = packet.capacity();
    let live_before_release = pending
        .retained_bytes()?
        .checked_add(*outstanding_bytes)
        .and_then(|bytes| bytes.checked_add(transient_bytes))
        .and_then(|bytes| bytes.checked_add(workspace_charge))
        .and_then(|bytes| bytes.checked_add(pending_charge))
        .ok_or(GxRuntimeError::PendingByteLimit {
            requested: usize::MAX,
            maximum: limits.maximum_pending_bytes,
        })?;
    check_pending_bytes(live_before_release, limits.maximum_pending_bytes)?;

    let next_outstanding =
        outstanding
            .len()
            .checked_add(1)
            .ok_or(GxRuntimeError::PendingEventLimit {
                requested: usize::MAX,
                maximum: limits.maximum_pending_events,
            })?;
    if next_outstanding > limits.maximum_pending_events {
        return Err(GxRuntimeError::PendingEventLimit {
            requested: next_outstanding,
            maximum: limits.maximum_pending_events,
        });
    }
    outstanding
        .try_reserve(1)
        .map_err(|_| GxRuntimeError::Allocation(GxAllocationSite::OutstandingHandoffs))?;
    let id = next_handoff_id
        .checked_add(1)
        .ok_or(GxRuntimeError::HandoffCounterOverflow)?;
    *next_handoff_id = id;
    let identity = GxHandoffIdentity {
        id,
        terminal_sequence: terminal.sequence,
        packet_capacity: pending_charge,
    };
    *outstanding_bytes =
        outstanding_bytes
            .checked_add(pending_charge)
            .ok_or(GxRuntimeError::PendingByteLimit {
                requested: usize::MAX,
                maximum: limits.maximum_pending_bytes,
            })?;
    check_pending_bytes(*outstanding_bytes, limits.maximum_pending_bytes)?;
    outstanding.push_back(OutstandingHandoff { identity });
    if terminal.barrier.is_some() {
        *blocking_terminal = Some(terminal);
    }
    let supplement = match terminal.kind {
        ResidentTerminalKind::TextureCopy => GxTerminalSupplement::TextureCopy {
            layout: terminal.texture_layout,
        },
        ResidentTerminalKind::XfbCopy => GxTerminalSupplement::XfbCopy,
        ResidentTerminalKind::EfbPeek => GxTerminalSupplement::EfbPeek,
    };
    let metadata = GxTerminalMetadata {
        terminal,
        version,
        supplement,
    };
    pending.clear_and_release();
    stats.terminals = stats.terminals.saturating_add(1);
    stats.packet_bytes = stats
        .packet_bytes
        .saturating_add(u64::try_from(packet.len()).unwrap_or(u64::MAX));
    match version {
        PacketVersion::V4 => stats.packets_v4 = stats.packets_v4.saturating_add(1),
        PacketVersion::V5 => stats.packets_v5 = stats.packets_v5.saturating_add(1),
        PacketVersion::V6 => stats.packets_v6 = stats.packets_v6.saturating_add(1),
        PacketVersion::V7 => stats.packets_v7 = stats.packets_v7.saturating_add(1),
    }
    stats.maximum_pending_bytes = stats.maximum_pending_bytes.max(*outstanding_bytes);
    Ok(GxTerminalHandoff {
        identity,
        packet,
        metadata,
    })
}

#[derive(Clone, Copy)]
struct PreparedDraw {
    tev_state: [u8; TEV_STATE_BYTES as usize],
    textures: [TextureBinding; MAX_TEXTURES],
    indirect: Option<IndirectTevState>,
}

fn encode_pending_packet(
    pending: &PacketAccumulator,
    terminal: TerminalSnapshot,
    version: PacketVersion,
) -> Result<(Vec<u8>, usize), GxRuntimeError> {
    let use_indirect = pending
        .draws
        .iter()
        .any(|pending_draw| has_semantic_indirect_state(&pending_draw.draw));
    let mut prepared_draws = Vec::new();
    prepared_draws
        .try_reserve_exact(pending.draws.len())
        .map_err(|_| GxRuntimeError::Allocation(GxAllocationSite::PreparedDraws))?;
    for pending_draw in &pending.draws {
        let mut textures = [TextureBinding {
            texture: None,
            mode0: 0,
            mode1: 0,
        }; MAX_TEXTURES];
        for (map, index) in pending_draw.texture_indices.iter().enumerate() {
            let Some(index) = index else { continue };
            let texture = pending
                .textures
                .get(
                    usize::try_from(*index)
                        .map_err(|_| GxRuntimeError::InternalInvariant("draw texture index"))?,
                )
                .ok_or(GxRuntimeError::InternalInvariant("draw texture index"))?;
            let sampler = texture.sampler();
            textures[map] = TextureBinding {
                texture: Some(*index),
                mode0: if version == PacketVersion::V7 {
                    sampler.mode0
                } else {
                    sampler.mode0 & SAMPLER_MODE0_MASK_V4
                },
                mode1: if version == PacketVersion::V7 {
                    sampler.mode1
                } else {
                    0
                },
            };
        }
        prepared_draws.push(PreparedDraw {
            tev_state: encode_tev_state(&pending_draw.draw),
            textures,
            indirect: use_indirect.then(|| indirect_tev_state(&pending_draw.draw)),
        });
    }

    let mut v7_keys: Vec<Option<String>> = Vec::new();
    v7_keys
        .try_reserve_exact(pending.textures.len())
        .map_err(|_| GxRuntimeError::Allocation(GxAllocationSite::V7Keys))?;
    for texture in &pending.textures {
        let genuine = matches!(
            texture.sampler().strict_v7,
            StrictV7Preflight::Accepted(StrictV7Classification::GenuineMip)
        );
        if version == PacketVersion::V7 && genuine {
            v7_keys.push(Some(v7_texture_key(texture.key())?));
        } else {
            v7_keys.push(None);
        }
    }

    let mut texture_inputs = Vec::new();
    texture_inputs
        .try_reserve_exact(pending.textures.len())
        .map_err(|_| GxRuntimeError::Allocation(GxAllocationSite::TextureInputs))?;
    for (index, texture) in pending.textures.iter().enumerate() {
        let packet = texture.packet_input();
        let mip_level_count = if version == PacketVersion::V7 {
            packet.mip_level_count
        } else {
            1
        };
        let pixels = match packet.pixels {
            Some(pixels) if version != PacketVersion::V7 => {
                let base_bytes = texture
                    .mip_levels()
                    .first()
                    .ok_or(GxRuntimeError::InternalInvariant("texture mip layout"))?
                    .pixel_bytes;
                Some(
                    pixels
                        .get(..base_bytes)
                        .ok_or(GxRuntimeError::InternalInvariant("texture base pixels"))?,
                )
            }
            pixels => pixels,
        };
        texture_inputs.push(TextureInput {
            key: v7_keys[index].as_deref().unwrap_or(packet.key),
            pixels,
            address: packet.address,
            generation: packet.generation,
            width: packet.width,
            height: packet.height,
            mip_level_count,
        });
    }

    let mut draw_inputs = Vec::new();
    draw_inputs
        .try_reserve_exact(pending.draws.len())
        .map_err(|_| GxRuntimeError::Allocation(GxAllocationSite::DrawInputs))?;
    for (index, pending_draw) in pending.draws.iter().enumerate() {
        let draw = &pending_draw.draw;
        let prepared = &prepared_draws[index];
        draw_inputs.push(DrawInput {
            topology: draw.topology,
            cull_mode: draw.pipeline.cull_mode,
            vertices: draw.vertices.as_bytes(),
            tev_state: &prepared.tev_state,
            z_mode: draw.pipeline.z_mode,
            blend_mode: draw.pipeline.blend_mode,
            alpha_test: draw.pipeline.alpha_test,
            scissor_x: draw.pipeline.scissor_x,
            scissor_y: draw.pipeline.scissor_y,
            scissor_width: draw.pipeline.scissor_width,
            scissor_height: draw.pipeline.scissor_height,
            textures: prepared.textures,
            fragment: FragmentState {
                pixel_control: draw.pipeline.pixel_control,
                constant_alpha: draw.pipeline.constant_alpha,
                z_texture_bias: draw.pipeline.z_texture_bias,
                z_texture_mode: draw.pipeline.z_texture_mode,
                fog_range_base: draw.pipeline.fog_range_base,
                fog_range_k: draw.pipeline.fog_range_k,
                fog_words: draw.pipeline.fog_words,
                viewport_half_width_bits: draw.pipeline.viewport_half_width_bits,
            },
            evidence: materialized_evidence(&draw.evidence),
            indirect_tev: prepared.indirect,
        });
    }

    let workspace_charge = prepared_draws
        .capacity()
        .checked_mul(core::mem::size_of::<PreparedDraw>())
        .and_then(|bytes| {
            texture_inputs
                .capacity()
                .checked_mul(core::mem::size_of::<TextureInput<'_>>())
                .and_then(|value| bytes.checked_add(value))
        })
        .and_then(|bytes| {
            draw_inputs
                .capacity()
                .checked_mul(core::mem::size_of::<DrawInput<'_>>())
                .and_then(|value| bytes.checked_add(value))
        })
        .and_then(|bytes| {
            v7_keys
                .capacity()
                .checked_mul(core::mem::size_of::<Option<String>>())
                .and_then(|value| bytes.checked_add(value))
        })
        .and_then(|bytes| {
            v7_keys.iter().try_fold(bytes, |total, key| {
                total.checked_add(key.as_ref().map_or(0, String::capacity))
            })
        })
        .ok_or(GxRuntimeError::PendingByteLimit {
            requested: usize::MAX,
            maximum: usize::MAX,
        })?;
    let packet = encode(&PacketInput {
        version,
        terminal: terminal_state(terminal),
        draws: &draw_inputs,
        textures: &texture_inputs,
    })?;
    Ok((packet, workspace_charge))
}

fn select_packet_version(pending: &PacketAccumulator) -> Result<PacketVersion, GxRuntimeError> {
    let mut has_genuine_mip = false;
    for texture in &pending.textures {
        match texture.sampler().strict_v7 {
            StrictV7Preflight::Accepted(StrictV7Classification::GenuineMip) => {
                if texture.mip_levels().len() <= 1 {
                    return Err(GxRuntimeError::InternalInvariant(
                        "genuine mip classification without mip chain",
                    ));
                }
                has_genuine_mip = true;
            }
            StrictV7Preflight::Accepted(StrictV7Classification::BaseOnlyCompanion) => {
                if texture.mip_levels().len() != 1 {
                    return Err(GxRuntimeError::InternalInvariant(
                        "base-only classification with mip chain",
                    ));
                }
            }
            StrictV7Preflight::Rejected(_) => {}
        }
    }
    if has_genuine_mip {
        if pending
            .textures
            .iter()
            .any(|texture| matches!(texture.sampler().strict_v7, StrictV7Preflight::Rejected(_)))
        {
            return Err(GxRuntimeError::InternalInvariant(
                "v7 frame contains a rejected companion sampler",
            ));
        }
        return Ok(PacketVersion::V7);
    }
    let mut optional_exact = false;
    for pending_draw in &pending.draws {
        match pending_draw.draw.evidence {
            MaterializedEvidence::Exact { required: true, .. } => {
                return Ok(PacketVersion::V6);
            }
            MaterializedEvidence::Exact {
                required: false, ..
            } => optional_exact = true,
            MaterializedEvidence::None | MaterializedEvidence::PostCull(_) => {}
        }
    }
    Ok(if optional_exact {
        PacketVersion::V5
    } else {
        PacketVersion::V4
    })
}

fn encode_tev_state(draw: &MaterializedDraw) -> [u8; TEV_STATE_BYTES as usize] {
    let mut state = [0; TEV_STATE_BYTES as usize];
    for (index, stage) in draw
        .tev
        .stages
        .iter()
        .enumerate()
        .take(usize::from(draw.tev.stage_count))
    {
        let offset = index * 16;
        let references = u32::from(stage.texture_map & 7)
            | (u32::from(stage.texture_coord & 7) << 3)
            | (u32::from(stage.texture_enabled) << 6)
            | (u32::from(stage.color_channel & 7) << 7);
        let konst = u32::from(stage.konst_color_selector & 0x1f)
            | (u32::from(stage.konst_alpha_selector & 0x1f) << 5);
        put_u32(&mut state, offset, stage.color_combiner & 0x00ff_ffff);
        put_u32(&mut state, offset + 4, stage.alpha_combiner & 0x00ff_ffff);
        put_u32(&mut state, offset + 8, references);
        put_u32(&mut state, offset + 12, konst);
    }
    for register in 0..4 {
        for component in 0..4 {
            put_u32(
                &mut state,
                256 + (register * 4 + component) * 4,
                u32::from_ne_bytes(draw.tev.color_registers[register][component].to_ne_bytes()),
            );
            put_u32(
                &mut state,
                320 + (register * 4 + component) * 4,
                u32::from_ne_bytes(draw.tev.konst_registers[register][component].to_ne_bytes()),
            );
            put_u32(
                &mut state,
                384 + (register * 4 + component) * 4,
                u32::from(draw.tev.swap_tables[register][component]),
            );
        }
    }
    put_u32(&mut state, 448, u32::from(draw.tev.stage_count));
    state
}

fn materialized_evidence(evidence: &MaterializedEvidence) -> DrawEvidence<'_> {
    match evidence {
        MaterializedEvidence::None => DrawEvidence::None,
        MaterializedEvidence::PostCull(bytes) => DrawEvidence::PostCull(bytes),
        MaterializedEvidence::Exact { required, input } => DrawEvidence::Exact {
            required: *required,
            input: ExactClipInput {
                bp_gen_mode: input.bp_gen_mode,
                bp_scissor_top_left: input.bp_scissor_top_left,
                bp_scissor_bottom_right: input.bp_scissor_bottom_right,
                bp_scissor_offset: input.bp_scissor_offset,
                xf_clip_disable: input.xf_clip_disable,
                viewport_bits: input.viewport_bits,
                position_bits: &input.position_bits,
            },
        },
    }
}

fn indirect_tev_state(draw: &MaterializedDraw) -> IndirectTevState {
    let state = draw.pipeline.indirect_tev;
    IndirectTevState {
        encoding: INDIRECT_TEV_STATE_ENCODING_BP_WORDS_XF_V2,
        gen_mode: state.gen_mode,
        matrices: state.matrices,
        imask: state.imask,
        commands: state.commands,
        tex_scales: state.tex_scales,
        iref: state.iref,
        xf_num_tex_gens: state.xf_num_tex_gens,
    }
}

fn has_semantic_indirect_state(draw: &MaterializedDraw) -> bool {
    let state = draw.pipeline.indirect_tev;
    let stage_count = usize::from(draw.tev.stage_count).min(16);
    let direct_requires_state = state.xf_num_tex_gens == 0
        || draw.tev.stages[..stage_count].iter().any(|stage| {
            stage.texture_enabled && u32::from(stage.texture_coord) >= state.xf_num_tex_gens
        });
    ((state.gen_mode >> 16) & 7) != 0
        || direct_requires_state
        || state.commands[..stage_count]
            .iter()
            .any(|command| command & 0x001f_ffff != 0)
}

fn terminal_state(terminal: TerminalSnapshot) -> TerminalState {
    let legacy_texture_copy =
        terminal.kind == ResidentTerminalKind::TextureCopy && terminal.texture_layout.is_none();
    TerminalState {
        kind: match terminal.kind {
            ResidentTerminalKind::TextureCopy => TerminalKind::TextureCopy,
            ResidentTerminalKind::XfbCopy => TerminalKind::XfbCopy,
            ResidentTerminalKind::EfbPeek => TerminalKind::EfbPeek,
        },
        texture_copy_layout_v1: terminal.texture_layout.is_some(),
        source_x: terminal.source_x,
        source_y: terminal.source_y,
        source_width: terminal.source_width,
        source_height: terminal.source_height,
        output_width: if legacy_texture_copy {
            0
        } else {
            terminal.output_width
        },
        output_height: if legacy_texture_copy {
            0
        } else {
            terminal.output_height
        },
        destination: terminal.destination,
        stride: if legacy_texture_copy {
            0
        } else {
            terminal.stride
        },
        generation: terminal.generation,
        clear: terminal.clear,
        copy: copy_state(terminal.copy),
    }
}

fn copy_state(copy: CopyStateSnapshot) -> CopyState {
    CopyState {
        z_mode: copy.z_mode,
        blend_mode: copy.blend_mode,
        pixel_control: copy.pixel_control,
        copy_command: copy.copy_command,
        clear_rgba: copy.clear_rgba,
        clear_depth: copy.clear_depth,
        copy_scale: copy.copy_scale,
        copy_filter: copy.copy_filter,
    }
}

fn validate_texture_copy_receipt(
    terminal: TerminalSnapshot,
    reference: TextureCopyReference,
) -> Result<(), GxRuntimeError> {
    let layout = terminal
        .texture_layout
        .ok_or(GxRuntimeError::TextureCopyReceiptMismatch("layout"))?;
    for (matches, field) in [
        (reference.destination == terminal.destination, "destination"),
        (reference.generation == terminal.generation, "generation"),
        (reference.width == terminal.output_width, "width"),
        (reference.height == terminal.output_height, "height"),
        (reference.format == layout.base_format, "format"),
        (reference.stride == terminal.stride, "stride"),
        (reference.row_bytes == layout.row_bytes, "row_bytes"),
        (reference.row_count == layout.row_count, "row_count"),
    ] {
        if !matches {
            return Err(GxRuntimeError::TextureCopyReceiptMismatch(field));
        }
    }
    Ok(())
}

fn texture_packet_equivalent(left: &MaterializedTexture, right: &MaterializedTexture) -> bool {
    let left_packet = left.packet_input();
    let right_packet = right.packet_input();
    left_packet.key == right_packet.key
        && left_packet.pixels == right_packet.pixels
        && left_packet.address == right_packet.address
        && left_packet.generation == right_packet.generation
        && left_packet.width == right_packet.width
        && left_packet.height == right_packet.height
        && left_packet.mip_level_count == right_packet.mip_level_count
}

fn v7_texture_key(key: &str) -> Result<String, GxRuntimeError> {
    const TAG: &str = "~LZGX7:";
    if key.is_empty() || key.contains(TAG) {
        return Err(GxRuntimeError::InternalInvariant("v7 texture key domain"));
    }
    let decimal_digits = decimal_digits(key.len());
    let capacity = key
        .len()
        .checked_add(TAG.len())
        .and_then(|value| value.checked_add(decimal_digits))
        .ok_or(GxRuntimeError::PendingByteLimit {
            requested: usize::MAX,
            maximum: usize::MAX,
        })?;
    let mut result = String::new();
    result
        .try_reserve_exact(capacity)
        .map_err(|_| GxRuntimeError::Allocation(GxAllocationSite::V7Keys))?;
    result.push_str(key);
    result.push_str(TAG);
    write!(result, "{}", key.len())
        .map_err(|_| GxRuntimeError::Allocation(GxAllocationSite::V7Keys))?;
    Ok(result)
}

fn decimal_digits(mut value: usize) -> usize {
    let mut digits = 1;
    while value >= 10 {
        value /= 10;
        digits += 1;
    }
    digits
}

fn update_high_water(
    pending: &PacketAccumulator,
    outstanding_bytes: usize,
    stats: &mut GxRuntimeStats,
    maximum: usize,
) -> Result<(), GxRuntimeError> {
    let bytes = pending
        .retained_bytes()?
        .checked_add(outstanding_bytes)
        .ok_or(GxRuntimeError::PendingByteLimit {
            requested: usize::MAX,
            maximum,
        })?;
    check_pending_bytes(bytes, maximum)?;
    stats.maximum_pending_bytes = stats.maximum_pending_bytes.max(bytes);
    Ok(())
}

fn check_pending_bytes(requested: usize, maximum: usize) -> Result<(), GxRuntimeError> {
    if requested > maximum {
        return Err(GxRuntimeError::PendingByteLimit { requested, maximum });
    }
    Ok(())
}

fn put_u32<const N: usize>(bytes: &mut [u8; N], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}
