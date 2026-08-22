//! Host-neutral resident GX vertex materialization.
//!
//! The FIFO decoder deliberately retains encoded vertex payloads. This module is the next
//! architectural boundary: it replays the decoder's ordered CP/BP/XF records, performs exact
//! guest-memory reads for indexed attributes, and emits the canonical 36-f32/144-byte carrier
//! consumed by a later packet encoder. Texture pixels/TMEM and PE token/finish effects are not
//! part of this layer.

use core::fmt;
use core::marker::PhantomData;
use std::vec::Vec;

use super::resident_fifo::{
    DecodeBatch, DrawSnapshot, ExactRasterSnapshot, GxMemory, MemoryError, PipelineSnapshot,
    SemanticRecord, TerminalSnapshot, TevSnapshot, TextureRegisterSnapshot, TextureUseOrder,
};

const CP_REGISTER_COUNT: usize = 0x100;
const BP_REGISTER_COUNT: usize = 0x100;
const XF_REGISTER_COUNT: usize = 0x1058;
/// Carrier lanes: projected XYZW, raster-channel-0 RGBA, raster-channel-1 RGBA, then eight STQ
/// texgen triples. Every lane is stored as an IEEE-754 f32 in little-endian byte order.
pub const CANONICAL_VERTEX_FLOATS: usize = 36;
pub const CANONICAL_VERTEX_BYTES: usize = CANONICAL_VERTEX_FLOATS * core::mem::size_of::<f32>();
const ATTRIBUTE_SCRATCH_BYTES: usize = 36;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MaterializerLimits {
    pub maximum_draws_per_batch: usize,
    pub maximum_records_per_batch: usize,
    pub maximum_vertices_per_draw: usize,
    pub maximum_encoded_vertex_bytes_per_draw: usize,
    pub maximum_canonical_vertex_bytes_per_draw: usize,
    pub maximum_evidence_bytes_per_draw: usize,
    /// One ceiling for output retained by a batch plus the active draw's bounded scratch.
    pub maximum_resident_bytes: usize,
}

impl Default for MaterializerLimits {
    fn default() -> Self {
        Self {
            maximum_draws_per_batch: 65_536,
            maximum_records_per_batch: 65_536,
            maximum_vertices_per_draw: usize::from(u16::MAX),
            maximum_encoded_vertex_bytes_per_draw: 16 * 1024 * 1024,
            maximum_canonical_vertex_bytes_per_draw: 10 * 1024 * 1024,
            maximum_evidence_bytes_per_draw: 2 * 1024 * 1024,
            // The FIFO slice has its own 32-MiB ceiling. Materialization is normally denser than
            // its encoded input, so cap this simultaneously live second representation at 16 MiB.
            maximum_resident_bytes: 16 * 1024 * 1024,
        }
    }
}

impl MaterializerLimits {
    fn validate(self) -> Result<Self, MaterializeError> {
        if self.maximum_draws_per_batch == 0 {
            return Err(MaterializeError::InvalidLimit("maximum_draws_per_batch"));
        }
        if self.maximum_records_per_batch == 0 {
            return Err(MaterializeError::InvalidLimit("maximum_records_per_batch"));
        }
        if self.maximum_vertices_per_draw == 0 {
            return Err(MaterializeError::InvalidLimit("maximum_vertices_per_draw"));
        }
        if self.maximum_encoded_vertex_bytes_per_draw == 0 {
            return Err(MaterializeError::InvalidLimit(
                "maximum_encoded_vertex_bytes_per_draw",
            ));
        }
        if self.maximum_canonical_vertex_bytes_per_draw < CANONICAL_VERTEX_BYTES {
            return Err(MaterializeError::InvalidLimit(
                "maximum_canonical_vertex_bytes_per_draw",
            ));
        }
        if self.maximum_evidence_bytes_per_draw == 0 {
            return Err(MaterializeError::InvalidLimit(
                "maximum_evidence_bytes_per_draw",
            ));
        }
        if self.maximum_resident_bytes < self.maximum_canonical_vertex_bytes_per_draw
            || self.maximum_resident_bytes < self.maximum_evidence_bytes_per_draw
        {
            return Err(MaterializeError::InvalidLimit("maximum_resident_bytes"));
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MaterializeAllocationSite {
    RegisterFile,
    BatchRecords,
    BatchDraws,
    CanonicalVertices,
    SourcePositions,
    MatrixIndices,
    Evidence,
    ExactClipPositions,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MaterializeError {
    InvalidLimit(&'static str),
    DrawLimit {
        requested: usize,
        maximum: usize,
    },
    RecordLimit {
        requested: usize,
        maximum: usize,
    },
    VertexLimit {
        requested: usize,
        maximum: usize,
    },
    EncodedVertexBytes {
        requested: usize,
        maximum: usize,
    },
    CanonicalVertexBytes {
        requested: usize,
        maximum: usize,
    },
    EvidenceBytes {
        requested: usize,
        maximum: usize,
    },
    ResidentBytes {
        requested: usize,
        maximum: usize,
    },
    VertexByteOverflow,
    EncodedLength {
        expected: usize,
        received: usize,
    },
    UnsupportedVat(u8),
    StateMismatch(&'static str),
    DrawIndex(u32),
    XfRange {
        start: u16,
        count: u8,
    },
    TruncatedVertex {
        vertex: u16,
        cursor: usize,
        required: usize,
        available: usize,
    },
    Allocation {
        site: MaterializeAllocationSite,
    },
}

impl fmt::Display for MaterializeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLimit(name) => {
                write!(formatter, "invalid resident GX vertex limit {name}")
            }
            Self::DrawLimit { requested, maximum } => write!(
                formatter,
                "resident GX materialized draw count exceeds bound: {requested} > {maximum}"
            ),
            Self::RecordLimit { requested, maximum } => write!(
                formatter,
                "resident GX materialization record count exceeds bound: {requested} > {maximum}"
            ),
            Self::VertexLimit { requested, maximum } => write!(
                formatter,
                "resident GX materialized vertex count exceeds bound: {requested} > {maximum}"
            ),
            Self::EncodedVertexBytes { requested, maximum } => write!(
                formatter,
                "resident GX encoded vertex bytes exceed bound: {requested} > {maximum}"
            ),
            Self::CanonicalVertexBytes { requested, maximum } => write!(
                formatter,
                "resident GX canonical vertex bytes exceed bound: {requested} > {maximum}"
            ),
            Self::EvidenceBytes { requested, maximum } => write!(
                formatter,
                "resident GX evidence bytes exceed bound: {requested} > {maximum}"
            ),
            Self::ResidentBytes { requested, maximum } => write!(
                formatter,
                "resident GX vertex resident bytes exceed bound: {requested} > {maximum}"
            ),
            Self::VertexByteOverflow => {
                formatter.write_str("resident GX vertex byte count overflow")
            }
            Self::EncodedLength { expected, received } => write!(
                formatter,
                "resident GX encoded vertex length mismatch: expected {expected}, received {received}"
            ),
            Self::UnsupportedVat(vat) => write!(formatter, "unsupported resident GX VAT {vat}"),
            Self::StateMismatch(field) => {
                write!(
                    formatter,
                    "resident GX draw snapshot state mismatch: {field}"
                )
            }
            Self::DrawIndex(index) => {
                write!(formatter, "resident GX draw index {index} is invalid")
            }
            Self::XfRange { start, count } => write!(
                formatter,
                "resident GX materializer XF range is invalid: {start:#06x} + {count}"
            ),
            Self::TruncatedVertex {
                vertex,
                cursor,
                required,
                available,
            } => write!(
                formatter,
                "resident GX vertex {vertex} is truncated at {cursor}: needs {required}, has {available}"
            ),
            Self::Allocation { site } => {
                write!(
                    formatter,
                    "resident GX vertex allocation failed for {site:?}"
                )
            }
        }
    }
}

impl std::error::Error for MaterializeError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VertexDiscardReason {
    PositionAttribute { source: Option<MemoryError> },
    NormalAttribute { source: Option<MemoryError> },
    Lighting,
    NonFiniteCarrier { lane: usize },
    IncompletePrimitive,
    NoOutputVertices,
    ExactClip(ExactClipFailure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExactClipFailure {
    SourceGeometry,
    BpState,
    ClipDisable,
    Viewport,
    ProjectionState,
    Position,
    PositionMatrixIndex,
    PositionMatrix,
    ViewNonFinite,
    ClipNonFinite,
    CarrierNonFinite,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NormalCacheSnapshot {
    pub normal: [f32; 3],
    pub tangent: [f32; 3],
    pub binormal: [f32; 3],
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MaterializerStats {
    pub state_records: u64,
    pub draws_seen: u64,
    pub draws_materialized: u64,
    pub draws_discarded: u64,
    pub input_vertices: u64,
    pub output_vertices: u64,
    pub position_index_skips: u64,
    pub normal_cache_commits: u64,
    pub cached_normal_uses: u64,
    pub cached_tangent_uses: u64,
    pub cached_binormal_uses: u64,
    pub projection_fallback_vertices: u64,
    pub exact_required_draws: u64,
    pub post_cull_draws: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct CanonicalVertexData {
    bytes: Vec<u8>,
    vertex_count: u32,
}

impl CanonicalVertexData {
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub const fn vertex_count(&self) -> u32 {
        self.vertex_count
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct ExactClipInputOwned {
    pub bp_gen_mode: u32,
    pub bp_scissor_top_left: u32,
    pub bp_scissor_bottom_right: u32,
    pub bp_scissor_offset: u32,
    pub xf_clip_disable: u32,
    pub viewport_bits: [u32; 6],
    /// Four raw f32 bit patterns per output source vertex.
    pub position_bits: Vec<u32>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum MaterializedEvidence {
    None,
    PostCull(Vec<u8>),
    Exact {
        required: bool,
        input: ExactClipInputOwned,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub struct MaterializedDraw {
    pub topology: u8,
    pub vat_index: u8,
    pub input_vertex_count: u16,
    pub vertices: CanonicalVertexData,
    pub pipeline: PipelineSnapshot,
    pub exact_raster: ExactRasterSnapshot,
    pub tev: TevSnapshot,
    pub textures: [TextureRegisterSnapshot; 8],
    pub texture_use_order: TextureUseOrder,
    pub evidence: MaterializedEvidence,
}

impl MaterializedDraw {
    /// Heap capacity owned by this draw's canonical carrier and evidence payloads. A central
    /// accumulator must add its own draw-vector capacity separately after moving this value.
    pub fn retained_bytes(&self) -> usize {
        let evidence = match &self.evidence {
            MaterializedEvidence::None => 0,
            MaterializedEvidence::PostCull(bytes) => bytes.capacity(),
            MaterializedEvidence::Exact { input, .. } => input
                .position_bits
                .capacity()
                .saturating_mul(core::mem::size_of::<u32>()),
        };
        self.vertices.bytes.capacity().saturating_add(evidence)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MaterializationRecord {
    /// An authenticated BP write whose TMEM/TLUT/cache side effects must be forwarded in order to
    /// the texture materializer before handling the next draw record.
    TextureState { register: u8, value: u32 },
    /// An authenticated BP mask/finish/token write whose side effects remain a separate PE
    /// concern.
    PeState { register: u8, value: u32 },
    /// Exact ordered segment boundary retained after the decoder lease is released.
    Terminal(TerminalSnapshot),
    Ready {
        source_draw_index: u32,
        materialized_draw_index: u32,
    },
    Discarded {
        source_draw_index: u32,
        reason: VertexDiscardReason,
    },
}

/// One materialization lease. Keeping this value live prevents the same materializer from
/// producing another guest-amplified output batch outside its aggregate retained-byte ceiling.
#[derive(Debug, PartialEq, Eq)]
pub struct MaterializedBatch<'materializer> {
    records: Vec<MaterializationRecord>,
    draws: Vec<MaterializedDraw>,
    retained_bytes: usize,
    materializer_lease: PhantomData<&'materializer mut ResidentVertexMaterializer>,
}

impl MaterializedBatch<'_> {
    pub fn records(&self) -> &[MaterializationRecord] {
        &self.records
    }

    pub fn draws(&self) -> &[MaterializedDraw] {
        &self.draws
    }

    pub fn draw(&self, index: u32) -> Option<&MaterializedDraw> {
        self.draws.get(index as usize)
    }

    pub const fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }

    /// Transfers the batch out of the materializer lease so draws can remain pending across
    /// later decoder batches. Before reusing the materializer, the caller must charge
    /// `retained_bytes()` against one global pending-packet ceiling; this module can only enforce
    /// the aggregate ceiling while it owns the active batch.
    pub fn into_owned(self) -> OwnedMaterializedBatch {
        OwnedMaterializedBatch {
            records: self.records,
            draws: self.draws,
            retained_bytes: self.retained_bytes,
        }
    }
}

/// Ownership-transferred materialization output for a GX segment that has not reached its later
/// terminal yet. This type is intentionally not `Clone`: its byte charge must move with its
/// guest-amplified allocations until the packet accumulator consumes or drops them.
#[derive(Debug, PartialEq, Eq)]
pub struct OwnedMaterializedBatch {
    records: Vec<MaterializationRecord>,
    draws: Vec<MaterializedDraw>,
    retained_bytes: usize,
}

impl OwnedMaterializedBatch {
    pub fn records(&self) -> &[MaterializationRecord] {
        &self.records
    }

    pub fn draws(&self) -> &[MaterializedDraw] {
        &self.draws
    }

    pub fn draw(&self, index: u32) -> Option<&MaterializedDraw> {
        self.draws.get(index as usize)
    }

    pub const fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }

    /// Moves the exact allocations into a central accumulator. The returned byte charge covers
    /// both vector capacities and every canonical/evidence payload currently owned by the parts.
    pub fn into_parts(self) -> (Vec<MaterializationRecord>, Vec<MaterializedDraw>, usize) {
        (self.records, self.draws, self.retained_bytes)
    }
}

#[derive(Debug)]
pub struct ResidentVertexMaterializer {
    limits: MaterializerLimits,
    cp: [u32; CP_REGISTER_COUNT],
    bp: [u32; BP_REGISTER_COUNT],
    xf: Vec<u32>,
    normal_cache: NormalCacheSnapshot,
    stats: MaterializerStats,
}

impl ResidentVertexMaterializer {
    pub fn try_new(limits: MaterializerLimits) -> Result<Self, MaterializeError> {
        let limits = limits.validate()?;
        let mut xf = Vec::new();
        xf.try_reserve_exact(XF_REGISTER_COUNT)
            .map_err(|_| MaterializeError::Allocation {
                site: MaterializeAllocationSite::RegisterFile,
            })?;
        xf.resize(XF_REGISTER_COUNT, 0);
        let mut bp = [0; BP_REGISTER_COUNT];
        bp[0xf3] = 0x003f_0000;
        bp[0xfe] = 0x00ff_ffff;
        Ok(Self {
            limits,
            cp: [0; CP_REGISTER_COUNT],
            bp,
            xf,
            normal_cache: NormalCacheSnapshot::default(),
            stats: MaterializerStats::default(),
        })
    }

    pub fn limits(&self) -> MaterializerLimits {
        self.limits
    }

    pub fn normal_cache(&self) -> NormalCacheSnapshot {
        self.normal_cache
    }

    pub fn stats(&self) -> MaterializerStats {
        self.stats
    }

    pub fn cp_registers(&self) -> &[u32; CP_REGISTER_COUNT] {
        &self.cp
    }

    pub fn bp_registers(&self) -> &[u32; BP_REGISTER_COUNT] {
        &self.bp
    }

    pub fn xf_registers(&self) -> &[u32] {
        &self.xf
    }

    /// Replays one FIFO decode batch in architectural order and materializes each draw at the
    /// exact state boundary at which its record appeared.
    pub fn materialize_batch<M: GxMemory>(
        &mut self,
        batch: &DecodeBatch<'_>,
        memory: &mut M,
    ) -> Result<MaterializedBatch<'_>, MaterializeError> {
        let draw_count = batch
            .records()
            .iter()
            .filter(|record| matches!(record, SemanticRecord::Draw { .. }))
            .count();
        if draw_count > self.limits.maximum_draws_per_batch {
            return Err(MaterializeError::DrawLimit {
                requested: draw_count,
                maximum: self.limits.maximum_draws_per_batch,
            });
        }
        let record_count = batch
            .records()
            .iter()
            .filter(|record| {
                matches!(
                    record,
                    SemanticRecord::Draw { .. }
                        | SemanticRecord::Terminal(_)
                        | SemanticRecord::BpLoad {
                            register: 0x45 | 0x47 | 0x48 | 0xfe,
                            ..
                        }
                        | SemanticRecord::BpLoad {
                            register: 0x60..=0x66,
                            ..
                        }
                )
            })
            .count();
        if record_count > self.limits.maximum_records_per_batch {
            return Err(MaterializeError::RecordLimit {
                requested: record_count,
                maximum: self.limits.maximum_records_per_batch,
            });
        }

        let requested_fixed_bytes = record_count
            .checked_mul(core::mem::size_of::<MaterializationRecord>())
            .and_then(|record_bytes| {
                draw_count
                    .checked_mul(core::mem::size_of::<MaterializedDraw>())
                    .and_then(|draw_bytes| record_bytes.checked_add(draw_bytes))
            })
            .ok_or(MaterializeError::ResidentBytes {
                requested: usize::MAX,
                maximum: self.limits.maximum_resident_bytes,
            })?;
        self.preflight_resident(requested_fixed_bytes)?;

        let mut records = Vec::new();
        records
            .try_reserve_exact(record_count)
            .map_err(|_| MaterializeError::Allocation {
                site: MaterializeAllocationSite::BatchRecords,
            })?;
        let mut draws = Vec::new();
        draws
            .try_reserve_exact(draw_count)
            .map_err(|_| MaterializeError::Allocation {
                site: MaterializeAllocationSite::BatchDraws,
            })?;
        let fixed_bytes = records
            .capacity()
            .checked_mul(core::mem::size_of::<MaterializationRecord>())
            .and_then(|record_bytes| {
                draws
                    .capacity()
                    .checked_mul(core::mem::size_of::<MaterializedDraw>())
                    .and_then(|draw_bytes| record_bytes.checked_add(draw_bytes))
            })
            .ok_or(MaterializeError::ResidentBytes {
                requested: usize::MAX,
                maximum: self.limits.maximum_resident_bytes,
            })?;
        self.preflight_resident(fixed_bytes)?;
        let mut retained_bytes = fixed_bytes;

        for record in batch.records() {
            match record {
                SemanticRecord::CpLoad { register, value } => {
                    self.cp[usize::from(*register)] = *value;
                    self.stats.state_records = self.stats.state_records.saturating_add(1);
                }
                SemanticRecord::XfLoad {
                    start,
                    count,
                    values,
                }
                | SemanticRecord::IndexedXfLoad {
                    start,
                    count,
                    values,
                    ..
                } => {
                    self.apply_xf(*start, *count, values)?;
                    self.stats.state_records = self.stats.state_records.saturating_add(1);
                }
                SemanticRecord::BpLoad { register, value } => {
                    self.bp[usize::from(*register)] = *value;
                    if *register != 0xfe {
                        self.bp[0xfe] = 0x00ff_ffff;
                    }
                    self.stats.state_records = self.stats.state_records.saturating_add(1);
                    if matches!(*register, 0x60..=0x66) {
                        records.push(MaterializationRecord::TextureState {
                            register: *register,
                            value: *value,
                        });
                    } else if matches!(*register, 0x45 | 0x47 | 0x48 | 0xfe) {
                        records.push(MaterializationRecord::PeState {
                            register: *register,
                            value: *value,
                        });
                    }
                }
                SemanticRecord::Draw { draw_index } => {
                    let draw = batch
                        .draw(*draw_index)
                        .ok_or(MaterializeError::DrawIndex(*draw_index))?;
                    self.stats.draws_seen = self.stats.draws_seen.saturating_add(1);
                    self.stats.input_vertices = self
                        .stats
                        .input_vertices
                        .saturating_add(u64::from(draw.vertex_count));
                    match self.materialize_draw(draw, memory, retained_bytes)? {
                        Ok(materialized) => {
                            let materialized_draw_index =
                                u32::try_from(draws.len()).map_err(|_| {
                                    MaterializeError::DrawLimit {
                                        requested: draws.len(),
                                        maximum: self.limits.maximum_draws_per_batch,
                                    }
                                })?;
                            retained_bytes = retained_bytes
                                .checked_add(materialized.retained_bytes())
                                .ok_or(MaterializeError::ResidentBytes {
                                    requested: usize::MAX,
                                    maximum: self.limits.maximum_resident_bytes,
                                })?;
                            self.preflight_resident(retained_bytes)?;
                            self.stats.draws_materialized =
                                self.stats.draws_materialized.saturating_add(1);
                            self.stats.output_vertices = self
                                .stats
                                .output_vertices
                                .saturating_add(u64::from(materialized.vertices.vertex_count));
                            draws.push(materialized);
                            records.push(MaterializationRecord::Ready {
                                source_draw_index: *draw_index,
                                materialized_draw_index,
                            });
                        }
                        Err(reason) => {
                            self.stats.draws_discarded =
                                self.stats.draws_discarded.saturating_add(1);
                            records.push(MaterializationRecord::Discarded {
                                source_draw_index: *draw_index,
                                reason,
                            });
                        }
                    }
                }
                SemanticRecord::Terminal(terminal) => {
                    records.push(MaterializationRecord::Terminal(*terminal));
                }
                SemanticRecord::DisplayListCall { .. }
                | SemanticRecord::InvalidateVertexCache
                | SemanticRecord::UnsupportedOpcode { .. } => {}
            }
        }

        Ok(MaterializedBatch {
            records,
            draws,
            retained_bytes,
            materializer_lease: PhantomData,
        })
    }

    fn apply_xf(
        &mut self,
        start: u16,
        count: u8,
        values: &[u32; 16],
    ) -> Result<(), MaterializeError> {
        let count_usize = usize::from(count);
        let start_usize = usize::from(start);
        let end = start_usize
            .checked_add(count_usize)
            .ok_or(MaterializeError::XfRange { start, count })?;
        let Some(destination) = self.xf.get_mut(start_usize..end) else {
            return Err(MaterializeError::XfRange { start, count });
        };
        destination.copy_from_slice(&values[..count_usize]);
        Ok(())
    }

    fn preflight_resident(&self, requested: usize) -> Result<(), MaterializeError> {
        if requested > self.limits.maximum_resident_bytes {
            return Err(MaterializeError::ResidentBytes {
                requested,
                maximum: self.limits.maximum_resident_bytes,
            });
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
struct LightSnapshot {
    color: [u8; 4],
    cos_attenuation: [f32; 3],
    distance_attenuation: [f32; 3],
    position: [f32; 3],
    direction: [f32; 3],
}

#[derive(Clone, Copy, Debug)]
enum CacheSlot<T> {
    Empty,
    Missing,
    Value(T),
}

struct TransformContext<'state> {
    xf: &'state [u32],
    bp: &'state [u32; BP_REGISTER_COUNT],
    projection: [f32; 6],
    projection_type: u32,
    viewport: [f32; 6],
    position_matrices: [CacheSlot<[f32; 12]>; 64],
    normal_matrices: [CacheSlot<[f32; 9]>; 32],
    texgen_rows: [CacheSlot<[f32; 4]>; 66],
    texgen_post_rows: [CacheSlot<[f32; 4]>; 64],
    lights: [CacheSlot<LightSnapshot>; 8],
    emboss_light_positions: [Option<[f32; 3]>; 8],
}

impl<'state> TransformContext<'state> {
    fn new(xf: &'state [u32], bp: &'state [u32; BP_REGISTER_COUNT]) -> Self {
        Self {
            xf,
            bp,
            projection: core::array::from_fn(|index| xf_float(xf, 0x1020 + index)),
            projection_type: xf[0x1026],
            viewport: core::array::from_fn(|index| xf_float(xf, 0x101a + index)),
            position_matrices: [CacheSlot::Empty; 64],
            normal_matrices: [CacheSlot::Empty; 32],
            texgen_rows: [CacheSlot::Empty; 66],
            texgen_post_rows: [CacheSlot::Empty; 64],
            lights: [CacheSlot::Empty; 8],
            emboss_light_positions: [None; 8],
        }
    }

    fn position_matrix(&mut self, index: u8) -> Option<[f32; 12]> {
        let index = usize::from(index);
        if index >= self.position_matrices.len() || (index + 2) * 4 + 3 >= 0x100 {
            return None;
        }
        match self.position_matrices[index] {
            CacheSlot::Value(value) => return Some(value),
            CacheSlot::Missing => return None,
            CacheSlot::Empty => {}
        }
        let base = index * 4;
        let matrix = core::array::from_fn(|component| xf_float(self.xf, base + component));
        if matrix.iter().all(|value| value.is_finite()) {
            self.position_matrices[index] = CacheSlot::Value(matrix);
            Some(matrix)
        } else {
            self.position_matrices[index] = CacheSlot::Missing;
            None
        }
    }

    fn normal_matrix(&mut self, index: u8) -> Option<[f32; 9]> {
        let index = usize::from(index) % 32;
        match self.normal_matrices[index] {
            CacheSlot::Value(value) => return Some(value),
            CacheSlot::Missing => return None,
            CacheSlot::Empty => {}
        }
        let base = 0x400 + index * 3;
        let matrix = core::array::from_fn(|component| xf_float(self.xf, base + component));
        if matrix.iter().all(|value| value.is_finite()) {
            self.normal_matrices[index] = CacheSlot::Value(matrix);
            Some(matrix)
        } else {
            self.normal_matrices[index] = CacheSlot::Missing;
            None
        }
    }

    fn texgen_row(&mut self, row: u8, post: bool) -> Option<[f32; 4]> {
        let row = usize::from(row);
        let (base, rows): (usize, &mut [CacheSlot<[f32; 4]>]) = if post {
            (0x500, &mut self.texgen_post_rows)
        } else {
            (0, &mut self.texgen_rows)
        };
        let slot = rows.get_mut(row)?;
        match *slot {
            CacheSlot::Value(value) => return Some(value),
            CacheSlot::Missing => return None,
            CacheSlot::Empty => {}
        }
        let address = base.checked_add(row.checked_mul(4)?)?;
        let end = address.checked_add(4)?;
        let words = self.xf.get(address..end)?;
        let result = core::array::from_fn(|index| f32::from_bits(words[index]));
        *slot = CacheSlot::Value(result);
        Some(result)
    }

    fn light(&mut self, index: u8) -> Option<LightSnapshot> {
        let index = usize::from(index);
        match *self.lights.get(index)? {
            CacheSlot::Value(value) => return Some(value),
            CacheSlot::Missing => return None,
            CacheSlot::Empty => {}
        }
        let base = 0x603 + index * 0x10;
        let color = xf_color(self.xf, base)?;
        let snapshot = LightSnapshot {
            color,
            cos_attenuation: core::array::from_fn(|component| {
                xf_float(self.xf, base + 1 + component)
            }),
            distance_attenuation: core::array::from_fn(|component| {
                xf_float(self.xf, base + 4 + component)
            }),
            position: core::array::from_fn(|component| xf_float(self.xf, base + 7 + component)),
            direction: core::array::from_fn(|component| xf_float(self.xf, base + 10 + component)),
        };
        let valid = snapshot
            .cos_attenuation
            .iter()
            .chain(snapshot.distance_attenuation.iter())
            .chain(snapshot.position.iter())
            .chain(snapshot.direction.iter())
            .all(|value| value.is_finite());
        if valid {
            self.lights[index] = CacheSlot::Value(snapshot);
            Some(snapshot)
        } else {
            self.lights[index] = CacheSlot::Missing;
            None
        }
    }

    fn emboss_light_position(&mut self, index: u8) -> Option<[f32; 3]> {
        let index = usize::from(index);
        if index >= 8 {
            return None;
        }
        if let Some(cached) = self.emboss_light_positions[index] {
            return Some(cached);
        }
        let base = 0x603 + index * 0x10 + 7;
        let end = base.checked_add(3)?;
        self.xf.get(base..end)?;
        let position = core::array::from_fn(|component| xf_float(self.xf, base + component));
        self.emboss_light_positions[index] = Some(position);
        Some(position)
    }

    fn texgen_count(&self) -> usize {
        (self.xf[0x103f] as usize & 0xf).min(8)
    }

    fn texgen_info(&self, index: usize) -> u32 {
        self.xf[0x1040 + index]
    }

    fn texgen_post_info(&self, index: usize) -> u32 {
        self.xf[0x1050 + index]
    }

    fn dual_tex_transform(&self) -> bool {
        self.xf[0x1012] & 1 != 0
    }

    fn texgen_scale(&self, index: usize) -> [u32; 2] {
        [
            (self.bp[0x30 + index * 2] & 0xffff) + 1,
            (self.bp[0x31 + index * 2] & 0xffff) + 1,
        ]
    }
}

fn xf_float(xf: &[u32], address: usize) -> f32 {
    xf.get(address).copied().map_or(f32::NAN, f32::from_bits)
}

fn xf_color(xf: &[u32], address: usize) -> Option<[u8; 4]> {
    let value = *xf.get(address)?;
    Some([
        (value >> 24) as u8,
        (value >> 16) as u8,
        (value >> 8) as u8,
        value as u8,
    ])
}

#[derive(Clone, Copy, Debug)]
struct AttributeRequest {
    cursor: usize,
    status: u8,
    array_index: usize,
    direct_bytes: usize,
    vertex: u16,
}

fn resolve_attribute<M: GxMemory>(
    source: &[u8],
    request: AttributeRequest,
    cp: &[u32; CP_REGISTER_COUNT],
    memory: &mut M,
) -> Result<AttributeData, MaterializeError> {
    let AttributeRequest {
        cursor,
        status,
        array_index,
        direct_bytes,
        vertex,
    } = request;
    if status == 0 {
        return Ok(AttributeData::absent(cursor));
    }
    if direct_bytes > ATTRIBUTE_SCRATCH_BYTES {
        return Err(MaterializeError::VertexByteOverflow);
    }
    let mut data = AttributeData::absent(cursor);
    if status == 1 {
        let end = cursor
            .checked_add(direct_bytes)
            .ok_or(MaterializeError::VertexByteOverflow)?;
        let bytes = source
            .get(cursor..end)
            .ok_or(MaterializeError::TruncatedVertex {
                vertex,
                cursor,
                required: direct_bytes,
                available: source.len().saturating_sub(cursor),
            })?;
        data.bytes[..direct_bytes].copy_from_slice(bytes);
        data.len = direct_bytes;
        data.cursor = end;
        data.availability = AttributeAvailability::Present;
        return Ok(data);
    }

    let index_bytes = if status == 2 { 1 } else { 2 };
    let end = cursor
        .checked_add(index_bytes)
        .ok_or(MaterializeError::VertexByteOverflow)?;
    let encoded_index = source
        .get(cursor..end)
        .ok_or(MaterializeError::TruncatedVertex {
            vertex,
            cursor,
            required: index_bytes,
            available: source.len().saturating_sub(cursor),
        })?;
    let index = if index_bytes == 1 {
        u32::from(encoded_index[0])
    } else {
        u32::from(
            read_be_u16(encoded_index).ok_or(MaterializeError::TruncatedVertex {
                vertex,
                cursor,
                required: 2,
                available: encoded_index.len(),
            })?,
        )
    };
    data.cursor = end;
    if index == if index_bytes == 1 { 0xff } else { 0xffff } {
        data.availability = AttributeAvailability::Sentinel;
        return Ok(data);
    }
    let base = cp[0xa0 + array_index];
    let stride = cp[0xb0 + array_index] & 0xff;
    let address = base.wrapping_add(index.wrapping_mul(stride));
    data.len = direct_bytes;
    match memory.read_exact(address, &mut data.bytes[..direct_bytes]) {
        Ok(()) => data.availability = AttributeAvailability::Present,
        Err(error) => {
            data.len = 0;
            data.availability = AttributeAvailability::Invalid(error);
        }
    }
    Ok(data)
}

fn decode_normal_attribute<M: GxMemory>(
    source: &[u8],
    cursor: usize,
    plan: NormalAttributePlan,
    cp: &[u32; CP_REGISTER_COUNT],
    memory: &mut M,
    vertex: u16,
) -> Result<NormalAttribute, MaterializeError> {
    if plan.status == 0 {
        return Ok(NormalAttribute::empty(cursor));
    }
    let component_bytes = component_bytes(plan.format);
    let vector_count = if plan.elements == 0 { 1 } else { 3 };
    let vector_bytes = 3 * component_bytes;
    let scale = [
        2.0_f32.powi(-7),
        2.0_f32.powi(-6),
        2.0_f32.powi(-15),
        2.0_f32.powi(-14),
        1.0,
    ]
    .get(usize::from(plan.format))
    .copied()
    .unwrap_or(1.0);
    let read_format = plan.format.min(4);
    let mut vectors = [None; 3];
    let next;
    let mut memory_error = None;
    if plan.status == 1 {
        let byte_count = vector_count * vector_bytes;
        let end = cursor
            .checked_add(byte_count)
            .ok_or(MaterializeError::VertexByteOverflow)?;
        let bytes = source
            .get(cursor..end)
            .ok_or(MaterializeError::TruncatedVertex {
                vertex,
                cursor,
                required: byte_count,
                available: source.len().saturating_sub(cursor),
            })?;
        for (index, vector) in vectors.iter_mut().enumerate().take(vector_count) {
            *vector = decode_numeric_vector(
                &bytes[index * vector_bytes..(index + 1) * vector_bytes],
                3,
                component_bytes,
                read_format,
                scale,
            );
        }
        next = end;
    } else {
        let index_bytes = if plan.status == 2 { 1 } else { 2 };
        let index_count = if vector_count == 3 && plan.separate_indices {
            3
        } else {
            1
        };
        let encoded_bytes = index_count * index_bytes;
        let end = cursor
            .checked_add(encoded_bytes)
            .ok_or(MaterializeError::VertexByteOverflow)?;
        let encoded = source
            .get(cursor..end)
            .ok_or(MaterializeError::TruncatedVertex {
                vertex,
                cursor,
                required: encoded_bytes,
                available: source.len().saturating_sub(cursor),
            })?;
        let mut indexes = [0_u32; 3];
        for (index, target) in indexes.iter_mut().enumerate().take(index_count) {
            let offset = index * index_bytes;
            *target = if index_bytes == 1 {
                u32::from(encoded[offset])
            } else {
                u32::from(read_be_u16(&encoded[offset..offset + 2]).ok_or(
                    MaterializeError::TruncatedVertex {
                        vertex,
                        cursor: cursor + offset,
                        required: 2,
                        available: encoded.len().saturating_sub(offset),
                    },
                )?)
            };
        }
        next = end;
        let base = cp[0xa1];
        let stride = cp[0xb1] & 0xff;
        if index_count == 3 {
            for vector in 0..3 {
                let address = base
                    .wrapping_add(indexes[vector].wrapping_mul(stride))
                    .wrapping_add((vector * vector_bytes) as u32);
                let mut bytes = [0_u8; ATTRIBUTE_SCRATCH_BYTES];
                match memory.read_exact(address, &mut bytes[..vector_bytes]) {
                    Ok(()) => {
                        vectors[vector] = decode_numeric_vector(
                            &bytes[..vector_bytes],
                            3,
                            component_bytes,
                            read_format,
                            scale,
                        );
                    }
                    Err(error) => {
                        memory_error.get_or_insert(error);
                    }
                };
            }
        } else {
            let byte_count = vector_count * vector_bytes;
            let address = base.wrapping_add(indexes[0].wrapping_mul(stride));
            let mut bytes = [0_u8; ATTRIBUTE_SCRATCH_BYTES];
            match memory.read_exact(address, &mut bytes[..byte_count]) {
                Ok(()) => {
                    for (index, vector) in vectors.iter_mut().enumerate().take(vector_count) {
                        *vector = decode_numeric_vector(
                            &bytes[index * vector_bytes..(index + 1) * vector_bytes],
                            3,
                            component_bytes,
                            read_format,
                            scale,
                        );
                    }
                }
                Err(error) => memory_error = Some(error),
            }
        }
    }
    let skipped = vectors.iter().take(vector_count).any(Option::is_none);
    if skipped {
        return Ok(NormalAttribute {
            cursor: next,
            skipped: true,
            memory_error,
            ..NormalAttribute::empty(next)
        });
    }
    Ok(NormalAttribute {
        normal: vectors[0],
        tangent: vectors[1],
        binormal: vectors[2],
        cursor: next,
        skipped: false,
        memory_error: None,
    })
}

fn decode_numeric_vector(
    bytes: &[u8],
    components: usize,
    component_bytes: usize,
    format: u8,
    scale: f32,
) -> Option<[f32; 3]> {
    let mut result = [0.0; 3];
    for (component, target) in result.iter_mut().enumerate().take(components) {
        let offset = component.checked_mul(component_bytes)?;
        *target = read_component(bytes, offset, format)? * scale;
    }
    result
        .iter()
        .all(|value| value.is_finite())
        .then_some(result)
}

fn read_component(source: &[u8], offset: usize, format: u8) -> Option<f32> {
    match format {
        0 => Some(f32::from(*source.get(offset)?)),
        1 => Some(f32::from(i8::from_be_bytes([*source.get(offset)?]))),
        2 => Some(f32::from(read_be_u16(source.get(offset..)?)?)),
        3 => Some(f32::from(i16::from_be_bytes([
            *source.get(offset)?,
            *source.get(offset + 1)?,
        ]))),
        4 => Some(f32::from_bits(read_be_u32(source.get(offset..)?)?)),
        _ => Some(f32::NAN),
    }
}

fn read_be_u16(source: &[u8]) -> Option<u16> {
    Some(u16::from_be_bytes([*source.first()?, *source.get(1)?]))
}

fn read_be_u32(source: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes([
        *source.first()?,
        *source.get(1)?,
        *source.get(2)?,
        *source.get(3)?,
    ]))
}

fn decode_color(source: &[u8], format: u8) -> [u8; 4] {
    let expand4 = |value: u16| ((value << 4) | value) as u8;
    let expand5 = |value: u16| ((value << 3) | (value >> 2)) as u8;
    let expand6 = |value: u16| ((value << 2) | (value >> 4)) as u8;
    match format {
        0 => read_be_u16(source).map_or([0xff; 4], |value| {
            [
                expand5(value >> 11),
                expand6((value >> 5) & 0x3f),
                expand5(value & 0x1f),
                0xff,
            ]
        }),
        1 | 2 => match (source.first(), source.get(1), source.get(2)) {
            (Some(red), Some(green), Some(blue)) => [*red, *green, *blue, 0xff],
            _ => [0xff; 4],
        },
        3 => read_be_u16(source).map_or([0xff; 4], |value| {
            [
                expand4(value >> 12),
                expand4((value >> 8) & 0xf),
                expand4((value >> 4) & 0xf),
                expand4(value & 0xf),
            ]
        }),
        4 => match (source.first(), source.get(1), source.get(2)) {
            (Some(first), Some(second), Some(third)) => {
                let value =
                    (u32::from(*first) << 16) | (u32::from(*second) << 8) | u32::from(*third);
                [
                    expand6((value >> 18) as u16),
                    expand6(((value >> 12) & 0x3f) as u16),
                    expand6(((value >> 6) & 0x3f) as u16),
                    expand6((value & 0x3f) as u16),
                ]
            }
            _ => [0xff; 4],
        },
        5 => match (source.first(), source.get(1), source.get(2), source.get(3)) {
            (Some(red), Some(green), Some(blue), Some(alpha)) => [*red, *green, *blue, *alpha],
            _ => [0xff; 4],
        },
        _ => [0xff; 4],
    }
}

#[derive(Clone, Copy, Debug)]
struct TexgenAttributes {
    position: [f32; 3],
    view_position: Option<[f32; 3]>,
    normal: Option<[f32; 3]>,
    tangent: Option<[f32; 3]>,
    binormal: Option<[f32; 3]>,
    emboss_tangent: [f32; 3],
    emboss_binormal: [f32; 3],
    colors: [[f32; 4]; 2],
    raw_texture_coords: [Option<RawTexCoord>; 8],
}

#[allow(clippy::too_many_arguments)]
fn decode_vertex<M: GxMemory>(
    source: &[u8],
    vertex: u16,
    plan: &VertexDecodePlan,
    cp: &[u32; CP_REGISTER_COUNT],
    memory: &mut M,
    transform: &mut TransformContext<'_>,
    normal_cache: &mut NormalCacheSnapshot,
    commit_normal_cache: bool,
    delta: &mut DrawStatsDelta,
) -> Result<VertexResult, MaterializeError> {
    let mut cursor = 0usize;
    let mut position_matrix = plan.position_matrix;
    let mut texture_matrices = plan.texture_matrices;
    for matrix in 0..9 {
        if plan.descriptor_low & (1 << matrix) == 0 {
            continue;
        }
        let Some(value) = source.get(cursor) else {
            return Err(MaterializeError::TruncatedVertex {
                vertex,
                cursor,
                required: 1,
                available: source.len().saturating_sub(cursor),
            });
        };
        if matrix == 0 {
            position_matrix = *value & 0x3f;
        } else {
            texture_matrices[matrix - 1] = *value & 0x3f;
        }
        cursor += 1;
    }

    let position_data = resolve_attribute(
        source,
        AttributeRequest {
            cursor,
            status: plan.position.status,
            array_index: 0,
            direct_bytes: plan.position.direct_bytes,
            vertex,
        },
        cp,
        memory,
    )?;
    cursor = position_data.cursor;
    let position_index_skipped = position_data.availability == AttributeAvailability::Sentinel;
    let mut position = [0.0_f32; 3];
    match position_data.availability {
        AttributeAvailability::Present => {
            for (component, target) in position
                .iter_mut()
                .enumerate()
                .take(usize::from(plan.position.elements))
            {
                *target = read_component(
                    position_data.as_slice(),
                    component * plan.position.component_bytes,
                    plan.position.format,
                )
                .unwrap_or(f32::NAN)
                    * plan.position.scale;
            }
        }
        AttributeAvailability::Sentinel => {}
        AttributeAvailability::Invalid(error) => {
            return Ok(VertexResult::Dropped(
                VertexDiscardReason::PositionAttribute {
                    source: Some(error),
                },
            ));
        }
        AttributeAvailability::Absent => {
            return Ok(VertexResult::Dropped(
                VertexDiscardReason::PositionAttribute { source: None },
            ));
        }
    }

    let normal_attribute =
        decode_normal_attribute(source, cursor, plan.normal, cp, memory, vertex)?;
    cursor = normal_attribute.cursor;
    if normal_attribute.skipped && !position_index_skipped {
        return Ok(VertexResult::Dropped(
            VertexDiscardReason::NormalAttribute {
                source: normal_attribute.memory_error,
            },
        ));
    }
    if !normal_attribute.skipped {
        if normal_attribute.normal.is_none() {
            delta.cached_normal_uses = delta.cached_normal_uses.saturating_add(1);
        }
        if normal_attribute.tangent.is_none() {
            delta.cached_tangent_uses = delta.cached_tangent_uses.saturating_add(1);
        }
        if normal_attribute.binormal.is_none() {
            delta.cached_binormal_uses = delta.cached_binormal_uses.saturating_add(1);
        }
        if commit_normal_cache {
            let mut committed = false;
            if let Some(normal) = normal_attribute.normal {
                normal_cache.normal = normal;
                committed = true;
            }
            if let Some(tangent) = normal_attribute.tangent {
                normal_cache.tangent = tangent;
                committed = true;
            }
            if let Some(binormal) = normal_attribute.binormal {
                normal_cache.binormal = binormal;
                committed = true;
            }
            if committed {
                delta.normal_cache_commits = delta.normal_cache_commits.saturating_add(1);
            }
        }
    }
    let resolved_normal = normal_attribute.normal.unwrap_or(normal_cache.normal);

    let mut colors = [[0xff_u8; 4]; 2];
    for (color_index, color) in colors.iter_mut().enumerate() {
        let color_plan = plan.colors[color_index];
        let data = resolve_attribute(
            source,
            AttributeRequest {
                cursor,
                status: color_plan.status,
                array_index: 2 + color_index,
                direct_bytes: color_plan.direct_bytes,
                vertex,
            },
            cp,
            memory,
        )?;
        cursor = data.cursor;
        if data.availability == AttributeAvailability::Present {
            *color = decode_color(data.as_slice(), color_plan.format);
        }
    }

    let mut raw_texture_coords = [None; 8];
    for (texture, target) in raw_texture_coords.iter_mut().enumerate() {
        let texture_plan = plan.textures[texture];
        let data = resolve_attribute(
            source,
            AttributeRequest {
                cursor,
                status: texture_plan.status,
                array_index: 4 + texture,
                direct_bytes: texture_plan.direct_bytes,
                vertex,
            },
            cp,
            memory,
        )?;
        cursor = data.cursor;
        if data.availability != AttributeAvailability::Present {
            continue;
        }
        let mut values = [0.0_f32; 3];
        for (component, value) in values
            .iter_mut()
            .enumerate()
            .take(usize::from(texture_plan.elements))
        {
            *value = read_component(
                data.as_slice(),
                component * texture_plan.component_bytes,
                texture_plan.format,
            )
            .unwrap_or(f32::NAN)
                * texture_plan.scale;
        }
        *target = Some(RawTexCoord { values });
    }
    if cursor != source.len() {
        return Err(MaterializeError::EncodedLength {
            expected: source.len(),
            received: cursor,
        });
    }
    if position_index_skipped {
        return Ok(VertexResult::PositionSentinel);
    }

    let view_position = transform_position(position, position_matrix, transform);
    let projected = project_view_position(view_position, transform);
    let transformed_normal = transform_normal(resolved_normal, position_matrix, transform);
    let Some(raster_colors) =
        light_raster_channels(view_position, transformed_normal, colors, transform)
    else {
        return Ok(VertexResult::Dropped(VertexDiscardReason::Lighting));
    };
    let texgen_attributes = TexgenAttributes {
        position,
        view_position,
        normal: normal_attribute.normal,
        tangent: normal_attribute.tangent,
        binormal: normal_attribute.binormal,
        emboss_tangent: normal_attribute.tangent.unwrap_or(normal_cache.tangent),
        emboss_binormal: normal_attribute.binormal.unwrap_or(normal_cache.binormal),
        colors: raster_colors,
        raw_texture_coords,
    };
    let tex_coords = transform_tex_coords(
        &texgen_attributes,
        texture_matrices,
        position_matrix,
        transform,
    );
    Ok(VertexResult::Output(DecodedVertex {
        projected,
        position,
        position_matrix,
        raster_colors,
        tex_coords,
    }))
}

fn transform_position(
    position: [f32; 3],
    matrix_index: u8,
    context: &mut TransformContext<'_>,
) -> Option<[f32; 3]> {
    let matrix = context.position_matrix(matrix_index)?;
    let [x, y, z] = position.map(f32_round);
    let mut result = [0.0; 3];
    for (row, target) in result.iter_mut().enumerate() {
        let offset = row * 4;
        let mut value = f32_mul(matrix[offset], x);
        value = f32_add(value, f32_mul(matrix[offset + 1], y));
        value = f32_add(value, f32_mul(matrix[offset + 2], z));
        *target = f32_add(value, matrix[offset + 3]);
    }
    Some(result)
}

fn transform_normal_vector(
    vector: [f32; 3],
    matrix_index: u8,
    context: &mut TransformContext<'_>,
) -> Option<[f32; 3]> {
    let matrix = context.normal_matrix(matrix_index)?;
    let [x, y, z] = vector.map(f32_round);
    let mut result = [0.0; 3];
    for (row, target) in result.iter_mut().enumerate() {
        let offset = row * 3;
        let mut value = f32_mul(matrix[offset], x);
        value = f32_add(value, f32_mul(matrix[offset + 1], y));
        *target = f32_add(value, f32_mul(matrix[offset + 2], z));
    }
    Some(result)
}

fn transform_normal(
    vector: [f32; 3],
    matrix_index: u8,
    context: &mut TransformContext<'_>,
) -> Option<[f32; 3]> {
    let transformed = transform_normal_vector(vector, matrix_index, context)?;
    let mut length_squared = f32_mul(transformed[0], transformed[0]);
    length_squared = f32_add(length_squared, f32_mul(transformed[1], transformed[1]));
    length_squared = f32_add(length_squared, f32_mul(transformed[2], transformed[2]));
    let length = f32_round(f64::from(length_squared).sqrt() as f32);
    Some(transformed.map(|value| f32_div(value, length)))
}

fn project_view_position(
    view_position: Option<[f32; 3]>,
    context: &TransformContext<'_>,
) -> Option<[f32; 4]> {
    let [view_x, view_y, view_z] = view_position?;
    let projection = context.projection;
    if projection.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let [clip_x, clip_y, clip_z, clip_w] = match context.projection_type {
        0 => [
            f64::from(projection[0]) * f64::from(view_x)
                + f64::from(projection[1]) * f64::from(view_z),
            f64::from(projection[2]) * f64::from(view_y)
                + f64::from(projection[3]) * f64::from(view_z),
            f64::from(projection[4]) * f64::from(view_z) + f64::from(projection[5]),
            -f64::from(view_z),
        ],
        1 => [
            f64::from(projection[0]) * f64::from(view_x) + f64::from(projection[1]),
            f64::from(projection[2]) * f64::from(view_y) + f64::from(projection[3]),
            f64::from(projection[4]) * f64::from(view_z) + f64::from(projection[5]),
            1.0_f64,
        ],
        _ => return None,
    };
    if [clip_x, clip_y, clip_z, clip_w]
        .iter()
        .any(|value| !value.is_finite())
        || clip_w == 0.0
        || context.viewport.iter().any(|value| !value.is_finite())
        || context.viewport[0] == 0.0
        || context.viewport[1] == 0.0
    {
        return None;
    }
    let scissor_offset = context.bp[0x59];
    let scissor_x = f64::from(scissor_offset & 0x3ff) * 2.0;
    let scissor_y = f64::from((scissor_offset >> 10) & 0x3ff) * 2.0;
    let projected = [
        (clip_x / clip_w * f64::from(context.viewport[0]) + f64::from(context.viewport[3])
            - scissor_x) as f32,
        (clip_y / clip_w * f64::from(context.viewport[1]) + f64::from(context.viewport[4])
            - scissor_y) as f32,
        (clip_z / clip_w * f64::from(context.viewport[2]) + f64::from(context.viewport[5])) as f32,
        clip_w as f32,
    ];
    (projected.iter().all(|value| value.is_finite()) && projected[3] != 0.0).then_some(projected)
}

#[inline]
fn f32_round(value: f32) -> f32 {
    f32::from_bits(value.to_bits())
}

#[inline]
fn f32_add(left: f32, right: f32) -> f32 {
    f32_round(left + right)
}

#[inline]
fn f32_sub(left: f32, right: f32) -> f32 {
    f32_round(left - right)
}

#[inline]
fn f32_mul(left: f32, right: f32) -> f32 {
    f32_round(left * right)
}

#[inline]
fn f32_div(left: f32, right: f32) -> f32 {
    f32_round(left / right)
}

fn dot3(left: [f32; 3], right: [f32; 3]) -> f32 {
    f32_add(
        f32_add(f32_mul(left[0], right[0]), f32_mul(left[1], right[1])),
        f32_mul(left[2], right[2]),
    )
}

fn vector_subtract(left: [f32; 3], right: [f32; 3]) -> [f32; 3] {
    core::array::from_fn(|index| f32_sub(left[index], right[index]))
}

fn light_normalize3(vector: [f32; 3]) -> [f32; 3] {
    let length = f32_round(f64::from(dot3(vector, vector)).sqrt() as f32);
    vector.map(|value| f32_div(value, length))
}

fn light_max_zero(value: f32) -> f32 {
    if value > 0.0 { f32_round(value) } else { 0.0 }
}

fn light_safe_divide(numerator: f32, denominator: f32) -> f32 {
    let numerator = f32_round(numerator);
    let denominator = f32_round(denominator);
    if denominator == 0.0 {
        if numerator > 0.0 { 1.0 } else { 0.0 }
    } else {
        f32_div(numerator, denominator)
    }
}

fn light_diffuse(control: u32, direction: [f32; 3], normal: [f32; 3]) -> Option<f32> {
    match (control >> 7) & 3 {
        0 => Some(1.0),
        1 => Some(dot3(direction, normal)),
        2 => Some(light_max_zero(dot3(direction, normal))),
        _ => None,
    }
}

fn light_spot_cos_polynomial(coefficients: [f32; 3], value: f32) -> f32 {
    f32_add(
        f32_add(coefficients[0], f32_mul(coefficients[1], value)),
        f32_mul(f32_mul(coefficients[2], value), value),
    )
}

fn light_spot_distance_polynomial(
    coefficients: [f32; 3],
    distance: f32,
    distance_squared: f32,
) -> f32 {
    f32_add(
        f32_add(coefficients[0], f32_mul(coefficients[1], distance)),
        f32_mul(coefficients[2], distance_squared),
    )
}

fn light_position(
    control: u32,
    light: LightSnapshot,
    position: [f32; 3],
    normal: [f32; 3],
) -> Option<(f32, [f32; 3])> {
    let mut direction = vector_subtract(light.position, position);
    let mut attenuation = 1.0;
    match (control >> 9) & 3 {
        0 | 2 => {
            direction = light_normalize3(direction);
            if direction.iter().all(|value| *value == 0.0) {
                direction = normal;
            }
        }
        1 => {
            direction = light_normalize3(direction);
            let normal_dot_direction = dot3(direction, normal);
            attenuation = if normal_dot_direction >= 0.0 {
                light_max_zero(dot3(light.direction, normal))
            } else {
                0.0
            };
            let attenuation_length = [1.0, attenuation, f32_mul(attenuation, attenuation)];
            let distance_attenuation = if (control >> 7) & 3 == 0 {
                light.distance_attenuation
            } else {
                light_normalize3(light.distance_attenuation)
            };
            attenuation = light_safe_divide(
                light_max_zero(dot3(attenuation_length, light.cos_attenuation)),
                dot3(attenuation_length, distance_attenuation),
            );
        }
        _ => {
            let distance_squared = dot3(direction, direction);
            let distance = f32_round(f64::from(distance_squared).sqrt() as f32);
            direction = direction.map(|value| f32_div(value, distance));
            let angular_value = light_max_zero(dot3(direction, light.direction));
            let numerator = light_max_zero(light_spot_cos_polynomial(
                light.cos_attenuation,
                angular_value,
            ));
            let denominator = light_spot_distance_polynomial(
                light.distance_attenuation,
                distance,
                distance_squared,
            );
            attenuation = light_safe_divide(numerator, denominator);
        }
    }
    attenuation
        .is_finite()
        .then_some((f32_round(attenuation), direction))
}

fn channel_light_enabled(control: u32, light: usize) -> bool {
    if light < 4 {
        control & (1 << (2 + light)) != 0
    } else {
        control & (1 << (11 + light - 4)) != 0
    }
}

#[allow(clippy::too_many_arguments)]
fn light_channel_component(
    control: u32,
    component: usize,
    material: [u8; 4],
    ambient: [u8; 4],
    vertex_color: [u8; 4],
    position: Option<[f32; 3]>,
    normal: Option<[f32; 3]>,
    context: &mut TransformContext<'_>,
) -> Option<u8> {
    let material_value = if control & 1 != 0 {
        vertex_color[component]
    } else {
        material[component]
    };
    if control & 2 == 0 {
        return Some(material_value);
    }
    let mut light_function = f32_round(f32::from(if control & (1 << 6) != 0 {
        vertex_color[component]
    } else {
        ambient[component]
    }));
    for light_index in 0..8 {
        if !channel_light_enabled(control, light_index) {
            continue;
        }
        let position = position?;
        let diffuse_mode = (control >> 7) & 3;
        let attenuation_mode = (control >> 9) & 3;
        let normal_required = diffuse_mode != 0 || attenuation_mode == 1;
        if normal_required && normal.is_none() {
            return None;
        }
        let effective_normal = normal.unwrap_or([f32::NAN; 3]);
        let light = context.light(light_index as u8)?;
        let (attenuation, direction) = light_position(control, light, position, effective_normal)?;
        let diffuse = light_diffuse(control, direction, effective_normal)?;
        let color = f32::from(light.color[component]);
        let contribution = if diffuse_mode == 0 {
            f32_mul(color, attenuation)
        } else if component == 3 {
            f32_mul(f32_mul(color, attenuation), diffuse)
        } else {
            f32_mul(color, f32_mul(attenuation, diffuse))
        };
        light_function = f32_add(light_function, contribution);
    }
    if !light_function.is_finite()
        || light_function < i32::MIN as f32
        || light_function >= f32::from_bits(0x4f00_0000)
    {
        return None;
    }
    let light_integer = (light_function.trunc() as i32).clamp(0, 255) as u16;
    let corrected = light_integer + (light_integer >> 7);
    Some(((u16::from(material_value) * corrected) >> 8) as u8)
}

fn light_raster_channels(
    position: Option<[f32; 3]>,
    normal: Option<[f32; 3]>,
    colors: [[u8; 4]; 2],
    context: &mut TransformContext<'_>,
) -> Option<[[f32; 4]; 2]> {
    let position = position.map(|value| value.map(f32_round));
    let normal = normal.map(|value| value.map(f32_round));
    let mut channels = [[0.0; 4]; 2];
    for channel in 0..2 {
        let material = xf_color(context.xf, 0x100c + channel)?;
        let ambient = xf_color(context.xf, 0x100a + channel)?;
        let color_control = context.xf[0x100e + channel];
        let alpha_control = context.xf[0x1010 + channel];
        for (component, target) in channels[channel].iter_mut().enumerate() {
            let control = if component == 3 {
                alpha_control
            } else {
                color_control
            };
            let value = light_channel_component(
                control,
                component,
                material,
                ambient,
                colors[channel],
                position,
                normal,
                context,
            )?;
            *target = f32_div(f32::from(value), 255.0);
        }
    }
    Some(channels)
}

struct EmbossState {
    tangent: Option<[f32; 3]>,
    binormal: Option<[f32; 3]>,
    view_position: Option<[f32; 3]>,
    light_directions: [CacheSlot<[f32; 3]>; 8],
}

fn prepare_emboss_state(
    attributes: &TexgenAttributes,
    normal_matrix_index: u8,
    context: &mut TransformContext<'_>,
) -> EmbossState {
    let tangent = transform_normal_vector(attributes.emboss_tangent, normal_matrix_index, context);
    let binormal =
        transform_normal_vector(attributes.emboss_binormal, normal_matrix_index, context);
    let view_position = attributes
        .view_position
        .or_else(|| transform_position(attributes.position, normal_matrix_index, context));
    EmbossState {
        tangent,
        binormal,
        view_position,
        light_directions: [CacheSlot::Empty; 8],
    }
}

fn emboss_light_direction(
    state: &mut EmbossState,
    light_index: u8,
    context: &mut TransformContext<'_>,
) -> Option<[f32; 3]> {
    let index = usize::from(light_index);
    match *state.light_directions.get(index)? {
        CacheSlot::Value(value) => return Some(value),
        CacheSlot::Missing => return None,
        CacheSlot::Empty => {}
    }
    let direction = match (
        context.emboss_light_position(light_index),
        state.view_position,
    ) {
        (Some(light), Some(view)) => Some(light_normalize3(vector_subtract(light, view))),
        _ => None,
    };
    if let Some(direction) = direction {
        state.light_directions[index] = CacheSlot::Value(direction);
        Some(direction)
    } else {
        state.light_directions[index] = CacheSlot::Missing;
        None
    }
}

fn transform_tex_coords(
    attributes: &TexgenAttributes,
    matrix_indices: [u8; 8],
    normal_matrix_index: u8,
    context: &mut TransformContext<'_>,
) -> [Option<[f32; 3]>; 8] {
    let count = context.texgen_count();
    let needs_emboss = (0..count).any(|index| ((context.texgen_info(index) >> 4) & 7) == 1);
    let mut emboss =
        needs_emboss.then(|| prepare_emboss_state(attributes, normal_matrix_index, context));
    let mut generated = [[0.0_f64; 3]; 8];
    let mut unscaled = [None; 8];
    for index in 0..count {
        let result = generate_tex_coord(
            attributes,
            matrix_indices[index],
            index,
            &generated,
            emboss.as_mut(),
            context,
        );
        if let Some(result) = result {
            generated[index] = result;
            unscaled[index] = Some(result);
        }
    }
    let mut output = [None; 8];
    for index in 0..count {
        let Some(result) = unscaled[index] else {
            continue;
        };
        let scale = context.texgen_scale(index);
        output[index] = Some([
            f32_mul(result[0] as f32, scale[0] as f32),
            f32_mul(result[1] as f32, scale[1] as f32),
            result[2] as f32,
        ]);
    }
    output
}

fn generate_tex_coord(
    attributes: &TexgenAttributes,
    matrix_index: u8,
    texgen_index: usize,
    generated: &[[f64; 3]; 8],
    emboss: Option<&mut EmbossState>,
    context: &mut TransformContext<'_>,
) -> Option<[f64; 3]> {
    if texgen_index >= context.texgen_count() {
        return None;
    }
    let info = context.texgen_info(texgen_index);
    let projection = (info >> 1) & 1;
    let input_form = (info >> 2) & 1;
    let texgen_type = (info >> 4) & 7;
    let source_row = (info >> 7) & 0x1f;
    if texgen_type == 1 {
        let emboss = emboss?;
        let tangent = emboss.tangent?;
        let binormal = emboss.binormal?;
        let emboss_source = ((info >> 12) & 7) as usize;
        let emboss_light = ((info >> 15) & 7) as u8;
        let source = generated[emboss_source];
        let light_direction = emboss_light_direction(emboss, emboss_light, context)?;
        return Some([
            f64::from(f32_add(source[0] as f32, dot3(light_direction, tangent))),
            f64::from(f32_add(source[1] as f32, dot3(light_direction, binormal))),
            source[2],
        ]);
    }
    if texgen_type == 2 || texgen_type == 3 {
        let color = attributes.colors[(texgen_type - 2) as usize];
        return Some([f64::from(color[0]), f64::from(color[1]), 1.0]);
    }
    if texgen_type != 0 {
        return None;
    }

    let mut source = [0.0_f64, 0.0, 1.0];
    match source_row {
        0 => source = attributes.position.map(f64::from),
        1 => {
            if let Some(value) = attributes.normal {
                source = value.map(f64::from);
            }
        }
        2 => {
            source = [
                f64::from(attributes.colors[0][0]),
                f64::from(attributes.colors[0][1]),
                f64::from(attributes.colors[0][2]),
            ];
        }
        3 => {
            if let Some(value) = attributes.tangent {
                source = value.map(f64::from);
            }
        }
        4 => {
            if let Some(value) = attributes.binormal {
                source = value.map(f64::from);
            }
        }
        5..=12 => {
            if let Some(value) = attributes.raw_texture_coords[(source_row - 5) as usize] {
                source = value.values.map(f64::from);
            }
        }
        _ => {}
    }
    let input = if input_form == 0 {
        [source[0], source[1], 1.0, 1.0]
    } else {
        [source[0], source[1], source[2], 1.0]
    };
    let row0 = context.texgen_row(matrix_index, false)?;
    let row1 = context.texgen_row(matrix_index.wrapping_add(1), false)?;
    let row2 = context.texgen_row(matrix_index.wrapping_add(2), false)?;
    let transformed = [
        dot4_f64(row0, input),
        dot4_f64(row1, input),
        dot4_f64(row2, input),
    ];
    let mut result = if projection == 0 {
        [transformed[0], transformed[1], 1.0]
    } else {
        transformed
    };
    if context.dual_tex_transform() {
        let post_info = context.texgen_post_info(texgen_index);
        if post_info & 0x100 != 0 {
            result = normalize3_f64(result);
        }
        let post_index = (post_info & 0x3f) as u8;
        let post0 = context.texgen_row(post_index, true)?;
        let post1 = context.texgen_row(post_index.wrapping_add(1) & 0x3f, true)?;
        let post2 = context.texgen_row(post_index.wrapping_add(2) & 0x3f, true)?;
        result = [
            dot4_f64(post0, [result[0], result[1], result[2], 1.0]),
            dot4_f64(post1, [result[0], result[1], result[2], 1.0]),
            dot4_f64(post2, [result[0], result[1], result[2], 1.0]),
        ];
    }
    Some(result)
}

fn dot4_f64(row: [f32; 4], vector: [f64; 4]) -> f64 {
    f64::from(row[0]) * vector[0]
        + f64::from(row[1]) * vector[1]
        + f64::from(row[2]) * vector[2]
        + f64::from(row[3]) * vector[3]
}

fn normalize3_f64(vector: [f64; 3]) -> [f64; 3] {
    let length = (vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]).sqrt();
    if !length.is_finite() || length < 1e-12 {
        [0.0; 3]
    } else {
        vector.map(|value| value / length)
    }
}

fn build_exact_clip_input(
    draw: &DrawSnapshot,
    positions: &[[f32; 3]],
    matrix_indices: &[u8],
    context: &mut TransformContext<'_>,
    limits: MaterializerLimits,
    live_bytes: usize,
) -> Result<Result<ExactClipInputOwned, ExactClipFailure>, MaterializeError> {
    if draw.topology > 4
        || draw.pipeline.cull_mode > 3
        || positions.len() != matrix_indices.len()
        || source_triangle_count(draw.topology, positions.len()) == 0
    {
        return Ok(Err(ExactClipFailure::SourceGeometry));
    }
    let exact = draw.exact_raster;
    if exact.bp_gen_mode > 0x00ff_ffff
        || exact.bp_scissor_top_left > 0x00ff_ffff
        || exact.bp_scissor_bottom_right > 0x00ff_ffff
        || exact.bp_scissor_offset > 0x00ff_ffff
        || ((exact.bp_gen_mode >> 14) & 3) as u8 != draw.pipeline.cull_mode
    {
        return Ok(Err(ExactClipFailure::BpState));
    }
    if exact.xf_clip_disable > 7 {
        return Ok(Err(ExactClipFailure::ClipDisable));
    }
    if context.viewport.iter().any(|value| !value.is_finite())
        || context.viewport[0] == 0.0
        || context.viewport[1] == 0.0
    {
        return Ok(Err(ExactClipFailure::Viewport));
    }
    if context.projection.iter().any(|value| !value.is_finite())
        || !matches!(context.projection_type, 0 | 1)
    {
        return Ok(Err(ExactClipFailure::ProjectionState));
    }
    let position_words = positions
        .len()
        .checked_mul(4)
        .ok_or(MaterializeError::VertexByteOverflow)?;
    let evidence_bytes = position_words
        .checked_mul(core::mem::size_of::<u32>())
        .ok_or(MaterializeError::VertexByteOverflow)?;
    check_evidence_bytes(evidence_bytes, limits)?;
    let resident =
        live_bytes
            .checked_add(evidence_bytes)
            .ok_or(MaterializeError::ResidentBytes {
                requested: usize::MAX,
                maximum: limits.maximum_resident_bytes,
            })?;
    check_resident_bytes(resident, limits)?;
    let mut position_bits = Vec::new();
    position_bits
        .try_reserve_exact(position_words)
        .map_err(|_| MaterializeError::Allocation {
            site: MaterializeAllocationSite::ExactClipPositions,
        })?;
    let actual_bytes = position_bits
        .capacity()
        .checked_mul(core::mem::size_of::<u32>())
        .ok_or(MaterializeError::ResidentBytes {
            requested: usize::MAX,
            maximum: limits.maximum_resident_bytes,
        })?;
    check_evidence_bytes(actual_bytes, limits)?;
    check_resident_bytes(
        live_bytes
            .checked_add(actual_bytes)
            .ok_or(MaterializeError::ResidentBytes {
                requested: usize::MAX,
                maximum: limits.maximum_resident_bytes,
            })?,
        limits,
    )?;
    for (position, matrix_index) in positions.iter().zip(matrix_indices) {
        if position.iter().any(|value| !value.is_finite()) {
            return Ok(Err(ExactClipFailure::Position));
        }
        if usize::from(*matrix_index) >= 64 || (usize::from(*matrix_index) + 2) * 4 + 3 >= 0x100 {
            return Ok(Err(ExactClipFailure::PositionMatrixIndex));
        }
        if context.position_matrix(*matrix_index).is_none() {
            return Ok(Err(ExactClipFailure::PositionMatrix));
        }
        let Some(view) = cull_view_position(*position, *matrix_index, context) else {
            return Ok(Err(ExactClipFailure::ViewNonFinite));
        };
        let Some(clip) = exact_clip_view_position(view, context) else {
            return Ok(Err(ExactClipFailure::ClipNonFinite));
        };
        position_bits.extend(clip.map(f32::to_bits));
    }
    Ok(Ok(ExactClipInputOwned {
        bp_gen_mode: exact.bp_gen_mode,
        bp_scissor_top_left: exact.bp_scissor_top_left,
        bp_scissor_bottom_right: exact.bp_scissor_bottom_right,
        bp_scissor_offset: exact.bp_scissor_offset,
        xf_clip_disable: exact.xf_clip_disable,
        viewport_bits: exact.viewport_bits,
        position_bits,
    }))
}

#[allow(clippy::too_many_arguments)]
fn build_post_cull_evidence(
    topology: u8,
    cull_mode: u8,
    positions: &[[f32; 3]],
    matrix_indices: &[u8],
    context: &mut TransformContext<'_>,
    limits: MaterializerLimits,
    live_bytes: usize,
) -> Result<Option<Vec<u8>>, MaterializeError> {
    if topology > 4 || cull_mode > 3 || positions.len() != matrix_indices.len() {
        return Ok(None);
    }
    let triangle_count = source_triangle_count(topology, positions.len());
    if triangle_count == 0 {
        return Ok(None);
    }
    let viewport_height = context.viewport[1];
    if !viewport_height.is_finite() || viewport_height == 0.0 {
        return Ok(None);
    }
    let requested_clip_bytes = positions
        .len()
        .checked_mul(core::mem::size_of::<[f32; 4]>())
        .ok_or(MaterializeError::ResidentBytes {
            requested: usize::MAX,
            maximum: limits.maximum_resident_bytes,
        })?;
    check_resident_bytes(
        live_bytes
            .checked_add(requested_clip_bytes)
            .ok_or(MaterializeError::ResidentBytes {
                requested: usize::MAX,
                maximum: limits.maximum_resident_bytes,
            })?,
        limits,
    )?;
    let mut clips = Vec::new();
    clips
        .try_reserve_exact(positions.len())
        .map_err(|_| MaterializeError::Allocation {
            site: MaterializeAllocationSite::Evidence,
        })?;
    let clip_bytes = clips
        .capacity()
        .checked_mul(core::mem::size_of::<[f32; 4]>())
        .ok_or(MaterializeError::ResidentBytes {
            requested: usize::MAX,
            maximum: limits.maximum_resident_bytes,
        })?;
    check_resident_bytes(
        live_bytes
            .checked_add(clip_bytes)
            .ok_or(MaterializeError::ResidentBytes {
                requested: usize::MAX,
                maximum: limits.maximum_resident_bytes,
            })?,
        limits,
    )?;
    for (position, matrix_index) in positions.iter().zip(matrix_indices) {
        let Some(clip) = cull_clip_position(*position, *matrix_index, context) else {
            return Ok(None);
        };
        if !cull_clip_position_is_inside(clip) {
            return Ok(None);
        }
        clips.push(clip);
    }
    let evidence_len = triangle_count
        .checked_add(3)
        .ok_or(MaterializeError::VertexByteOverflow)?
        / 4;
    check_evidence_bytes(evidence_len, limits)?;
    check_resident_bytes(
        live_bytes
            .checked_add(requested_clip_bytes)
            .and_then(|bytes| bytes.checked_add(evidence_len))
            .ok_or(MaterializeError::ResidentBytes {
                requested: usize::MAX,
                maximum: limits.maximum_resident_bytes,
            })?,
        limits,
    )?;
    let mut evidence = Vec::new();
    evidence
        .try_reserve_exact(evidence_len)
        .map_err(|_| MaterializeError::Allocation {
            site: MaterializeAllocationSite::Evidence,
        })?;
    evidence.resize(evidence_len, 0);
    let evidence_capacity = evidence.capacity();
    check_evidence_bytes(evidence_capacity, limits)?;
    check_resident_bytes(
        live_bytes
            .checked_add(clip_bytes)
            .and_then(|bytes| bytes.checked_add(evidence_capacity))
            .ok_or(MaterializeError::ResidentBytes {
                requested: usize::MAX,
                maximum: limits.maximum_resident_bytes,
            })?,
        limits,
    )?;
    for triangle in 0..triangle_count {
        let Some(indices) = source_triangle_indices(topology, positions.len(), triangle) else {
            return Ok(None);
        };
        let normal = cull_normal_z3(clips[indices[0]], clips[indices[1]], clips[indices[2]]);
        let Some(action) = post_cull_action_from_normal(normal, cull_mode, viewport_height) else {
            return Ok(None);
        };
        evidence[triangle >> 2] |= action << ((triangle & 3) * 2);
    }
    Ok(Some(evidence))
}

fn check_evidence_bytes(
    requested: usize,
    limits: MaterializerLimits,
) -> Result<(), MaterializeError> {
    if requested > limits.maximum_evidence_bytes_per_draw {
        return Err(MaterializeError::EvidenceBytes {
            requested,
            maximum: limits.maximum_evidence_bytes_per_draw,
        });
    }
    Ok(())
}

fn check_resident_bytes(
    requested: usize,
    limits: MaterializerLimits,
) -> Result<(), MaterializeError> {
    if requested > limits.maximum_resident_bytes {
        return Err(MaterializeError::ResidentBytes {
            requested,
            maximum: limits.maximum_resident_bytes,
        });
    }
    Ok(())
}

fn cull_view_position(
    position: [f32; 3],
    matrix_index: u8,
    context: &mut TransformContext<'_>,
) -> Option<[f32; 3]> {
    let matrix = context.position_matrix(matrix_index)?;
    let [x, y, z] = position.map(f32_round);
    let result = [
        cull_dot4_position(matrix, 0, x, y, z, 1.0),
        cull_dot4_position(matrix, 4, x, y, z, 1.0),
        cull_dot4_position(matrix, 8, x, y, z, 1.0),
    ];
    result
        .iter()
        .all(|value| value.is_finite())
        .then_some(result)
}

fn cull_dot4_position(matrix: [f32; 12], offset: usize, x: f32, y: f32, z: f32, w: f32) -> f32 {
    f32_add(
        f32_add(
            f32_add(f32_mul(matrix[offset], x), f32_mul(matrix[offset + 1], y)),
            f32_mul(matrix[offset + 2], z),
        ),
        f32_mul(matrix[offset + 3], w),
    )
}

fn cull_clip_position(
    position: [f32; 3],
    matrix_index: u8,
    context: &mut TransformContext<'_>,
) -> Option<[f32; 4]> {
    let [view_x, view_y, view_z] = cull_view_position(position, matrix_index, context)?;
    let projection = context.projection;
    if projection.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let clip = match context.projection_type {
        0 => [
            f32_add(
                f32_mul(projection[0], view_x),
                f32_mul(projection[1], view_z),
            ),
            f32_add(
                f32_mul(projection[2], view_y),
                f32_mul(projection[3], view_z),
            ),
            f32_add(f32_mul(projection[4], view_z), projection[5]),
            f32_round(-view_z),
        ],
        1 => [
            f32_add(f32_mul(projection[0], view_x), projection[1]),
            f32_add(f32_mul(projection[2], view_y), projection[3]),
            f32_add(f32_mul(projection[4], view_z), projection[5]),
            1.0,
        ],
        _ => return None,
    };
    clip.iter().all(|value| value.is_finite()).then_some(clip)
}

fn exact_clip_view_position(view: [f32; 3], context: &TransformContext<'_>) -> Option<[f32; 4]> {
    if view.iter().any(|value| !value.is_finite())
        || context.projection.iter().any(|value| !value.is_finite())
    {
        return None;
    }
    let [view_x, view_y, view_z] = view.map(f32_round);
    let projection = context.projection;
    let clip = match context.projection_type {
        0 => {
            let depth = f32_add(f32_mul(projection[4], view_z), projection[5]);
            [
                f32_add(
                    f32_mul(projection[0], view_x),
                    f32_mul(projection[1], view_z),
                ),
                f32_add(
                    f32_mul(projection[2], view_y),
                    f32_mul(projection[3], view_z),
                ),
                f32_mul(depth, f32_sub(1.0, f32_round(1e-7))),
                f32_round(-view_z),
            ]
        }
        1 => [
            f32_add(f32_mul(projection[0], view_x), projection[1]),
            f32_add(f32_mul(projection[2], view_y), projection[3]),
            f32_add(f32_mul(projection[4], view_z), projection[5]),
            1.0,
        ],
        _ => return None,
    };
    clip.iter().all(|value| value.is_finite()).then_some(clip)
}

fn cull_clip_position_is_inside(clip: [f32; 4]) -> bool {
    if clip.iter().any(|value| !value.is_finite()) {
        return false;
    }
    let [x, y, z, w] = clip.map(f32_round);
    if w <= 0.0 {
        return false;
    }
    let distances = [
        f32_sub(w, x),
        f32_add(x, w),
        f32_sub(w, y),
        f32_add(y, w),
        z,
        f32_add(z, w),
    ];
    distances.iter().all(|value| value.is_finite())
        && distances[0] >= 0.0
        && distances[1] >= 0.0
        && distances[2] >= 0.0
        && distances[3] >= 0.0
        && distances[4] <= 0.0
        && distances[5] >= 0.0
}

fn cull_normal_z3(first: [f32; 4], second: [f32; 4], third: [f32; 4]) -> Option<f32> {
    let term0 = f32_mul(
        f32_sub(f32_mul(first[0], third[3]), f32_mul(third[0], first[3])),
        second[1],
    );
    let term1 = f32_mul(
        f32_sub(f32_mul(third[0], first[1]), f32_mul(first[0], third[1])),
        second[3],
    );
    let term2 = f32_mul(
        f32_sub(f32_mul(third[1], first[3]), f32_mul(first[1], third[3])),
        second[0],
    );
    let normal = f32_add(f32_add(term0, term1), term2);
    normal.is_finite().then_some(normal)
}

fn post_cull_action_from_normal(
    normal: Option<f32>,
    cull_mode: u8,
    viewport_height: f32,
) -> Option<u8> {
    if !viewport_height.is_finite() || viewport_height == 0.0 || cull_mode > 3 {
        return None;
    }
    let mut backface = normal? <= 0.0;
    if viewport_height > 0.0 {
        backface = !backface;
    }
    let survives = cull_mode == 0 || (cull_mode == 1 && backface) || (cull_mode == 2 && !backface);
    Some((u8::from(survives) << 1) | u8::from(backface))
}

fn source_triangle_count(topology: u8, vertex_count: usize) -> usize {
    match topology {
        0 | 1 => vertex_count / 4 * 2 + usize::from(vertex_count % 4 == 3),
        2 => vertex_count / 3,
        3 | 4 => vertex_count.saturating_sub(2),
        _ => 0,
    }
}

fn source_triangle_indices(
    topology: u8,
    vertex_count: usize,
    triangle: usize,
) -> Option<[usize; 3]> {
    if triangle >= source_triangle_count(topology, vertex_count) {
        return None;
    }
    match topology {
        0 | 1 => {
            let quad_triangles = vertex_count / 4 * 2;
            if triangle >= quad_triangles {
                let base = vertex_count.checked_sub(3)?;
                return Some([base, base + 1, base + 2]);
            }
            let base = triangle / 2 * 4;
            if triangle.is_multiple_of(2) {
                Some([base, base + 1, base + 2])
            } else {
                Some([base, base + 2, base + 3])
            }
        }
        2 => {
            let base = triangle.checked_mul(3)?;
            Some([base, base + 1, base + 2])
        }
        3 => {
            let end = triangle + 2;
            if end.is_multiple_of(2) {
                Some([end - 2, end - 1, end])
            } else {
                Some([end - 2, end, end - 1])
            }
        }
        4 => Some([0, triangle + 1, triangle + 2]),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug)]
struct NumericAttributePlan {
    status: u8,
    elements: u8,
    format: u8,
    component_bytes: usize,
    direct_bytes: usize,
    scale: f32,
}

#[derive(Clone, Copy, Debug)]
struct NormalAttributePlan {
    status: u8,
    elements: u8,
    format: u8,
    separate_indices: bool,
}

#[derive(Clone, Copy, Debug)]
struct ColorAttributePlan {
    status: u8,
    format: u8,
    direct_bytes: usize,
}

#[derive(Clone, Copy, Debug)]
struct VertexDecodePlan {
    descriptor_low: u32,
    position_matrix: u8,
    texture_matrices: [u8; 8],
    position: NumericAttributePlan,
    normal: NormalAttributePlan,
    colors: [ColorAttributePlan; 2],
    textures: [NumericAttributePlan; 8],
    bytes_per_vertex: usize,
}

impl VertexDecodePlan {
    fn new(draw: &DrawSnapshot) -> Result<Self, MaterializeError> {
        let vat = draw.vat_index;
        if vat >= 8 {
            return Err(MaterializeError::UnsupportedVat(vat));
        }
        let format = draw.format;
        let descriptor_low = format.vcd_low;
        let descriptor_high = format.vcd_high;
        let vat_a = format.vat_a;
        let vat_b = format.vat_b;
        let vat_c = format.vat_c;
        let position_format = ((vat_a >> 1) & 7) as u8;
        let position_elements = ((vat_a & 1) + 2) as u8;
        let position_component_bytes = component_bytes(position_format);
        let position = NumericAttributePlan {
            status: attribute_status(descriptor_low, descriptor_high, 0),
            elements: position_elements,
            format: position_format,
            component_bytes: position_component_bytes,
            direct_bytes: usize::from(position_elements)
                .checked_mul(position_component_bytes)
                .ok_or(MaterializeError::VertexByteOverflow)?,
            scale: if position_format == 4 {
                1.0
            } else {
                fraction_scale(((vat_a >> 4) & 0x1f) as u8)
            },
        };
        let normal = NormalAttributePlan {
            status: attribute_status(descriptor_low, descriptor_high, 1),
            elements: ((vat_a >> 9) & 1) as u8,
            format: ((vat_a >> 10) & 7) as u8,
            separate_indices: vat_a & 0x8000_0000 != 0 && vat_a & (1 << 9) != 0,
        };
        let colors = core::array::from_fn(|color| {
            let color = color as u32;
            let color_format = ((vat_a >> (14 + color * 4)) & 7) as u8;
            ColorAttributePlan {
                status: attribute_status(descriptor_low, descriptor_high, 2 + color as usize),
                format: color_format,
                direct_bytes: color_direct_bytes(color_format),
            }
        });
        let texture_bits = [
            ((vat_a >> 21) & 1, (vat_a >> 22) & 7, (vat_a >> 25) & 0x1f),
            (vat_b & 1, (vat_b >> 1) & 7, (vat_b >> 4) & 0x1f),
            ((vat_b >> 9) & 1, (vat_b >> 10) & 7, (vat_b >> 13) & 0x1f),
            ((vat_b >> 18) & 1, (vat_b >> 19) & 7, (vat_b >> 22) & 0x1f),
            ((vat_b >> 27) & 1, (vat_b >> 28) & 7, vat_c & 0x1f),
            ((vat_c >> 5) & 1, (vat_c >> 6) & 7, (vat_c >> 9) & 0x1f),
            ((vat_c >> 14) & 1, (vat_c >> 15) & 7, (vat_c >> 18) & 0x1f),
            ((vat_c >> 23) & 1, (vat_c >> 24) & 7, (vat_c >> 27) & 0x1f),
        ];
        let textures = core::array::from_fn(|texture| {
            let (elements, numeric_format, fraction) = texture_bits[texture];
            let numeric_format = numeric_format as u8;
            let elements = (elements + 1) as u8;
            let bytes = component_bytes(numeric_format);
            NumericAttributePlan {
                status: attribute_status(descriptor_low, descriptor_high, 4 + texture),
                elements,
                format: numeric_format,
                component_bytes: bytes,
                direct_bytes: usize::from(elements) * bytes,
                scale: if numeric_format == 4 {
                    1.0
                } else {
                    fraction_scale(fraction as u8)
                },
            }
        });

        let mut bytes_per_vertex = (descriptor_low & 0x01ff).count_ones() as usize;
        bytes_per_vertex = bytes_per_vertex
            .checked_add(attribute_bytes(position.status, position.direct_bytes))
            .ok_or(MaterializeError::VertexByteOverflow)?;
        let normal_vectors = if normal.elements == 0 { 1 } else { 3 };
        let normal_direct = normal_vectors * 3 * component_bytes(normal.format);
        let normal_bytes = if normal.status == 1 {
            normal_direct
        } else if normal.status >= 2 {
            let index_bytes = if normal.status == 2 { 1 } else { 2 };
            if normal.elements != 0 && normal.separate_indices {
                index_bytes * 3
            } else {
                index_bytes
            }
        } else {
            0
        };
        bytes_per_vertex = bytes_per_vertex
            .checked_add(normal_bytes)
            .ok_or(MaterializeError::VertexByteOverflow)?;
        for color in colors {
            bytes_per_vertex = bytes_per_vertex
                .checked_add(attribute_bytes(color.status, color.direct_bytes))
                .ok_or(MaterializeError::VertexByteOverflow)?;
        }
        for texture in textures {
            bytes_per_vertex = bytes_per_vertex
                .checked_add(attribute_bytes(texture.status, texture.direct_bytes))
                .ok_or(MaterializeError::VertexByteOverflow)?;
        }
        if bytes_per_vertex != usize::from(format.bytes_per_vertex) {
            return Err(MaterializeError::StateMismatch("vertex byte plan"));
        }
        let matrix_a = format.matrix_index_a;
        let matrix_b = format.matrix_index_b;
        Ok(Self {
            descriptor_low,
            position_matrix: (matrix_a & 0x3f) as u8,
            texture_matrices: [
                ((matrix_a >> 6) & 0x3f) as u8,
                ((matrix_a >> 12) & 0x3f) as u8,
                ((matrix_a >> 18) & 0x3f) as u8,
                ((matrix_a >> 24) & 0x3f) as u8,
                (matrix_b & 0x3f) as u8,
                ((matrix_b >> 6) & 0x3f) as u8,
                ((matrix_b >> 12) & 0x3f) as u8,
                ((matrix_b >> 18) & 0x3f) as u8,
            ],
            position,
            normal,
            colors,
            textures,
            bytes_per_vertex,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AttributeAvailability {
    Absent,
    Present,
    Sentinel,
    Invalid(MemoryError),
}

#[derive(Clone, Copy, Debug)]
struct AttributeData {
    bytes: [u8; ATTRIBUTE_SCRATCH_BYTES],
    len: usize,
    cursor: usize,
    availability: AttributeAvailability,
}

impl AttributeData {
    fn absent(cursor: usize) -> Self {
        Self {
            bytes: [0; ATTRIBUTE_SCRATCH_BYTES],
            len: 0,
            cursor,
            availability: AttributeAvailability::Absent,
        }
    }

    fn as_slice(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

#[derive(Clone, Copy, Debug)]
struct NormalAttribute {
    normal: Option<[f32; 3]>,
    tangent: Option<[f32; 3]>,
    binormal: Option<[f32; 3]>,
    cursor: usize,
    skipped: bool,
    memory_error: Option<MemoryError>,
}

impl NormalAttribute {
    fn empty(cursor: usize) -> Self {
        Self {
            normal: None,
            tangent: None,
            binormal: None,
            cursor,
            skipped: false,
            memory_error: None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct RawTexCoord {
    values: [f32; 3],
}

#[derive(Clone, Copy, Debug)]
struct DecodedVertex {
    projected: Option<[f32; 4]>,
    position: [f32; 3],
    position_matrix: u8,
    raster_colors: [[f32; 4]; 2],
    tex_coords: [Option<[f32; 3]>; 8],
}

#[derive(Clone, Copy, Debug)]
enum VertexResult {
    Output(DecodedVertex),
    PositionSentinel,
    Dropped(VertexDiscardReason),
}

fn attribute_status(vcd_low: u32, vcd_high: u32, index: usize) -> u8 {
    if index < 4 {
        ((vcd_low >> (9 + index * 2)) & 3) as u8
    } else {
        ((vcd_high >> ((index - 4) * 2)) & 3) as u8
    }
}

fn component_bytes(format: u8) -> usize {
    if format <= 1 {
        1
    } else if format <= 3 {
        2
    } else {
        4
    }
}

fn attribute_bytes(status: u8, direct_bytes: usize) -> usize {
    match status {
        0 => 0,
        1 => direct_bytes,
        2 => 1,
        _ => 2,
    }
}

fn color_direct_bytes(format: u8) -> usize {
    [2, 3, 4, 2, 3, 4]
        .get(usize::from(format))
        .copied()
        .unwrap_or(0)
}

fn fraction_scale(fraction: u8) -> f32 {
    f32::from_bits((127_u32.saturating_sub(u32::from(fraction))) << 23)
}

#[derive(Clone, Copy, Debug, Default)]
struct DrawStatsDelta {
    position_index_skips: u64,
    normal_cache_commits: u64,
    cached_normal_uses: u64,
    cached_tangent_uses: u64,
    cached_binormal_uses: u64,
    projection_fallback_vertices: u64,
}

impl ResidentVertexMaterializer {
    fn materialize_draw<M: GxMemory>(
        &mut self,
        draw: &DrawSnapshot,
        memory: &mut M,
        already_retained: usize,
    ) -> Result<Result<MaterializedDraw, VertexDiscardReason>, MaterializeError> {
        self.validate_draw_state(draw)?;
        let plan = VertexDecodePlan::new(draw)?;
        let input_vertices = usize::from(draw.vertex_count);
        if input_vertices > self.limits.maximum_vertices_per_draw {
            return Err(MaterializeError::VertexLimit {
                requested: input_vertices,
                maximum: self.limits.maximum_vertices_per_draw,
            });
        }
        if draw.encoded_vertices.len() > self.limits.maximum_encoded_vertex_bytes_per_draw {
            return Err(MaterializeError::EncodedVertexBytes {
                requested: draw.encoded_vertices.len(),
                maximum: self.limits.maximum_encoded_vertex_bytes_per_draw,
            });
        }
        let expected_encoded = input_vertices
            .checked_mul(plan.bytes_per_vertex)
            .ok_or(MaterializeError::VertexByteOverflow)?;
        if expected_encoded != draw.encoded_vertices.len() {
            return Err(MaterializeError::EncodedLength {
                expected: expected_encoded,
                received: draw.encoded_vertices.len(),
            });
        }
        let canonical_capacity = input_vertices
            .checked_mul(CANONICAL_VERTEX_BYTES)
            .ok_or(MaterializeError::VertexByteOverflow)?;
        if canonical_capacity > self.limits.maximum_canonical_vertex_bytes_per_draw {
            return Err(MaterializeError::CanonicalVertexBytes {
                requested: canonical_capacity,
                maximum: self.limits.maximum_canonical_vertex_bytes_per_draw,
            });
        }
        let source_position_bytes = input_vertices
            .checked_mul(core::mem::size_of::<[f32; 3]>())
            .ok_or(MaterializeError::VertexByteOverflow)?;
        let matrix_index_bytes = input_vertices
            .checked_mul(core::mem::size_of::<u8>())
            .ok_or(MaterializeError::VertexByteOverflow)?;
        let working_bytes = already_retained
            .checked_add(canonical_capacity)
            .and_then(|bytes| bytes.checked_add(source_position_bytes))
            .and_then(|bytes| bytes.checked_add(matrix_index_bytes))
            .ok_or(MaterializeError::ResidentBytes {
                requested: usize::MAX,
                maximum: self.limits.maximum_resident_bytes,
            })?;
        self.preflight_resident(working_bytes)?;

        let mut canonical = Vec::new();
        canonical
            .try_reserve_exact(canonical_capacity)
            .map_err(|_| MaterializeError::Allocation {
                site: MaterializeAllocationSite::CanonicalVertices,
            })?;
        let mut source_positions = Vec::new();
        source_positions
            .try_reserve_exact(input_vertices)
            .map_err(|_| MaterializeError::Allocation {
                site: MaterializeAllocationSite::SourcePositions,
            })?;
        let mut position_matrix_indices = Vec::new();
        position_matrix_indices
            .try_reserve_exact(input_vertices)
            .map_err(|_| MaterializeError::Allocation {
                site: MaterializeAllocationSite::MatrixIndices,
            })?;
        let actual_canonical_bytes = canonical.capacity();
        if actual_canonical_bytes > self.limits.maximum_canonical_vertex_bytes_per_draw {
            return Err(MaterializeError::CanonicalVertexBytes {
                requested: actual_canonical_bytes,
                maximum: self.limits.maximum_canonical_vertex_bytes_per_draw,
            });
        }
        let actual_source_position_bytes = source_positions
            .capacity()
            .checked_mul(core::mem::size_of::<[f32; 3]>())
            .ok_or(MaterializeError::ResidentBytes {
                requested: usize::MAX,
                maximum: self.limits.maximum_resident_bytes,
            })?;
        let actual_matrix_index_bytes = position_matrix_indices
            .capacity()
            .checked_mul(core::mem::size_of::<u8>())
            .ok_or(MaterializeError::ResidentBytes {
                requested: usize::MAX,
                maximum: self.limits.maximum_resident_bytes,
            })?;
        let actual_working_bytes = already_retained
            .checked_add(actual_canonical_bytes)
            .and_then(|bytes| bytes.checked_add(actual_source_position_bytes))
            .and_then(|bytes| bytes.checked_add(actual_matrix_index_bytes))
            .ok_or(MaterializeError::ResidentBytes {
                requested: usize::MAX,
                maximum: self.limits.maximum_resident_bytes,
            })?;
        self.preflight_resident(actual_working_bytes)?;

        let mut transform = TransformContext::new(&self.xf, &self.bp);
        let mut normal_cache = self.normal_cache;
        let mut delta = DrawStatsDelta::default();
        let mut first_drop = None;
        let mut first_non_finite_lane = None;
        let mut exact_required = false;
        let mut output_vertices = 0usize;
        for vertex in 0..input_vertices {
            let start = vertex
                .checked_mul(plan.bytes_per_vertex)
                .ok_or(MaterializeError::VertexByteOverflow)?;
            let end = start
                .checked_add(plan.bytes_per_vertex)
                .ok_or(MaterializeError::VertexByteOverflow)?;
            let source =
                draw.encoded_vertices
                    .get(start..end)
                    .ok_or(MaterializeError::TruncatedVertex {
                        vertex: vertex as u16,
                        cursor: start,
                        required: plan.bytes_per_vertex,
                        available: draw.encoded_vertices.len().saturating_sub(start),
                    })?;
            let commit_normal_cache = vertex + 1 == input_vertices;
            match decode_vertex(
                source,
                vertex as u16,
                &plan,
                &self.cp,
                memory,
                &mut transform,
                &mut normal_cache,
                commit_normal_cache,
                &mut delta,
            )? {
                VertexResult::PositionSentinel => {
                    delta.position_index_skips = delta.position_index_skips.saturating_add(1);
                }
                VertexResult::Dropped(reason) => {
                    if first_drop.is_none() {
                        first_drop = Some(reason);
                    }
                }
                VertexResult::Output(decoded) => {
                    source_positions.push(decoded.position);
                    position_matrix_indices.push(decoded.position_matrix);
                    let projected = decoded.projected.unwrap_or_else(|| {
                        exact_required = true;
                        delta.projection_fallback_vertices =
                            delta.projection_fallback_vertices.saturating_add(1);
                        [0.0, 0.0, 0.0, 1.0]
                    });
                    let mut carrier = [0.0_f32; CANONICAL_VERTEX_FLOATS];
                    carrier[..4].copy_from_slice(&projected);
                    carrier[4..8].copy_from_slice(&decoded.raster_colors[0]);
                    carrier[8..12].copy_from_slice(&decoded.raster_colors[1]);
                    for texgen in 0..8 {
                        let coordinate = decoded.tex_coords[texgen].unwrap_or([0.0, 0.0, 1.0]);
                        let offset = 12 + texgen * 3;
                        carrier[offset..offset + 3].copy_from_slice(&coordinate);
                    }
                    for (lane, value) in carrier.into_iter().enumerate() {
                        if !value.is_finite() && first_non_finite_lane.is_none() {
                            first_non_finite_lane =
                                Some(output_vertices * CANONICAL_VERTEX_FLOATS + lane);
                        }
                        canonical.extend_from_slice(&value.to_bits().to_le_bytes());
                    }
                    output_vertices += 1;
                }
            }
        }
        self.normal_cache = normal_cache;
        commit_stats_delta(&mut self.stats, delta);

        if let Some(reason) = first_drop {
            return Ok(Err(reason));
        }
        if output_vertices == 0 {
            return Ok(Err(VertexDiscardReason::NoOutputVertices));
        }
        if let Some(lane) = first_non_finite_lane {
            return Ok(Err(VertexDiscardReason::NonFiniteCarrier { lane }));
        }

        let evidence_live_base = actual_working_bytes;
        self.preflight_resident(evidence_live_base)?;
        let evidence = if exact_required {
            let input = match build_exact_clip_input(
                draw,
                &source_positions,
                &position_matrix_indices,
                &mut transform,
                self.limits,
                evidence_live_base,
            )? {
                Ok(input) => input,
                Err(reason) => {
                    return Ok(Err(VertexDiscardReason::ExactClip(reason)));
                }
            };
            self.stats.exact_required_draws = self.stats.exact_required_draws.saturating_add(1);
            MaterializedEvidence::Exact {
                required: true,
                input,
            }
        } else if let Some(post_cull) = build_post_cull_evidence(
            draw.topology,
            draw.pipeline.cull_mode,
            &source_positions,
            &position_matrix_indices,
            &mut transform,
            self.limits,
            evidence_live_base,
        )? {
            self.stats.post_cull_draws = self.stats.post_cull_draws.saturating_add(1);
            MaterializedEvidence::PostCull(post_cull)
        } else {
            match build_exact_clip_input(
                draw,
                &source_positions,
                &position_matrix_indices,
                &mut transform,
                self.limits,
                evidence_live_base,
            )? {
                Ok(input) => MaterializedEvidence::Exact {
                    required: false,
                    input,
                },
                Err(_) => MaterializedEvidence::None,
            }
        };
        let vertex_count =
            u32::try_from(output_vertices).map_err(|_| MaterializeError::VertexLimit {
                requested: output_vertices,
                maximum: self.limits.maximum_vertices_per_draw,
            })?;
        Ok(Ok(MaterializedDraw {
            topology: draw.topology,
            vat_index: draw.vat_index,
            input_vertex_count: draw.vertex_count,
            vertices: CanonicalVertexData {
                bytes: canonical,
                vertex_count,
            },
            pipeline: draw.pipeline,
            exact_raster: draw.exact_raster,
            tev: draw.tev,
            textures: draw.textures,
            texture_use_order: draw.texture_use_order,
            evidence,
        }))
    }

    fn validate_draw_state(&self, draw: &DrawSnapshot) -> Result<(), MaterializeError> {
        let vat = usize::from(draw.vat_index);
        if vat >= 8 {
            return Err(MaterializeError::UnsupportedVat(draw.vat_index));
        }
        let format = draw.format;
        let cp_checks = [
            (self.cp[0x30], format.matrix_index_a, "CP matrix-index A"),
            (self.cp[0x40], format.matrix_index_b, "CP matrix-index B"),
            (self.cp[0x50], format.vcd_low, "CP VCD low"),
            (self.cp[0x60], format.vcd_high, "CP VCD high"),
            (self.cp[0x70 + vat], format.vat_a, "CP VAT A"),
            (self.cp[0x80 + vat], format.vat_b, "CP VAT B"),
            (self.cp[0x90 + vat], format.vat_c, "CP VAT C"),
        ];
        for (actual, expected, field) in cp_checks {
            if actual != expected {
                return Err(MaterializeError::StateMismatch(field));
            }
        }
        let exact = draw.exact_raster;
        let state_checks = [
            (self.bp[0x00], exact.bp_gen_mode, "BP generation mode"),
            (
                self.bp[0x20],
                exact.bp_scissor_top_left,
                "BP scissor top-left",
            ),
            (
                self.bp[0x21],
                exact.bp_scissor_bottom_right,
                "BP scissor bottom-right",
            ),
            (self.bp[0x59], exact.bp_scissor_offset, "BP scissor offset"),
            (self.xf[0x1005], exact.xf_clip_disable, "XF clip disable"),
            (self.xf[0x1026], exact.projection_type, "XF projection type"),
        ];
        for (actual, expected, field) in state_checks {
            if actual != expected {
                return Err(MaterializeError::StateMismatch(field));
            }
        }
        if self.xf[0x101a..0x1020] != exact.viewport_bits
            || self.xf[0x1020..0x1026] != exact.projection_bits
        {
            return Err(MaterializeError::StateMismatch("XF projection/viewport"));
        }
        if draw.pipeline.viewport_half_width_bits != self.xf[0x101a] {
            return Err(MaterializeError::StateMismatch("XF viewport half-width"));
        }
        Ok(())
    }
}

fn commit_stats_delta(stats: &mut MaterializerStats, delta: DrawStatsDelta) {
    stats.position_index_skips = stats
        .position_index_skips
        .saturating_add(delta.position_index_skips);
    stats.normal_cache_commits = stats
        .normal_cache_commits
        .saturating_add(delta.normal_cache_commits);
    stats.cached_normal_uses = stats
        .cached_normal_uses
        .saturating_add(delta.cached_normal_uses);
    stats.cached_tangent_uses = stats
        .cached_tangent_uses
        .saturating_add(delta.cached_tangent_uses);
    stats.cached_binormal_uses = stats
        .cached_binormal_uses
        .saturating_add(delta.cached_binormal_uses);
    stats.projection_fallback_vertices = stats
        .projection_fallback_vertices
        .saturating_add(delta.projection_fallback_vertices);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::system::gx::resident_fifo::{DecodeStatus, DecoderLimits, ResidentGxDecoder};

    struct TestMemory {
        bytes: Vec<u8>,
    }

    impl TestMemory {
        fn new(length: usize) -> Self {
            Self {
                bytes: vec![0; length],
            }
        }

        fn write(&mut self, address: usize, source: &[u8]) {
            self.bytes[address..address + source.len()].copy_from_slice(source);
        }
    }

    impl GxMemory for TestMemory {
        fn read_exact(&mut self, address: u32, destination: &mut [u8]) -> Result<(), MemoryError> {
            let start = usize::try_from(address).map_err(|_| MemoryError::OutOfBounds)?;
            let end = start
                .checked_add(destination.len())
                .ok_or(MemoryError::OutOfBounds)?;
            let source = self.bytes.get(start..end).ok_or(MemoryError::Unmapped)?;
            destination.copy_from_slice(source);
            Ok(())
        }
    }

    fn cp(register: u8, value: u32) -> Vec<u8> {
        let mut command = vec![0x08, register];
        command.extend(value.to_be_bytes());
        command
    }

    fn bp(register: u8, value: u32) -> Vec<u8> {
        let mut command = vec![0x61];
        command.extend((u32::from(register) << 24 | value & 0x00ff_ffff).to_be_bytes());
        command
    }

    fn xf(start: u16, values: &[u32]) -> Vec<u8> {
        assert!(!values.is_empty() && values.len() <= 16);
        let header = ((values.len() as u32 - 1) << 16) | u32::from(start);
        let mut command = vec![0x10];
        command.extend(header.to_be_bytes());
        for value in values {
            command.extend(value.to_be_bytes());
        }
        command
    }

    fn xf_f32(start: u16, values: &[f32]) -> Vec<u8> {
        xf(
            start,
            &values
                .iter()
                .map(|value| value.to_bits())
                .collect::<Vec<_>>(),
        )
    }

    fn push_f32(target: &mut Vec<u8>, value: f32) {
        target.extend(value.to_bits().to_be_bytes());
    }

    fn push_position(target: &mut Vec<u8>, position: [f32; 3]) {
        for component in position {
            push_f32(target, component);
        }
    }

    fn base_state(projection_type: u32) -> Vec<u8> {
        let mut stream = xf_f32(
            0,
            &[1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        );
        stream.extend(xf_f32(
            0x400,
            &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        ));
        stream.extend(xf(0x100a, &[0, 0, 0xffff_ffff, 0xffff_ffff, 0, 0, 0, 0]));
        stream.extend(xf_f32(0x101a, &[320.0, -264.0, 1.0, 320.0, 264.0, 0.0]));
        let mut projection = xf_f32(0x1020, &[1.0, 0.0, 1.0, 0.0, 1.0, 0.0]);
        projection.extend(xf(0x1026, &[projection_type]));
        stream.extend(projection);
        stream
    }

    fn with_materialized<R>(
        stream: &[u8],
        memory: &mut TestMemory,
        inspect: impl FnOnce(&MaterializedBatch<'_>) -> R,
    ) -> (R, NormalCacheSnapshot, MaterializerStats) {
        let mut decoder = ResidentGxDecoder::try_new(DecoderLimits::default()).unwrap();
        let decoded = decoder.append(stream, memory).unwrap();
        assert_eq!(decoded.status, DecodeStatus::Drained);
        let mut materializer =
            ResidentVertexMaterializer::try_new(MaterializerLimits::default()).unwrap();
        let materialized = materializer.materialize_batch(&decoded, memory).unwrap();
        let result = inspect(&materialized);
        drop(materialized);
        (result, materializer.normal_cache(), materializer.stats())
    }

    fn lane(draw: &MaterializedDraw, vertex: usize, lane: usize) -> f32 {
        let offset = vertex * CANONICAL_VERTEX_BYTES + lane * 4;
        let bytes: [u8; 4] = draw.vertices.as_bytes()[offset..offset + 4]
            .try_into()
            .unwrap();
        f32::from_bits(u32::from_le_bytes(bytes))
    }

    #[test]
    fn direct_sdk_triangle_emits_exact_144_byte_carriers_and_post_cull_evidence() {
        let mut stream = base_state(1);
        stream.extend(cp(0x50, 1 << 9));
        stream.extend(cp(0x70, 1 | (4 << 1)));
        stream.push(0x90);
        stream.extend(3_u16.to_be_bytes());
        for position in [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.0, 0.5, -0.5]] {
            push_position(&mut stream, position);
        }
        let mut memory = TestMemory::new(1);
        let ((vertex_bytes, evidence, first), _, stats) =
            with_materialized(&stream, &mut memory, |batch| {
                assert_eq!(batch.records().len(), 1);
                let draw = &batch.draws()[0];
                let evidence = match &draw.evidence {
                    MaterializedEvidence::PostCull(bytes) => bytes.clone(),
                    other => panic!("unexpected evidence {other:?}"),
                };
                (
                    draw.vertices.as_bytes().len(),
                    evidence,
                    [lane(draw, 0, 0), lane(draw, 0, 1), lane(draw, 0, 2)],
                )
            });
        assert_eq!(vertex_bytes, 3 * 144);
        assert_eq!(evidence, [2]);
        assert_eq!(first, [160.0, 396.0, -0.5]);
        assert_eq!(stats.draws_materialized, 1);
        assert_eq!(stats.output_vertices, 3);
    }

    #[test]
    fn indexed_position_color_and_direct_texcoord_match_browser_oracle() {
        let mut memory = TestMemory::new(0x300);
        let mut position = Vec::new();
        push_position(&mut position, [-0.25, 0.25, -0.5]);
        memory.write(0x100, &position);
        memory.write(0x200, &[10, 20, 30, 40]);

        let mut stream = base_state(1);
        stream.extend(xf(0x100e, &[1]));
        stream.extend(xf(0x1010, &[1]));
        stream.extend(xf(0x103f, &[1]));
        stream.extend(xf(0x1040, &[5 << 7]));
        stream.extend(cp(0x50, (2 << 9) | (3 << 13)));
        stream.extend(cp(0x60, 1));
        stream.extend(cp(0x70, 1 | (4 << 1) | (5 << 14) | (1 << 21) | (4 << 22)));
        stream.extend(cp(0xa0, 0x100));
        stream.extend(cp(0xb0, 12));
        stream.extend(cp(0xa2, 0x200));
        stream.extend(cp(0xb2, 4));
        stream.push(0xb8);
        stream.extend(1_u16.to_be_bytes());
        stream.extend([0, 0, 0]);
        push_f32(&mut stream, 0.25);
        push_f32(&mut stream, 0.75);

        let (values, _, _) = with_materialized(&stream, &mut memory, |batch| {
            let draw = &batch.draws()[0];
            [
                lane(draw, 0, 0),
                lane(draw, 0, 1),
                lane(draw, 0, 4),
                lane(draw, 0, 5),
                lane(draw, 0, 6),
                lane(draw, 0, 7),
                lane(draw, 0, 12),
                lane(draw, 0, 13),
                lane(draw, 0, 14),
            ]
        });
        assert_eq!(values[0..2], [240.0, 198.0]);
        assert_eq!(values[2].to_bits(), (10.0_f32 / 255.0).to_bits());
        assert_eq!(values[3].to_bits(), (20.0_f32 / 255.0).to_bits());
        assert_eq!(values[4].to_bits(), (30.0_f32 / 255.0).to_bits());
        assert_eq!(values[5].to_bits(), (40.0_f32 / 255.0).to_bits());
        assert_eq!(values[6..9], [0.25, 0.75, 1.0]);
    }

    #[test]
    fn position_sentinel_consumes_attributes_and_commits_only_final_normal() {
        let mut memory = TestMemory::new(0x200);
        let mut position = Vec::new();
        push_position(&mut position, [0.0, 0.0, -0.5]);
        memory.write(0x100, &position);
        let mut stream = base_state(1);
        stream.extend(cp(0x50, (2 << 9) | (1 << 11)));
        stream.extend(cp(0x70, 1 | (4 << 1) | (1 << 10)));
        stream.extend(cp(0xa0, 0x100));
        stream.extend(cp(0xb0, 12));
        stream.push(0xb8);
        stream.extend(2_u16.to_be_bytes());
        stream.extend([0, 0, 64, 0]);
        stream.extend([0xff, 64, 0, 0]);

        let (count, cache, stats) = with_materialized(&stream, &mut memory, |batch| {
            batch.draws()[0].vertices.vertex_count()
        });
        assert_eq!(count, 1);
        assert_eq!(cache.normal, [1.0, 0.0, 0.0]);
        assert_eq!(stats.position_index_skips, 1);
        assert_eq!(stats.normal_cache_commits, 1);
    }

    #[test]
    fn separate_nbt_indexes_use_array_one_and_persist_all_three_vectors() {
        let mut memory = TestMemory::new(0x200);
        let mut vectors = [0_u8; 27];
        vectors[0..3].copy_from_slice(&[64, 0, 0]);
        vectors[12..15].copy_from_slice(&[0, 64, 0]);
        vectors[24..27].copy_from_slice(&[0, 0, 64]);
        memory.write(0x100, &vectors);
        let mut stream = base_state(1);
        stream.extend(cp(0x50, (1 << 9) | (2 << 11)));
        stream.extend(cp(0x70, 1 | (4 << 1) | (1 << 9) | (1 << 10) | (1 << 31)));
        stream.extend(cp(0xa1, 0x100));
        stream.extend(cp(0xb1, 9));
        stream.push(0xb8);
        stream.extend(1_u16.to_be_bytes());
        push_position(&mut stream, [0.0, 0.0, -0.5]);
        stream.extend([0, 1, 2]);

        let (_, cache, stats) = with_materialized(&stream, &mut memory, |batch| {
            assert_eq!(batch.draws().len(), 1);
        });
        assert_eq!(cache.normal, [1.0, 0.0, 0.0]);
        assert_eq!(cache.tangent, [0.0, 1.0, 0.0]);
        assert_eq!(cache.binormal, [0.0, 0.0, 1.0]);
        assert_eq!(stats.normal_cache_commits, 1);
    }

    #[test]
    fn xf_lighting_uses_integer_modulation_and_f32_accumulation() {
        let mut stream = base_state(1);
        stream.extend(xf(0x100a, &[0x4040_4040]));
        stream.extend(xf(0x100c, &[0xffff_ffff]));
        let control = 2 | (1 << 2) | (2 << 7);
        stream.extend(xf(0x100e, &[control]));
        stream.extend(xf(0x1010, &[control]));
        stream.extend(xf(0x603, &[0x8080_8080]));
        stream.extend(xf_f32(0x604, &[0.0, 0.0, 0.0, 0.0, 0.0, 0.0]));
        stream.extend(xf_f32(0x60a, &[0.0, 0.0, 3.0, 0.0, 0.0, 0.0]));
        stream.extend(cp(0x50, (1 << 9) | (1 << 11)));
        stream.extend(cp(0x70, 1 | (4 << 1) | (1 << 10)));
        stream.push(0xb8);
        stream.extend(1_u16.to_be_bytes());
        push_position(&mut stream, [0.0, 0.0, 1.0]);
        stream.extend([0, 0, 64]);
        let mut memory = TestMemory::new(1);
        let (raster, _, _) = with_materialized(&stream, &mut memory, |batch| {
            let draw = &batch.draws()[0];
            [
                lane(draw, 0, 4),
                lane(draw, 0, 5),
                lane(draw, 0, 6),
                lane(draw, 0, 7),
            ]
        });
        assert_eq!(raster, [192.0 / 255.0; 4]);
    }

    #[test]
    fn regular_and_dual_post_texgen_preserve_projective_q_and_bp_scaling() {
        let mut stream = base_state(1);
        stream.extend(xf(0x103f, &[1]));
        stream.extend(xf(0x1040, &[0x86]));
        stream.extend(xf_f32(
            9 * 4,
            &[2.0, 0.0, 0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0, 0.0, 4.0, 1.0],
        ));
        stream.extend(xf_f32(
            0x500 + 5 * 4,
            &[1.0, 0.0, 1.0, 0.0, 0.0, 1.0, -1.0, 0.0, 0.0, 0.0, 2.0, 1.0],
        ));
        stream.extend(cp(0x30, 9 << 6));
        stream.extend(cp(0x50, (1 << 9) | (1 << 11)));
        stream.extend(cp(0x70, 1 | (4 << 1) | (4 << 10)));
        let vertex = |stream: &mut Vec<u8>| {
            stream.push(0xb8);
            stream.extend(1_u16.to_be_bytes());
            push_position(stream, [11.0, 12.0, 13.0]);
            for normal in [1.0, 2.0, 3.0] {
                push_f32(stream, normal);
            }
        };
        vertex(&mut stream);
        stream.extend(xf(0x1012, &[1]));
        stream.extend(xf(0x1050, &[5]));
        stream.extend(bp(0x30, 2));
        stream.extend(bp(0x31, 4));
        vertex(&mut stream);
        let mut memory = TestMemory::new(1);
        let (coords, _, _) = with_materialized(&stream, &mut memory, |batch| {
            [
                [
                    lane(&batch.draws()[0], 0, 12),
                    lane(&batch.draws()[0], 0, 13),
                    lane(&batch.draws()[0], 0, 14),
                ],
                [
                    lane(&batch.draws()[1], 0, 12),
                    lane(&batch.draws()[1], 0, 13),
                    lane(&batch.draws()[1], 0, 14),
                ],
            ]
        });
        assert_eq!(coords[0], [2.0, 6.0, 13.0]);
        assert_eq!(coords[1], [45.0, -35.0, 27.0]);
    }

    #[test]
    fn matrix_index_attribute_and_color_texgen_match_browser_carrier() {
        let mut stream = base_state(1);
        stream.extend(xf_f32(
            12,
            &[1.0, 0.0, 0.0, 0.25, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        ));
        stream.extend(xf(0x100e, &[1]));
        stream.extend(xf(0x1010, &[1]));
        stream.extend(xf(0x103f, &[1]));
        stream.extend(xf(0x1040, &[2 << 4]));
        stream.extend(cp(0x50, 1 | (1 << 9) | (1 << 13)));
        stream.extend(cp(0x70, 1 | (4 << 1) | (5 << 14)));
        stream.push(0xb8);
        stream.extend(1_u16.to_be_bytes());
        stream.push(3);
        push_position(&mut stream, [0.0, 0.0, -0.5]);
        stream.extend([64, 128, 192, 255]);

        let mut memory = TestMemory::new(1);
        let (carrier, _, _) = with_materialized(&stream, &mut memory, |batch| {
            let draw = &batch.draws()[0];
            [
                lane(draw, 0, 0),
                lane(draw, 0, 1),
                lane(draw, 0, 12),
                lane(draw, 0, 13),
                lane(draw, 0, 14),
            ]
        });
        assert_eq!(carrier[0..2], [400.0, 264.0]);
        assert_eq!(carrier[2].to_bits(), (64.0_f32 / 255.0).to_bits());
        assert_eq!(carrier[3].to_bits(), (128.0_f32 / 255.0).to_bits());
        assert_eq!(carrier[4], 1.0);
    }

    #[test]
    fn emboss_texgen_uses_prior_stage_and_persistent_nbt_basis() {
        let mut stream = base_state(1);
        stream.extend(xf_f32(0x60a, &[0.0, 0.0, 0.5]));
        stream.extend(xf(0x103f, &[2]));
        stream.extend(xf(0x1040, &[5 << 7, 1 << 4]));
        stream.extend(cp(0x50, (1 << 9) | (1 << 11)));
        stream.extend(cp(0x60, 1));
        stream.extend(cp(
            0x70,
            1 | (4 << 1) | (1 << 9) | (4 << 10) | (1 << 21) | (4 << 22),
        ));
        stream.push(0xb8);
        stream.extend(1_u16.to_be_bytes());
        push_position(&mut stream, [0.0, 0.0, -0.5]);
        for vector in [[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 2.0]] {
            for component in vector {
                push_f32(&mut stream, component);
            }
        }
        push_f32(&mut stream, 0.25);
        push_f32(&mut stream, 0.5);

        stream.extend(cp(0x50, 1 << 9));
        stream.push(0xb8);
        stream.extend(1_u16.to_be_bytes());
        push_position(&mut stream, [0.0, 0.0, -0.5]);
        push_f32(&mut stream, 0.25);
        push_f32(&mut stream, 0.5);

        let mut memory = TestMemory::new(1);
        let (coords, cache, stats) = with_materialized(&stream, &mut memory, |batch| {
            [
                [
                    lane(&batch.draws()[0], 0, 15),
                    lane(&batch.draws()[0], 0, 16),
                    lane(&batch.draws()[0], 0, 17),
                ],
                [
                    lane(&batch.draws()[1], 0, 15),
                    lane(&batch.draws()[1], 0, 16),
                    lane(&batch.draws()[1], 0, 17),
                ],
            ]
        });
        assert_eq!(coords, [[1.25, 2.5, 1.0]; 2]);
        assert_eq!(cache.tangent, [0.0, 0.0, 1.0]);
        assert_eq!(cache.binormal, [0.0, 0.0, 2.0]);
        assert_eq!(stats.normal_cache_commits, 1);
        assert_eq!(stats.cached_normal_uses, 1);
        assert_eq!(stats.cached_tangent_uses, 1);
        assert_eq!(stats.cached_binormal_uses, 1);
    }

    #[test]
    fn perspective_zero_w_uses_required_exact_clip_source_and_finite_carrier() {
        let mut stream = base_state(0);
        stream.extend(cp(0x50, 1 << 9));
        stream.extend(cp(0x70, 1 | (4 << 1)));
        stream.push(0x90);
        stream.extend(3_u16.to_be_bytes());
        for position in [[-0.5, -0.5, 0.0], [0.5, -0.5, 0.0], [0.0, 0.5, 0.0]] {
            push_position(&mut stream, position);
        }
        let mut memory = TestMemory::new(1);
        let ((carrier, clip_w), _, stats) = with_materialized(&stream, &mut memory, |batch| {
            let draw = &batch.draws()[0];
            let MaterializedEvidence::Exact {
                required: true,
                input,
            } = &draw.evidence
            else {
                panic!("required exact input was not emitted");
            };
            (
                [
                    lane(draw, 0, 0),
                    lane(draw, 0, 1),
                    lane(draw, 0, 2),
                    lane(draw, 0, 3),
                ],
                input.position_bits[3],
            )
        });
        assert_eq!(carrier, [0.0, 0.0, 0.0, 1.0]);
        assert_eq!(clip_w, (-0.0_f32).to_bits());
        assert_eq!(stats.projection_fallback_vertices, 3);
        assert_eq!(stats.exact_required_draws, 1);
    }

    #[test]
    fn malformed_reserved_and_unmapped_inputs_fail_closed_without_panics() {
        let mut reserved = base_state(1);
        reserved.extend(cp(0x50, 1 << 9));
        reserved.extend(cp(0x70, 1 | (7 << 1)));
        reserved.push(0x90);
        reserved.extend(3_u16.to_be_bytes());
        reserved.extend([0; 36]);
        let mut memory = TestMemory::new(1);
        let (reason, _, _) =
            with_materialized(&reserved, &mut memory, |batch| match batch.records()[0] {
                MaterializationRecord::Discarded { reason, .. } => reason,
                other => panic!("reserved position unexpectedly materialized: {other:?}"),
            });
        assert_eq!(
            reason,
            VertexDiscardReason::ExactClip(ExactClipFailure::Position)
        );

        let mut unmapped = base_state(1);
        unmapped.extend(cp(0x50, 2 << 9));
        unmapped.extend(cp(0x70, 1 | (4 << 1)));
        unmapped.extend(cp(0xa0, 0x1000));
        unmapped.extend(cp(0xb0, 12));
        unmapped.push(0xb8);
        unmapped.extend(1_u16.to_be_bytes());
        unmapped.push(0);
        let (reason, _, _) =
            with_materialized(&unmapped, &mut memory, |batch| match batch.records()[0] {
                MaterializationRecord::Discarded { reason, .. } => reason,
                other => panic!("unmapped position unexpectedly materialized: {other:?}"),
            });
        assert_eq!(
            reason,
            VertexDiscardReason::PositionAttribute {
                source: Some(MemoryError::Unmapped)
            }
        );
    }

    #[test]
    fn vertex_and_simultaneous_scratch_evidence_limits_fail_before_growth() {
        let mut stream = base_state(1);
        stream.extend(cp(0x50, 1 << 9));
        stream.extend(cp(0x70, 1 | (4 << 1)));
        stream.push(0x90);
        stream.extend(3_u16.to_be_bytes());
        for position in [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.0, 0.5, -0.5]] {
            push_position(&mut stream, position);
        }
        let mut memory = TestMemory::new(1);
        let mut decoder = ResidentGxDecoder::try_new(DecoderLimits::default()).unwrap();
        let decoded = decoder.append(&stream, &mut memory).unwrap();

        let vertex_limits = MaterializerLimits {
            maximum_vertices_per_draw: 2,
            ..MaterializerLimits::default()
        };
        let mut vertex_limited = ResidentVertexMaterializer::try_new(vertex_limits).unwrap();
        assert_eq!(
            vertex_limited
                .materialize_batch(&decoded, &mut memory)
                .unwrap_err(),
            MaterializeError::VertexLimit {
                requested: 3,
                maximum: 2,
            }
        );

        let fixed_bytes = core::mem::size_of::<MaterializationRecord>()
            + core::mem::size_of::<MaterializedDraw>();
        let canonical_bytes = 3 * CANONICAL_VERTEX_BYTES;
        let source_position_bytes = 3 * core::mem::size_of::<[f32; 3]>();
        let matrix_index_bytes = 3 * core::mem::size_of::<u8>();
        let clip_bytes = 3 * core::mem::size_of::<[f32; 4]>();
        let resident_limit =
            fixed_bytes + canonical_bytes + source_position_bytes + matrix_index_bytes + clip_bytes;
        let aggregate_limits = MaterializerLimits {
            maximum_canonical_vertex_bytes_per_draw: canonical_bytes,
            maximum_evidence_bytes_per_draw: 1,
            maximum_resident_bytes: resident_limit,
            ..MaterializerLimits::default()
        };
        let mut aggregate_limited = ResidentVertexMaterializer::try_new(aggregate_limits).unwrap();
        assert_eq!(
            aggregate_limited
                .materialize_batch(&decoded, &mut memory)
                .unwrap_err(),
            MaterializeError::ResidentBytes {
                requested: resident_limit + 1,
                maximum: resident_limit,
            }
        );
    }

    #[test]
    fn ownership_transfer_preserves_order_and_allows_later_batches() {
        let mut first_stream = base_state(1);
        first_stream.extend(cp(0x50, 1 << 9));
        first_stream.extend(cp(0x70, 1 | (4 << 1)));
        first_stream.push(0xb8);
        first_stream.extend(1_u16.to_be_bytes());
        push_position(&mut first_stream, [0.0, 0.0, -0.5]);

        let mut memory = TestMemory::new(1);
        let mut decoder = ResidentGxDecoder::try_new(DecoderLimits::default()).unwrap();
        let first_decoded = decoder.append(&first_stream, &mut memory).unwrap();
        let mut materializer =
            ResidentVertexMaterializer::try_new(MaterializerLimits::default()).unwrap();
        let first_owned = materializer
            .materialize_batch(&first_decoded, &mut memory)
            .unwrap()
            .into_owned();
        drop(first_decoded);

        let mut second_stream = bp(0x60, 0x12_3456);
        second_stream.push(0xb8);
        second_stream.extend(1_u16.to_be_bytes());
        push_position(&mut second_stream, [0.25, 0.0, -0.5]);
        second_stream.extend(bp(0x45, 1));
        second_stream.extend(bp(0xfe, 0xff));
        second_stream.extend(bp(0x47, 0x12_3402));
        second_stream.extend(bp(0x48, 3));
        second_stream.extend(bp(0x52, 0));
        let second_decoded = decoder.append(&second_stream, &mut memory).unwrap();
        let second_owned = materializer
            .materialize_batch(&second_decoded, &mut memory)
            .unwrap()
            .into_owned();

        assert_eq!(first_owned.draws().len(), 1);
        assert!(first_owned.retained_bytes() >= CANONICAL_VERTEX_BYTES);
        assert_eq!(second_owned.draws().len(), 1);
        assert_eq!(
            second_owned.records()[..6],
            [
                MaterializationRecord::TextureState {
                    register: 0x60,
                    value: 0x12_3456,
                },
                MaterializationRecord::Ready {
                    source_draw_index: 0,
                    materialized_draw_index: 0,
                },
                MaterializationRecord::PeState {
                    register: 0x45,
                    value: 1,
                },
                MaterializationRecord::PeState {
                    register: 0xfe,
                    value: 0xff,
                },
                MaterializationRecord::PeState {
                    register: 0x47,
                    value: 2,
                },
                MaterializationRecord::PeState {
                    register: 0x48,
                    value: 3,
                },
            ]
        );
        assert!(matches!(
            second_owned.records()[6],
            MaterializationRecord::Terminal(_)
        ));
        assert_eq!(lane(&second_owned.draws()[0], 0, 0), 400.0);
        assert_eq!(materializer.bp_registers()[0xfe], 0x00ff_ffff);

        let (records, draws, retained_bytes) = first_owned.into_parts();
        assert_eq!(records.len(), 1);
        assert_eq!(draws.len(), 1);
        assert!(retained_bytes >= CANONICAL_VERTEX_BYTES);
    }
}
