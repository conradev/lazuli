//! Host-neutral, resident GX FIFO command decoding.
//!
//! This module is intentionally separate from the legacy native renderer path. It owns the
//! architectural CP/BP/XF state needed to split a command stream at arbitrary byte boundaries,
//! execute nested display lists, and hand typed semantic snapshots to a later resident packet
//! encoder. Browser APIs and packet byte offsets do not belong at this boundary.

use core::fmt;
use core::marker::PhantomData;
use std::vec::Vec;

const CP_REGISTER_COUNT: usize = 0x100;
const BP_REGISTER_COUNT: usize = 0x100;
const XF_REGISTER_COUNT: usize = 0x1058;
const EFB_WIDTH: u32 = 640;
const EFB_HEIGHT: u32 = 528;

/// Hard limits for all guest-amplified storage and work retained by the decoder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecoderLimits {
    pub maximum_carry_bytes: usize,
    pub maximum_display_list_bytes: usize,
    pub maximum_display_list_depth: usize,
    pub maximum_expanded_display_list_bytes: usize,
    pub maximum_records_per_decode: usize,
    pub maximum_vertex_bytes_per_decode: usize,
    /// One ceiling covering carry + all display-list frames + output-owned vertex payloads.
    pub maximum_resident_bytes: usize,
}

impl Default for DecoderLimits {
    fn default() -> Self {
        Self {
            // The browser oracle's largest legal primitive is below 8.5 MiB. Preserve its
            // deliberately conservative corrupt-stream ceiling.
            maximum_carry_bytes: 16 * 1024 * 1024,
            maximum_display_list_bytes: 16 * 1024 * 1024,
            maximum_display_list_depth: 16,
            maximum_expanded_display_list_bytes: 64 * 1024 * 1024,
            maximum_records_per_decode: 65_536,
            maximum_vertex_bytes_per_decode: 16 * 1024 * 1024,
            // The resident machine's measured baseline is about 49 MiB in a 128 MiB memory.
            // Keep guest-amplified GX staging below 32 MiB, leaving ample room for code, packet
            // output, device staging, and allocator fragmentation.
            maximum_resident_bytes: 32 * 1024 * 1024,
        }
    }
}

impl DecoderLimits {
    fn validate(self) -> Result<Self, DecodeError> {
        if self.maximum_carry_bytes == 0 {
            return Err(DecodeError::InvalidLimit("maximum_carry_bytes"));
        }
        if self.maximum_display_list_bytes == 0 {
            return Err(DecodeError::InvalidLimit("maximum_display_list_bytes"));
        }
        if self.maximum_display_list_depth == 0 {
            return Err(DecodeError::InvalidLimit("maximum_display_list_depth"));
        }
        if self.maximum_expanded_display_list_bytes < self.maximum_display_list_bytes {
            return Err(DecodeError::InvalidLimit(
                "maximum_expanded_display_list_bytes",
            ));
        }
        if self.maximum_records_per_decode == 0 {
            return Err(DecodeError::InvalidLimit("maximum_records_per_decode"));
        }
        if self.maximum_vertex_bytes_per_decode == 0 {
            return Err(DecodeError::InvalidLimit("maximum_vertex_bytes_per_decode"));
        }
        if self.maximum_resident_bytes < self.maximum_carry_bytes
            || self.maximum_resident_bytes < self.maximum_display_list_bytes
            || self.maximum_resident_bytes < self.maximum_vertex_bytes_per_decode
        {
            return Err(DecodeError::InvalidLimit("maximum_resident_bytes"));
        }
        if self.maximum_display_list_depth > usize::from(u8::MAX) {
            return Err(DecodeError::InvalidLimit("maximum_display_list_depth"));
        }
        Ok(self)
    }
}

/// A bounded, pointer-free guest-memory read used by CALL_DL and indexed XF loads.
pub trait GxMemory {
    fn read_exact(&mut self, address: u32, destination: &mut [u8]) -> Result<(), MemoryError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryError {
    Unmapped,
    OutOfBounds,
    Rejected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AllocationSite {
    Carry,
    DisplayList,
    DisplayListStack,
    OutputRecords,
    DrawSnapshots,
    VertexPayload,
    RegisterFile,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecodeError {
    InvalidLimit(&'static str),
    CarryOverflow {
        requested: usize,
        maximum: usize,
    },
    DisplayListTooLarge {
        requested: u32,
        maximum: usize,
    },
    DisplayListDepth {
        maximum: usize,
    },
    DisplayListExpansion {
        requested: usize,
        maximum: usize,
    },
    RecursiveDisplayList {
        address: u32,
        length: u32,
    },
    DisplayListRead {
        address: u32,
        length: u32,
        source: MemoryError,
    },
    IndexedXfRead {
        address: u32,
        length: u32,
        source: MemoryError,
    },
    TruncatedDisplayList {
        address: u32,
        cursor: usize,
        required: usize,
        available: usize,
    },
    XfRange {
        start: u16,
        count: u8,
    },
    VertexByteOverflow {
        vertices: u16,
        bytes_per_vertex: u16,
    },
    OutputRecordLimit {
        maximum: usize,
    },
    OutputVertexBytes {
        requested: usize,
        maximum: usize,
    },
    ResidentBytes {
        requested: usize,
        maximum: usize,
    },
    Allocation {
        site: AllocationSite,
    },
    TerminalSequenceOverflow,
    TerminalGenerationOverflow(TerminalKind),
    BarrierPending {
        sequence: u64,
        class: BarrierClass,
    },
    BarrierMismatch {
        expected: u64,
        received: u64,
    },
    InvalidEfbPeekAddress(u32),
}

impl fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLimit(name) => write!(formatter, "invalid resident GX limit {name}"),
            Self::CarryOverflow { requested, maximum } => write!(
                formatter,
                "resident GX FIFO carry overflow: {requested} > {maximum}"
            ),
            Self::DisplayListTooLarge { requested, maximum } => write!(
                formatter,
                "resident GX display list is too large: {requested} > {maximum}"
            ),
            Self::DisplayListDepth { maximum } => {
                write!(
                    formatter,
                    "resident GX display-list depth exceeds {maximum}"
                )
            }
            Self::DisplayListExpansion { requested, maximum } => write!(
                formatter,
                "resident GX expanded display-list bytes exceed bound: {requested} > {maximum}"
            ),
            Self::RecursiveDisplayList { address, length } => write!(
                formatter,
                "recursive resident GX display list at {address:#010x} ({length} bytes)"
            ),
            Self::DisplayListRead {
                address,
                length,
                source,
            } => write!(
                formatter,
                "resident GX display-list read failed at {address:#010x} ({length} bytes): {source:?}"
            ),
            Self::IndexedXfRead {
                address,
                length,
                source,
            } => write!(
                formatter,
                "resident GX indexed-XF read failed at {address:#010x} ({length} bytes): {source:?}"
            ),
            Self::TruncatedDisplayList {
                address,
                cursor,
                required,
                available,
            } => write!(
                formatter,
                "truncated resident GX display list {address:#010x} at {cursor}: needs {required}, has {available}"
            ),
            Self::XfRange { start, count } => {
                write!(
                    formatter,
                    "resident GX XF range is invalid: {start:#06x} + {count}"
                )
            }
            Self::VertexByteOverflow {
                vertices,
                bytes_per_vertex,
            } => write!(
                formatter,
                "resident GX primitive byte count overflows: {vertices} * {bytes_per_vertex}"
            ),
            Self::OutputRecordLimit { maximum } => {
                write!(
                    formatter,
                    "resident GX decode record bound {maximum} exceeded"
                )
            }
            Self::OutputVertexBytes { requested, maximum } => write!(
                formatter,
                "resident GX decoded vertex payload bound exceeded: {requested} > {maximum}"
            ),
            Self::ResidentBytes { requested, maximum } => write!(
                formatter,
                "resident GX aggregate retained-byte bound exceeded: {requested} > {maximum}"
            ),
            Self::Allocation { site } => {
                write!(formatter, "resident GX allocation failed for {site:?}")
            }
            Self::TerminalSequenceOverflow => {
                formatter.write_str("resident GX terminal sequence overflow")
            }
            Self::TerminalGenerationOverflow(kind) => {
                write!(formatter, "resident GX {kind:?} generation overflow")
            }
            Self::BarrierPending { sequence, class } => {
                write!(
                    formatter,
                    "resident GX {class:?} barrier {sequence} is pending"
                )
            }
            Self::BarrierMismatch { expected, received } => write!(
                formatter,
                "resident GX barrier acknowledgement mismatch: expected {expected}, got {received}"
            ),
            Self::InvalidEfbPeekAddress(address) => {
                write!(
                    formatter,
                    "invalid resident GX EFB peek address {address:#010x}"
                )
            }
        }
    }
}

impl std::error::Error for DecodeError {}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VertexFormatIssues(u16);

impl VertexFormatIssues {
    pub const POSITION_FORMAT: u16 = 1 << 0;
    pub const NORMAL_FORMAT: u16 = 1 << 1;
    pub const COLOR0_FORMAT: u16 = 1 << 2;
    pub const COLOR1_FORMAT: u16 = 1 << 3;
    pub const TEXCOORD0_FORMAT: u16 = 1 << 4;

    pub const fn bits(self) -> u16 {
        self.0
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    fn insert(&mut self, bit: u16) {
        self.0 |= bit;
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VertexFormatSnapshot {
    pub matrix_index_a: u32,
    pub matrix_index_b: u32,
    pub vcd_low: u32,
    pub vcd_high: u32,
    pub vat_a: u32,
    pub vat_b: u32,
    pub vat_c: u32,
    pub bytes_per_vertex: u16,
    pub issues: VertexFormatIssues,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextureRegisterSnapshot {
    pub mode0: u32,
    pub mode1: u32,
    pub image0: u32,
    pub image1: u32,
    pub image2: u32,
    pub image3: u32,
    pub tlut: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TevStageSnapshot {
    pub color_combiner: u32,
    pub alpha_combiner: u32,
    pub texture_map: u8,
    pub texture_coord: u8,
    pub texture_enabled: bool,
    pub color_channel: u8,
    pub konst_color_selector: u8,
    pub konst_alpha_selector: u8,
}

/// Structured equivalent of the exact TEV snapshot consumed by the packet layer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TevSnapshot {
    pub stages: [TevStageSnapshot; 16],
    pub stage_count: u8,
    pub color_registers: [[i32; 4]; 4],
    pub konst_registers: [[i32; 4]; 4],
    pub swap_tables: [[u8; 4]; 4],
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct IndirectTevSnapshot {
    pub gen_mode: u32,
    pub xf_num_tex_gens: u32,
    pub matrices: [u32; 9],
    pub imask: u32,
    pub commands: [u32; 16],
    pub tex_scales: [u32; 2],
    pub iref: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExactRasterSnapshot {
    pub bp_gen_mode: u32,
    pub bp_scissor_top_left: u32,
    pub bp_scissor_bottom_right: u32,
    pub bp_scissor_offset: u32,
    pub xf_clip_disable: u32,
    pub viewport_bits: [u32; 6],
    pub projection_bits: [u32; 6],
    pub projection_type: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PipelineSnapshot {
    pub z_mode: u32,
    pub blend_mode: u32,
    pub alpha_test: u32,
    pub cull_mode: u8,
    pub scissor_x: u32,
    pub scissor_y: u32,
    pub scissor_width: u32,
    pub scissor_height: u32,
    pub pixel_control: u32,
    pub constant_alpha: u32,
    pub z_texture_bias: u32,
    pub z_texture_mode: u32,
    pub fog_range_base: u32,
    pub fog_range_k: [u32; 5],
    pub fog_words: [u32; 5],
    pub viewport_half_width_bits: u32,
    pub indirect_tev: IndirectTevSnapshot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextureUseKind {
    Direct,
    Indirect { stage: u8 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextureUse {
    pub kind: TextureUseKind,
    pub tev_stage: u8,
    pub texture_map: u8,
    pub requested_tex_coord: u8,
    pub effective_tex_coord: Option<u8>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextureUseOrder {
    entries: [Option<TextureUse>; 32],
    len: u8,
}

impl TextureUseOrder {
    pub fn as_slice(&self) -> &[Option<TextureUse>] {
        &self.entries[..usize::from(self.len)]
    }

    pub const fn len(&self) -> usize {
        self.len as usize
    }

    pub const fn is_empty(&self) -> bool {
        self.len == 0
    }

    fn push(&mut self, value: TextureUse) {
        let index = usize::from(self.len);
        if index < self.entries.len() {
            self.entries[index] = Some(value);
            self.len += 1;
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayloadOwnership {
    /// The payload is uniquely owned by resident Rust and can be moved into the next stage.
    ResidentOwned,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrawSnapshot {
    pub opcode: u8,
    pub topology: u8,
    pub vat_index: u8,
    pub vertex_count: u16,
    pub format: VertexFormatSnapshot,
    pub encoded_vertices: Vec<u8>,
    pub payload_ownership: PayloadOwnership,
    pub pipeline: PipelineSnapshot,
    pub exact_raster: ExactRasterSnapshot,
    pub tev: TevSnapshot,
    pub textures: [TextureRegisterSnapshot; 8],
    pub texture_use_order: TextureUseOrder,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CopyStateSnapshot {
    pub z_mode: u32,
    pub blend_mode: u32,
    pub pixel_control: u32,
    pub copy_command: u32,
    pub clear_rgba: [u8; 4],
    pub clear_depth: u32,
    pub copy_scale: u32,
    pub copy_filter: [u32; 2],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalKind {
    TextureCopy,
    XfbCopy,
    EfbPeek,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BarrierClass {
    TextureCopyReceipt,
    EfbPeekReceipt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextureCopyLayout {
    pub copy_format: u8,
    pub base_format: u8,
    pub block_width: u8,
    pub block_height: u8,
    pub block_bytes: u8,
    pub row_bytes: u32,
    pub row_count: u32,
    pub byte_length: u32,
    pub direct_compatible: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalSnapshot {
    pub sequence: u64,
    pub kind: TerminalKind,
    pub barrier: Option<BarrierClass>,
    pub source_x: u32,
    pub source_y: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub destination: u32,
    pub stride: u32,
    pub generation: u32,
    pub clear: bool,
    pub copy: CopyStateSnapshot,
    pub texture_layout: Option<TextureCopyLayout>,
    pub no_op: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SemanticRecord {
    CpLoad {
        register: u8,
        value: u32,
    },
    XfLoad {
        start: u16,
        count: u8,
        values: [u32; 16],
    },
    IndexedXfLoad {
        opcode: u8,
        start: u16,
        count: u8,
        index: u16,
        values: [u32; 16],
    },
    BpLoad {
        register: u8,
        value: u32,
    },
    DisplayListCall {
        address: u32,
        length: u32,
        depth: u8,
    },
    InvalidateVertexCache,
    Draw {
        draw_index: u32,
    },
    Terminal(TerminalSnapshot),
    UnsupportedOpcode {
        opcode: u8,
        in_display_list: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeStatus {
    Drained,
    NeedMore { command_bytes: usize },
    Blocked { sequence: u64, class: BarrierClass },
}

/// One decode's owned semantic output.
///
/// The mutable-decoder lifetime is deliberate: a caller cannot ask the same decoder to retain
/// more guest payload while a previous batch is live. Aggregate byte accounting therefore has
/// exactly one output-owned vertex payload to include. Consume/materialize the batch and release
/// it before calling [`ResidentGxDecoder::append`] or resuming a receipt barrier.
#[derive(Debug, PartialEq, Eq)]
pub struct DecodeBatch<'decoder> {
    records: Vec<SemanticRecord>,
    draws: Vec<DrawSnapshot>,
    resident_vertex_bytes: usize,
    retained_bytes: usize,
    pub status: DecodeStatus,
    decoder_lease: PhantomData<&'decoder mut ResidentGxDecoder>,
}

impl DecodeBatch<'_> {
    fn new() -> Self {
        Self {
            records: Vec::new(),
            draws: Vec::new(),
            resident_vertex_bytes: 0,
            retained_bytes: 0,
            status: DecodeStatus::Drained,
            decoder_lease: PhantomData,
        }
    }

    pub fn records(&self) -> &[SemanticRecord] {
        &self.records
    }

    pub fn draws(&self) -> &[DrawSnapshot] {
        &self.draws
    }

    pub fn draw(&self, index: u32) -> Option<&DrawSnapshot> {
        self.draws.get(index as usize)
    }

    pub const fn resident_vertex_bytes(&self) -> usize {
        self.resident_vertex_bytes
    }

    fn reserve_records(
        &mut self,
        count: usize,
        limits: DecoderLimits,
        decoder_retained_bytes: usize,
    ) -> Result<(), DecodeError> {
        let requested =
            self.records
                .len()
                .checked_add(count)
                .ok_or(DecodeError::OutputRecordLimit {
                    maximum: limits.maximum_records_per_decode,
                })?;
        if requested > limits.maximum_records_per_decode {
            return Err(DecodeError::OutputRecordLimit {
                maximum: limits.maximum_records_per_decode,
            });
        }
        let record_bytes = count
            .checked_mul(core::mem::size_of::<SemanticRecord>())
            .ok_or(DecodeError::ResidentBytes {
                requested: usize::MAX,
                maximum: limits.maximum_resident_bytes,
            })?;
        let retained_bytes =
            self.retained_bytes
                .checked_add(record_bytes)
                .ok_or(DecodeError::ResidentBytes {
                    requested: usize::MAX,
                    maximum: limits.maximum_resident_bytes,
                })?;
        let aggregate = decoder_retained_bytes.checked_add(retained_bytes).ok_or(
            DecodeError::ResidentBytes {
                requested: usize::MAX,
                maximum: limits.maximum_resident_bytes,
            },
        )?;
        if aggregate > limits.maximum_resident_bytes {
            return Err(DecodeError::ResidentBytes {
                requested: aggregate,
                maximum: limits.maximum_resident_bytes,
            });
        }
        self.records
            .try_reserve_exact(count)
            .map_err(|_| DecodeError::Allocation {
                site: AllocationSite::OutputRecords,
            })?;
        self.retained_bytes = retained_bytes;
        Ok(())
    }

    fn push_reserved(&mut self, record: SemanticRecord) {
        self.records.push(record);
    }

    fn reserve_vertex_bytes(
        &mut self,
        additional: usize,
        limits: DecoderLimits,
    ) -> Result<(), DecodeError> {
        let requested = self.resident_vertex_bytes.checked_add(additional).ok_or(
            DecodeError::OutputVertexBytes {
                requested: usize::MAX,
                maximum: limits.maximum_vertex_bytes_per_decode,
            },
        )?;
        if requested > limits.maximum_vertex_bytes_per_decode {
            return Err(DecodeError::OutputVertexBytes {
                requested,
                maximum: limits.maximum_vertex_bytes_per_decode,
            });
        }
        self.resident_vertex_bytes = requested;
        Ok(())
    }

    fn reserve_draw(
        &mut self,
        vertex_bytes: usize,
        limits: DecoderLimits,
        decoder_retained_bytes: usize,
    ) -> Result<u32, DecodeError> {
        self.reserve_vertex_bytes(vertex_bytes, limits)?;
        let draw_bytes = core::mem::size_of::<DrawSnapshot>()
            .checked_add(vertex_bytes)
            .ok_or(DecodeError::ResidentBytes {
                requested: usize::MAX,
                maximum: limits.maximum_resident_bytes,
            })?;
        let retained_bytes =
            self.retained_bytes
                .checked_add(draw_bytes)
                .ok_or(DecodeError::ResidentBytes {
                    requested: usize::MAX,
                    maximum: limits.maximum_resident_bytes,
                })?;
        let aggregate = decoder_retained_bytes.checked_add(retained_bytes).ok_or(
            DecodeError::ResidentBytes {
                requested: usize::MAX,
                maximum: limits.maximum_resident_bytes,
            },
        )?;
        if aggregate > limits.maximum_resident_bytes {
            return Err(DecodeError::ResidentBytes {
                requested: aggregate,
                maximum: limits.maximum_resident_bytes,
            });
        }
        self.draws
            .try_reserve_exact(1)
            .map_err(|_| DecodeError::Allocation {
                site: AllocationSite::DrawSnapshots,
            })?;
        let index =
            u32::try_from(self.draws.len()).map_err(|_| DecodeError::OutputRecordLimit {
                maximum: limits.maximum_records_per_decode,
            })?;
        self.retained_bytes = retained_bytes;
        Ok(index)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DecoderStats {
    pub appended_bytes: u64,
    pub decoded_commands: u64,
    pub no_ops: u64,
    pub invalidations: u64,
    pub cp_loads: u64,
    pub xf_loads: u64,
    pub indexed_xf_loads: u64,
    pub bp_loads: u64,
    pub display_list_calls: u64,
    pub display_list_bytes: u64,
    pub primitives: u64,
    pub vertices: u64,
    pub unsupported_opcodes: u64,
    pub compactions: u64,
    pub barrier_stops: u64,
    pub barrier_resumes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EfbPeekRequest {
    pub physical_address: u32,
    pub alpha_read_mode: u8,
    /// True when an earlier renderer terminal must retire before this load can be packaged.
    pub earlier_renderer_terminal: bool,
}

/// Canonical interpretation of one aligned physical EFB aperture word.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EfbPeekAddress {
    ImmediateZero { combined_plane: bool },
    Pixel { x: u32, y: u32, plane: u32 },
}

/// Decodes the browser-compatible EFB aperture without changing FIFO or renderer state.
pub fn classify_efb_peek_address(physical: u32) -> Result<EfbPeekAddress, DecodeError> {
    if (physical & 0xf800_0000) != 0x0800_0000
        || physical >= 0x0c00_0000
        || !physical.is_multiple_of(4)
    {
        return Err(DecodeError::InvalidEfbPeekAddress(physical));
    }

    let x = (physical & 0x0fff) >> 2;
    let y = (physical >> 12) & 0x03ff;
    let combined_plane = physical & 0x0080_0000 != 0;
    if combined_plane || x >= EFB_WIDTH || y >= EFB_HEIGHT {
        return Ok(EfbPeekAddress::ImmediateZero { combined_plane });
    }
    Ok(EfbPeekAddress::Pixel {
        x,
        y,
        plane: u32::from(physical & 0x0040_0000 != 0),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EfbPeekResult {
    ImmediateZero { combined_plane: bool },
    YieldForEarlierTerminal,
    Terminal(TerminalSnapshot),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PendingBarrier {
    sequence: u64,
    class: BarrierClass,
}

#[derive(Clone, Debug)]
struct DisplayListFrame {
    address: u32,
    declared_length: u32,
    bytes: Vec<u8>,
    cursor: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PlannedCommand {
    NoOp(u8),
    Invalidate,
    Cp {
        register: u8,
        value: u32,
    },
    Xf {
        start: u16,
        count: u8,
    },
    IndexedXf {
        opcode: u8,
        word: u32,
    },
    Call {
        address: u32,
        length: u32,
    },
    Bp {
        word: u32,
    },
    Draw {
        opcode: u8,
        vertices: u16,
        format: VertexFormatSnapshot,
    },
    Unsupported(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CommandPlan {
    bytes: usize,
    command: PlannedCommand,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Preflight {
    Ready(CommandPlan),
    Incomplete { required: usize },
}

/// Incremental, resident GX command state.
#[derive(Clone, Debug)]
pub struct ResidentGxDecoder {
    limits: DecoderLimits,
    carry: Vec<u8>,
    carry_cursor: usize,
    retry_at_command_bytes: usize,
    display_lists: Vec<DisplayListFrame>,
    active_display_list_bytes: usize,
    cp: [u32; CP_REGISTER_COUNT],
    bp: [u32; BP_REGISTER_COUNT],
    xf: Vec<u32>,
    tev_color: [[i32; 4]; 4],
    tev_konst: [[i32; 4]; 4],
    pending_barrier: Option<PendingBarrier>,
    terminal_sequence: u64,
    texture_copy_generation: u32,
    xfb_copy_generation: u32,
    efb_peek_generation: u32,
    stats: DecoderStats,
}

impl ResidentGxDecoder {
    pub fn try_new(limits: DecoderLimits) -> Result<Self, DecodeError> {
        let limits = limits.validate()?;
        let mut xf = Vec::new();
        xf.try_reserve_exact(XF_REGISTER_COUNT)
            .map_err(|_| DecodeError::Allocation {
                site: AllocationSite::RegisterFile,
            })?;
        xf.resize(XF_REGISTER_COUNT, 0);
        let mut decoder = Self {
            limits,
            carry: Vec::new(),
            carry_cursor: 0,
            retry_at_command_bytes: 1,
            display_lists: Vec::new(),
            active_display_list_bytes: 0,
            cp: [0; CP_REGISTER_COUNT],
            bp: [0; BP_REGISTER_COUNT],
            xf,
            tev_color: [[0; 4]; 4],
            tev_konst: [[0; 4]; 4],
            pending_barrier: None,
            terminal_sequence: 0,
            texture_copy_generation: 0,
            xfb_copy_generation: 0,
            efb_peek_generation: 0,
            stats: DecoderStats::default(),
        };
        decoder.bp[0xf3] = 0x003f_0000;
        decoder.bp[0xfe] = 0x00ff_ffff;
        Ok(decoder)
    }

    pub fn limits(&self) -> DecoderLimits {
        self.limits
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

    pub fn stats(&self) -> DecoderStats {
        self.stats
    }

    pub fn buffered_bytes(&self) -> usize {
        self.carry.len().saturating_sub(self.carry_cursor)
    }

    pub fn retry_at_command_bytes(&self) -> usize {
        self.retry_at_command_bytes
    }

    pub fn display_list_depth(&self) -> usize {
        self.display_lists.len()
    }

    pub fn pending_barrier(&self) -> Option<(u64, BarrierClass)> {
        self.pending_barrier
            .map(|barrier| (barrier.sequence, barrier.class))
    }
}

impl ResidentGxDecoder {
    /// Appends one arbitrary FIFO fragment and decodes every complete ordered command available.
    ///
    /// The whole append is preflighted before the carry or diagnostics change. While a receipt
    /// barrier is pending, callers must acknowledge it rather than accumulating hidden suffixes.
    pub fn append<M: GxMemory>(
        &mut self,
        source: &[u8],
        memory: &mut M,
    ) -> Result<DecodeBatch<'_>, DecodeError> {
        if let Some(barrier) = self.pending_barrier {
            return Err(DecodeError::BarrierPending {
                sequence: barrier.sequence,
                class: barrier.class,
            });
        }

        self.compact_carry_if_possible();
        let requested =
            self.carry
                .len()
                .checked_add(source.len())
                .ok_or(DecodeError::CarryOverflow {
                    requested: usize::MAX,
                    maximum: self.limits.maximum_carry_bytes,
                })?;
        if requested > self.limits.maximum_carry_bytes {
            return Err(DecodeError::CarryOverflow {
                requested,
                maximum: self.limits.maximum_carry_bytes,
            });
        }
        self.preflight_resident_bytes(
            self.carry.capacity().max(requested),
            self.active_display_list_bytes,
            0,
        )?;
        self.carry
            .try_reserve_exact(source.len())
            .map_err(|_| DecodeError::Allocation {
                site: AllocationSite::Carry,
            })?;
        self.preflight_resident_bytes(self.carry.capacity(), self.active_display_list_bytes, 0)?;
        self.carry.extend_from_slice(source);
        self.stats.appended_bytes = self
            .stats
            .appended_bytes
            .saturating_add(source.len() as u64);
        self.decode_available(memory)
    }

    /// Decodes already-retained bytes without appending new input.
    pub fn resume<M: GxMemory>(&mut self, memory: &mut M) -> Result<DecodeBatch<'_>, DecodeError> {
        if let Some(barrier) = self.pending_barrier {
            return Err(DecodeError::BarrierPending {
                sequence: barrier.sequence,
                class: barrier.class,
            });
        }
        self.decode_available(memory)
    }

    /// Commits the exact outstanding receipt and resumes a retained display-list/FIFO suffix.
    pub fn acknowledge_terminal<M: GxMemory>(
        &mut self,
        sequence: u64,
        memory: &mut M,
    ) -> Result<DecodeBatch<'_>, DecodeError> {
        let Some(barrier) = self.pending_barrier else {
            return Err(DecodeError::BarrierMismatch {
                expected: 0,
                received: sequence,
            });
        };
        if barrier.sequence != sequence {
            return Err(DecodeError::BarrierMismatch {
                expected: barrier.sequence,
                received: sequence,
            });
        }
        self.pending_barrier = None;
        self.stats.barrier_resumes = self.stats.barrier_resumes.saturating_add(1);
        self.decode_available(memory)
    }

    /// Converts a translated EFB aperture load into either an immediate zero, an ordering yield,
    /// or the canonical one-pixel renderer terminal used by the browser oracle.
    pub fn request_efb_peek(
        &mut self,
        request: EfbPeekRequest,
    ) -> Result<EfbPeekResult, DecodeError> {
        let physical = request.physical_address;
        let (x, y, plane) = match classify_efb_peek_address(physical)? {
            EfbPeekAddress::ImmediateZero { combined_plane } => {
                return Ok(EfbPeekResult::ImmediateZero { combined_plane });
            }
            EfbPeekAddress::Pixel { x, y, plane } => (x, y, plane),
        };
        if request.earlier_renderer_terminal || self.pending_barrier.is_some() {
            return Ok(EfbPeekResult::YieldForEarlierTerminal);
        }

        let sequence = self.next_terminal_sequence()?;
        self.efb_peek_generation = self.efb_peek_generation.checked_add(1).ok_or(
            DecodeError::TerminalGenerationOverflow(TerminalKind::EfbPeek),
        )?;
        let alpha_read_mode = if request.alpha_read_mode <= 2 {
            request.alpha_read_mode
        } else {
            0
        };
        let terminal = TerminalSnapshot {
            sequence,
            kind: TerminalKind::EfbPeek,
            barrier: Some(BarrierClass::EfbPeekReceipt),
            source_x: x,
            source_y: y,
            source_width: 1,
            source_height: 1,
            output_width: 0,
            output_height: 0,
            destination: plane,
            stride: u32::from(alpha_read_mode),
            generation: self.efb_peek_generation,
            clear: false,
            copy: CopyStateSnapshot {
                pixel_control: self.bp[0x43],
                ..CopyStateSnapshot::default()
            },
            texture_layout: None,
            no_op: false,
        };
        self.pending_barrier = Some(PendingBarrier {
            sequence,
            class: BarrierClass::EfbPeekReceipt,
        });
        self.stats.barrier_stops = self.stats.barrier_stops.saturating_add(1);
        Ok(EfbPeekResult::Terminal(terminal))
    }

    fn decode_available<M: GxMemory>(
        &mut self,
        memory: &mut M,
    ) -> Result<DecodeBatch<'_>, DecodeError> {
        let mut output = DecodeBatch::new();
        loop {
            if let Some(barrier) = self.pending_barrier {
                output.status = DecodeStatus::Blocked {
                    sequence: barrier.sequence,
                    class: barrier.class,
                };
                return Ok(output);
            }

            if self.current_available() == 0 {
                if self.display_lists.is_empty() {
                    // `clear` would invisibly retain a guest-sized allocation. Drop the backing
                    // store once the top-level stream drains so the next slice starts from zero.
                    self.carry = Vec::new();
                    self.carry_cursor = 0;
                    self.retry_at_command_bytes = 1;
                    output.status = DecodeStatus::Drained;
                    return Ok(output);
                }
                self.pop_display_list();
                continue;
            }

            let preflight = self.preflight_current()?;
            let plan = match preflight {
                Preflight::Ready(plan) => plan,
                Preflight::Incomplete { required } => {
                    if let Some(frame) = self.display_lists.last() {
                        return Err(DecodeError::TruncatedDisplayList {
                            address: frame.address,
                            cursor: frame.cursor,
                            required,
                            available: frame.bytes.len().saturating_sub(frame.cursor),
                        });
                    }
                    self.retry_at_command_bytes = required;
                    self.compact_carry_if_possible();
                    output.status = DecodeStatus::NeedMore {
                        command_bytes: required,
                    };
                    return Ok(output);
                }
            };

            self.execute_plan(plan, memory, &mut output)?;
        }
    }

    fn preflight_current(&self) -> Result<Preflight, DecodeError> {
        let source = self.current_slice();
        let Some(&opcode) = source.first() else {
            return Ok(Preflight::Incomplete { required: 1 });
        };
        let ready = |bytes, command| Preflight::Ready(CommandPlan { bytes, command });
        let preflight = match opcode {
            0x00 | 0x01 | 0x44 => ready(1, PlannedCommand::NoOp(opcode)),
            0x48 => ready(1, PlannedCommand::Invalidate),
            0x08 => {
                if source.len() < 6 {
                    Preflight::Incomplete { required: 6 }
                } else {
                    ready(
                        6,
                        PlannedCommand::Cp {
                            register: source[1],
                            value: read_be_u32(source, 2),
                        },
                    )
                }
            }
            0x10 => {
                if source.len() < 5 {
                    Preflight::Incomplete { required: 5 }
                } else {
                    let command = read_be_u32(source, 1);
                    let count = (((command >> 16) & 0x0f) + 1) as u8;
                    let bytes = 5 + usize::from(count) * 4;
                    if source.len() < bytes {
                        Preflight::Incomplete { required: bytes }
                    } else {
                        let start = command as u16;
                        validate_xf_range(start, count)?;
                        ready(bytes, PlannedCommand::Xf { start, count })
                    }
                }
            }
            0x20 | 0x28 | 0x30 | 0x38 => {
                if source.len() < 5 {
                    Preflight::Incomplete { required: 5 }
                } else {
                    let word = read_be_u32(source, 1);
                    let start = (word & 0x0fff) as u16;
                    let count = (((word >> 12) & 0x0f) + 1) as u8;
                    validate_xf_range(start, count)?;
                    ready(5, PlannedCommand::IndexedXf { opcode, word })
                }
            }
            0x40 => {
                if source.len() < 9 {
                    Preflight::Incomplete { required: 9 }
                } else {
                    ready(
                        9,
                        PlannedCommand::Call {
                            address: read_be_u32(source, 1),
                            length: read_be_u32(source, 5),
                        },
                    )
                }
            }
            0x61 => {
                if source.len() < 5 {
                    Preflight::Incomplete { required: 5 }
                } else {
                    ready(
                        5,
                        PlannedCommand::Bp {
                            word: read_be_u32(source, 1),
                        },
                    )
                }
            }
            _ if opcode & 0xc0 == 0x80 => {
                if source.len() < 3 {
                    Preflight::Incomplete { required: 3 }
                } else {
                    let vertices = read_be_u16(source, 1);
                    let format = self.vertex_format(opcode & 7);
                    let payload_bytes = usize::from(vertices)
                        .checked_mul(usize::from(format.bytes_per_vertex))
                        .ok_or(DecodeError::VertexByteOverflow {
                            vertices,
                            bytes_per_vertex: format.bytes_per_vertex,
                        })?;
                    let bytes = 3usize.checked_add(payload_bytes).ok_or(
                        DecodeError::VertexByteOverflow {
                            vertices,
                            bytes_per_vertex: format.bytes_per_vertex,
                        },
                    )?;
                    if source.len() < bytes {
                        Preflight::Incomplete { required: bytes }
                    } else {
                        ready(
                            bytes,
                            PlannedCommand::Draw {
                                opcode,
                                vertices,
                                format,
                            },
                        )
                    }
                }
            }
            _ => ready(1, PlannedCommand::Unsupported(opcode)),
        };
        Ok(preflight)
    }

    fn execute_plan<M: GxMemory>(
        &mut self,
        plan: CommandPlan,
        memory: &mut M,
        output: &mut DecodeBatch<'_>,
    ) -> Result<(), DecodeError> {
        match plan.command {
            PlannedCommand::NoOp(_opcode) => {
                self.advance_current(plan.bytes);
                self.stats.no_ops = self.stats.no_ops.saturating_add(1);
            }
            PlannedCommand::Invalidate => {
                self.reserve_output_records(output, 1)?;
                self.advance_current(plan.bytes);
                output.push_reserved(SemanticRecord::InvalidateVertexCache);
                self.stats.invalidations = self.stats.invalidations.saturating_add(1);
            }
            PlannedCommand::Cp { register, value } => {
                self.reserve_output_records(output, 1)?;
                self.cp[usize::from(register)] = value;
                self.advance_current(plan.bytes);
                output.push_reserved(SemanticRecord::CpLoad { register, value });
                self.stats.cp_loads = self.stats.cp_loads.saturating_add(1);
            }
            PlannedCommand::Xf { start, count } => {
                let mut values = [0; 16];
                {
                    let source = self.current_slice();
                    for (index, value) in values.iter_mut().enumerate().take(usize::from(count)) {
                        *value = read_be_u32(source, 5 + index * 4);
                    }
                }
                self.reserve_output_records(output, 1)?;
                let start_index = usize::from(start);
                let count_index = usize::from(count);
                self.xf[start_index..start_index + count_index]
                    .copy_from_slice(&values[..count_index]);
                self.advance_current(plan.bytes);
                output.push_reserved(SemanticRecord::XfLoad {
                    start,
                    count,
                    values,
                });
                self.stats.xf_loads = self.stats.xf_loads.saturating_add(1);
            }
            PlannedCommand::IndexedXf { opcode, word } => {
                self.execute_indexed_xf(opcode, word, plan.bytes, memory, output)?;
            }
            PlannedCommand::Call { address, length } => {
                self.execute_call(address, length, plan.bytes, memory, output)?;
            }
            PlannedCommand::Bp { word } => {
                self.execute_bp(word, plan.bytes, output)?;
            }
            PlannedCommand::Draw {
                opcode,
                vertices,
                format,
            } => {
                self.execute_draw(opcode, vertices, format, plan.bytes, output)?;
            }
            PlannedCommand::Unsupported(opcode) => {
                self.reserve_output_records(output, 1)?;
                let in_display_list = !self.display_lists.is_empty();
                self.advance_current(plan.bytes);
                output.push_reserved(SemanticRecord::UnsupportedOpcode {
                    opcode,
                    in_display_list,
                });
                self.stats.unsupported_opcodes = self.stats.unsupported_opcodes.saturating_add(1);
            }
        }
        self.stats.decoded_commands = self.stats.decoded_commands.saturating_add(1);
        self.retry_at_command_bytes = 1;
        Ok(())
    }

    fn execute_indexed_xf<M: GxMemory>(
        &mut self,
        opcode: u8,
        word: u32,
        command_bytes: usize,
        memory: &mut M,
        output: &mut DecodeBatch<'_>,
    ) -> Result<(), DecodeError> {
        let reference_array = usize::from(opcode >> 3) + 8;
        let index = (word >> 16) as u16;
        let start = (word & 0x0fff) as u16;
        let count = (((word >> 12) & 0x0f) + 1) as u8;
        validate_xf_range(start, count)?;
        let base = self.cp[0xa0 + reference_array];
        let stride = self.cp[0xb0 + reference_array] & 0xff;
        let address = base.wrapping_add(stride.wrapping_mul(u32::from(index)));
        let byte_count = u32::from(count) * 4;
        let mut encoded = [0_u8; 64];
        memory
            .read_exact(address, &mut encoded[..byte_count as usize])
            .map_err(|source| DecodeError::IndexedXfRead {
                address,
                length: byte_count,
                source,
            })?;
        let mut values = [0; 16];
        for (value_index, value) in values.iter_mut().enumerate().take(usize::from(count)) {
            *value = read_be_u32(&encoded, value_index * 4);
        }
        self.reserve_output_records(output, 1)?;
        let start_index = usize::from(start);
        let count_index = usize::from(count);
        self.xf[start_index..start_index + count_index].copy_from_slice(&values[..count_index]);
        self.advance_current(command_bytes);
        output.push_reserved(SemanticRecord::IndexedXfLoad {
            opcode,
            start,
            count,
            index,
            values,
        });
        self.stats.indexed_xf_loads = self.stats.indexed_xf_loads.saturating_add(1);
        Ok(())
    }

    fn execute_call<M: GxMemory>(
        &mut self,
        address: u32,
        length: u32,
        command_bytes: usize,
        memory: &mut M,
        output: &mut DecodeBatch<'_>,
    ) -> Result<(), DecodeError> {
        let length_usize =
            usize::try_from(length).map_err(|_| DecodeError::DisplayListTooLarge {
                requested: length,
                maximum: self.limits.maximum_display_list_bytes,
            })?;
        if length_usize > self.limits.maximum_display_list_bytes {
            return Err(DecodeError::DisplayListTooLarge {
                requested: length,
                maximum: self.limits.maximum_display_list_bytes,
            });
        }
        if self.display_lists.len() >= self.limits.maximum_display_list_depth {
            return Err(DecodeError::DisplayListDepth {
                maximum: self.limits.maximum_display_list_depth,
            });
        }
        if self
            .display_lists
            .iter()
            .any(|frame| frame.address == address && frame.declared_length == length)
        {
            return Err(DecodeError::RecursiveDisplayList { address, length });
        }
        let expanded = self
            .active_display_list_bytes
            .checked_add(length_usize)
            .ok_or(DecodeError::DisplayListExpansion {
                requested: usize::MAX,
                maximum: self.limits.maximum_expanded_display_list_bytes,
            })?;
        if expanded > self.limits.maximum_expanded_display_list_bytes {
            return Err(DecodeError::DisplayListExpansion {
                requested: expanded,
                maximum: self.limits.maximum_expanded_display_list_bytes,
            });
        }
        self.preflight_resident_bytes(self.carry.capacity(), expanded, output.retained_bytes)?;

        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(length_usize)
            .map_err(|_| DecodeError::Allocation {
                site: AllocationSite::DisplayList,
            })?;
        bytes.resize(length_usize, 0);
        if !bytes.is_empty() {
            memory.read_exact(address, &mut bytes).map_err(|source| {
                DecodeError::DisplayListRead {
                    address,
                    length,
                    source,
                }
            })?;
        }
        self.reserve_output_records(output, 1)?;
        self.display_lists
            .try_reserve_exact(1)
            .map_err(|_| DecodeError::Allocation {
                site: AllocationSite::DisplayListStack,
            })?;
        let depth = self.display_lists.len() + 1;
        self.advance_current(command_bytes);
        output.push_reserved(SemanticRecord::DisplayListCall {
            address,
            length,
            depth: depth as u8,
        });
        self.stats.display_list_calls = self.stats.display_list_calls.saturating_add(1);
        self.stats.display_list_bytes = self
            .stats
            .display_list_bytes
            .saturating_add(u64::from(length));
        if !bytes.is_empty() {
            self.active_display_list_bytes = expanded;
            self.display_lists.push(DisplayListFrame {
                address,
                declared_length: length,
                bytes,
                cursor: 0,
            });
        }
        Ok(())
    }

    fn execute_draw(
        &mut self,
        opcode: u8,
        vertices: u16,
        format: VertexFormatSnapshot,
        command_bytes: usize,
        output: &mut DecodeBatch<'_>,
    ) -> Result<(), DecodeError> {
        let payload_bytes = command_bytes - 3;
        self.reserve_output_records(output, 1)?;
        let draw_index =
            output.reserve_draw(payload_bytes, self.limits, self.decoder_retained_bytes()?)?;
        let mut encoded_vertices = Vec::new();
        encoded_vertices
            .try_reserve_exact(payload_bytes)
            .map_err(|_| DecodeError::Allocation {
                site: AllocationSite::VertexPayload,
            })?;
        encoded_vertices.extend_from_slice(&self.current_slice()[3..command_bytes]);
        let snapshot = DrawSnapshot {
            opcode,
            topology: (opcode >> 3) & 7,
            vat_index: opcode & 7,
            vertex_count: vertices,
            format,
            encoded_vertices,
            payload_ownership: PayloadOwnership::ResidentOwned,
            pipeline: self.pipeline_snapshot(),
            exact_raster: self.exact_raster_snapshot(),
            tev: self.tev_snapshot(),
            textures: self.texture_register_snapshots(),
            texture_use_order: self.texture_use_order(),
        };
        self.advance_current(command_bytes);
        output.draws.push(snapshot);
        output.push_reserved(SemanticRecord::Draw { draw_index });
        self.stats.primitives = self.stats.primitives.saturating_add(1);
        self.stats.vertices = self.stats.vertices.saturating_add(u64::from(vertices));
        Ok(())
    }

    fn execute_bp(
        &mut self,
        word: u32,
        command_bytes: usize,
        output: &mut DecodeBatch<'_>,
    ) -> Result<(), DecodeError> {
        let register = (word >> 24) as u8;
        let value = word & 0x00ff_ffff;
        let mask = self.bp[0xfe];
        let previous = self.bp[usize::from(register)];
        let written = ((previous & !mask) | (value & mask)) & 0x00ff_ffff;
        let terminal = if register == 0x52 {
            Some(self.preflight_copy_terminal(written)?)
        } else {
            None
        };
        self.reserve_output_records(output, 1 + usize::from(terminal.is_some()))?;

        self.bp[usize::from(register)] = written;
        if register != 0xfe {
            self.bp[0xfe] = 0x00ff_ffff;
        }
        self.update_tev_register(register, written);
        self.advance_current(command_bytes);
        output.push_reserved(SemanticRecord::BpLoad {
            register,
            value: written,
        });
        self.stats.bp_loads = self.stats.bp_loads.saturating_add(1);
        if let Some(terminal) = terminal {
            self.terminal_sequence = terminal.sequence;
            match terminal.kind {
                TerminalKind::TextureCopy => {
                    self.texture_copy_generation = terminal.generation;
                }
                TerminalKind::XfbCopy => {
                    self.xfb_copy_generation = terminal.generation;
                }
                TerminalKind::EfbPeek => {}
            }
            if let Some(class) = terminal.barrier {
                self.pending_barrier = Some(PendingBarrier {
                    sequence: terminal.sequence,
                    class,
                });
                self.stats.barrier_stops = self.stats.barrier_stops.saturating_add(1);
            }
            output.push_reserved(SemanticRecord::Terminal(terminal));
        }
        Ok(())
    }

    fn preflight_copy_terminal(&self, trigger: u32) -> Result<TerminalSnapshot, DecodeError> {
        let kind = if trigger & 0x4000 != 0 {
            TerminalKind::XfbCopy
        } else {
            TerminalKind::TextureCopy
        };
        let generation = match kind {
            TerminalKind::TextureCopy => self.texture_copy_generation.checked_add(1),
            TerminalKind::XfbCopy => self.xfb_copy_generation.checked_add(1),
            TerminalKind::EfbPeek => None,
        }
        .ok_or(DecodeError::TerminalGenerationOverflow(kind))?;
        let sequence = self
            .terminal_sequence
            .checked_add(1)
            .ok_or(DecodeError::TerminalSequenceOverflow)?;
        let source = self.bp[0x49];
        let dimensions = self.bp[0x4a];
        let source_x = source & 0x03ff;
        let source_y = (source >> 10) & 0x03ff;
        let source_width = (dimensions & 0x03ff) + 1;
        let source_height = ((dimensions >> 10) & 0x03ff) + 1;
        let y_scale = self.bp[0x4e];
        let intervals = u64::from(source_height - 1);
        let scaled_intervals = if trigger & 0x0400 != 0 {
            intervals * 256 / u64::from(y_scale.max(1))
        } else {
            intervals * u64::from(y_scale) / 256
        };
        let scaled_height = (1 + scaled_intervals).min(1024) as u32;
        let destination = self.bp[0x4b] << 5;
        let stride = self.bp[0x4d] << 5;
        let copy = CopyStateSnapshot {
            z_mode: self.bp[0x40],
            blend_mode: self.bp[0x41],
            pixel_control: self.bp[0x43],
            copy_command: trigger,
            clear_rgba: [
                self.bp[0x4f] as u8,
                (self.bp[0x50] >> 8) as u8,
                self.bp[0x50] as u8,
                (self.bp[0x4f] >> 8) as u8,
            ],
            clear_depth: self.bp[0x51],
            copy_scale: y_scale,
            copy_filter: [self.bp[0x53], self.bp[0x54]],
        };

        let (output_width, output_height, texture_layout, no_op, barrier) = match kind {
            TerminalKind::XfbCopy => (source_width, scaled_height, None, false, None),
            TerminalKind::TextureCopy => {
                let metadata = texture_copy_metadata(
                    source_x,
                    source_y,
                    source_width,
                    source_height,
                    trigger,
                    stride,
                );
                (
                    metadata.output_width,
                    metadata.output_height,
                    metadata.layout,
                    metadata.no_op,
                    (!metadata.no_op).then_some(BarrierClass::TextureCopyReceipt),
                )
            }
            TerminalKind::EfbPeek => (0, 0, None, false, Some(BarrierClass::EfbPeekReceipt)),
        };
        Ok(TerminalSnapshot {
            sequence,
            kind,
            barrier,
            source_x,
            source_y,
            source_width,
            source_height,
            output_width,
            output_height,
            destination,
            stride,
            generation,
            clear: trigger & 0x0800 != 0,
            copy,
            texture_layout,
            no_op,
        })
    }

    fn next_terminal_sequence(&mut self) -> Result<u64, DecodeError> {
        let sequence = self
            .terminal_sequence
            .checked_add(1)
            .ok_or(DecodeError::TerminalSequenceOverflow)?;
        self.terminal_sequence = sequence;
        Ok(sequence)
    }

    fn update_tev_register(&mut self, register: u8, value: u32) {
        if !(0xe0..=0xe7).contains(&register) {
            return;
        }
        let slot = usize::from((register - 0xe0) >> 1);
        let is_konst = value & 0x0080_0000 != 0;
        let index = if is_konst {
            slot
        } else {
            tev_register_index(slot)
        };
        let target = if is_konst {
            &mut self.tev_konst[index]
        } else {
            &mut self.tev_color[index]
        };
        if register & 1 == 0 {
            target[0] = signed_11(value & 0x07ff);
            target[3] = signed_11((value >> 12) & 0x07ff);
        } else {
            target[2] = signed_11(value & 0x07ff);
            target[1] = signed_11((value >> 12) & 0x07ff);
        }
    }

    fn current_slice(&self) -> &[u8] {
        if let Some(frame) = self.display_lists.last() {
            &frame.bytes[frame.cursor..]
        } else {
            &self.carry[self.carry_cursor..]
        }
    }

    fn current_available(&self) -> usize {
        self.current_slice().len()
    }

    fn advance_current(&mut self, bytes: usize) {
        if let Some(frame) = self.display_lists.last_mut() {
            frame.cursor += bytes;
        } else {
            self.carry_cursor += bytes;
        }
    }

    fn pop_display_list(&mut self) {
        if let Some(frame) = self.display_lists.pop() {
            self.active_display_list_bytes = self
                .active_display_list_bytes
                .saturating_sub(frame.bytes.len());
        }
    }

    fn compact_carry_if_possible(&mut self) {
        if !self.display_lists.is_empty() || self.carry_cursor == 0 {
            return;
        }
        if self.carry_cursor >= self.carry.len() {
            self.carry = Vec::new();
            self.carry_cursor = 0;
            return;
        }
        let unread = self.carry.len() - self.carry_cursor;
        self.carry.copy_within(self.carry_cursor.., 0);
        self.carry.truncate(unread);
        self.carry_cursor = 0;
        self.stats.compactions = self.stats.compactions.saturating_add(1);
    }

    fn preflight_resident_bytes(
        &self,
        carry_bytes: usize,
        display_list_bytes: usize,
        output_vertex_bytes: usize,
    ) -> Result<(), DecodeError> {
        let requested = carry_bytes
            .checked_add(display_list_bytes)
            .and_then(|bytes| bytes.checked_add(output_vertex_bytes))
            .ok_or(DecodeError::ResidentBytes {
                requested: usize::MAX,
                maximum: self.limits.maximum_resident_bytes,
            })?;
        if requested > self.limits.maximum_resident_bytes {
            return Err(DecodeError::ResidentBytes {
                requested,
                maximum: self.limits.maximum_resident_bytes,
            });
        }
        Ok(())
    }

    fn decoder_retained_bytes(&self) -> Result<usize, DecodeError> {
        self.carry
            .capacity()
            .checked_add(self.active_display_list_bytes)
            .ok_or(DecodeError::ResidentBytes {
                requested: usize::MAX,
                maximum: self.limits.maximum_resident_bytes,
            })
    }

    fn reserve_output_records(
        &self,
        output: &mut DecodeBatch<'_>,
        count: usize,
    ) -> Result<(), DecodeError> {
        output.reserve_records(count, self.limits, self.decoder_retained_bytes()?)
    }

    fn vertex_format(&self, vat_index: u8) -> VertexFormatSnapshot {
        let vat = usize::from(vat_index & 7);
        let vcd_low = self.cp[0x50];
        let vcd_high = self.cp[0x60];
        let vat_a = self.cp[0x70 + vat];
        let vat_b = self.cp[0x80 + vat];
        let vat_c = self.cp[0x90 + vat];
        let mut issues = VertexFormatIssues::default();
        let mut size = (vcd_low & 0x01ff).count_ones();

        let position_status = attribute_status(vcd_low, vcd_high, 0);
        let position_elements = (vat_a & 1) + 2;
        let position_format = (vat_a >> 1) & 7;
        if position_format > 4 {
            issues.insert(VertexFormatIssues::POSITION_FORMAT);
        }
        size = size.saturating_add(attribute_bytes(
            position_status,
            position_elements.saturating_mul(component_bytes(position_format)),
        ));

        let normal_status = attribute_status(vcd_low, vcd_high, 1);
        let normal_elements = (vat_a >> 9) & 1;
        let normal_format = (vat_a >> 10) & 7;
        if normal_format > 4 {
            issues.insert(VertexFormatIssues::NORMAL_FORMAT);
        }
        if normal_status == 1 {
            let components = if normal_elements == 0 { 3 } else { 9 };
            size = size.saturating_add(components * component_bytes(normal_format));
        } else if normal_status >= 2 {
            let index_bytes = if normal_status == 2 { 1 } else { 2 };
            size = size.saturating_add(if normal_elements != 0 && vat_a & 0x8000_0000 != 0 {
                index_bytes * 3
            } else {
                index_bytes
            });
        }

        for color in 0..2_u32 {
            let status = attribute_status(vcd_low, vcd_high, 2 + color as usize);
            let format = (vat_a >> (14 + color * 4)) & 7;
            let direct_bytes = match format {
                0 | 3 => 2,
                1 | 4 => 3,
                2 | 5 => 4,
                _ => 0,
            };
            if format > 5 {
                issues.insert(VertexFormatIssues::COLOR0_FORMAT << color);
            }
            size = size.saturating_add(attribute_bytes(status, direct_bytes));
        }

        let texture_formats = [
            ((vat_a >> 21) & 1, (vat_a >> 22) & 7),
            (vat_b & 1, (vat_b >> 1) & 7),
            ((vat_b >> 9) & 1, (vat_b >> 10) & 7),
            ((vat_b >> 18) & 1, (vat_b >> 19) & 7),
            ((vat_b >> 27) & 1, (vat_b >> 28) & 7),
            ((vat_c >> 5) & 1, (vat_c >> 6) & 7),
            ((vat_c >> 14) & 1, (vat_c >> 15) & 7),
            ((vat_c >> 23) & 1, (vat_c >> 24) & 7),
        ];
        for (texture, (elements, format)) in texture_formats.into_iter().enumerate() {
            let status = attribute_status(vcd_low, vcd_high, 4 + texture);
            if format > 4 {
                issues.insert(VertexFormatIssues::TEXCOORD0_FORMAT << texture);
            }
            size = size.saturating_add(attribute_bytes(
                status,
                (elements + 1).saturating_mul(component_bytes(format)),
            ));
        }

        VertexFormatSnapshot {
            matrix_index_a: self.cp[0x30],
            matrix_index_b: self.cp[0x40],
            vcd_low,
            vcd_high,
            vat_a,
            vat_b,
            vat_c,
            // The architectural maximum is 129 bytes. Saturation keeps malformed state
            // deterministic without giving guest input a panic path.
            bytes_per_vertex: size.min(u32::from(u16::MAX)) as u16,
            issues,
        }
    }

    fn pipeline_snapshot(&self) -> PipelineSnapshot {
        let top_left = self.bp[0x20];
        let bottom_right = self.bp[0x21];
        let offset = self.bp[0x59];
        let raw_left = ((top_left >> 12) & 0x07ff) as i64;
        let raw_top = (top_left & 0x07ff) as i64;
        let raw_right = ((bottom_right >> 12) & 0x07ff) as i64;
        let raw_bottom = (bottom_right & 0x07ff) as i64;
        let top_left_x = (raw_left - 342).max(0);
        let top_left_y = (raw_top - 342).max(0);
        let width = (raw_right - raw_left).max(0) + 1;
        let height = (raw_bottom - raw_top).max(0) + 1;
        let offset_x = i64::from(offset & 0x03ff) * 2 - 342;
        let offset_y = i64::from((offset >> 10) & 0x03ff) * 2 - 342;
        let scissor_x = (top_left_x - offset_x).clamp(0, i64::from(EFB_WIDTH)) as u32;
        let scissor_y = (top_left_y - offset_y).clamp(0, i64::from(EFB_HEIGHT)) as u32;
        let mut indirect = IndirectTevSnapshot {
            gen_mode: self.bp[0x00],
            xf_num_tex_gens: (self.xf[0x103f] & 0x0f).min(8),
            imask: self.bp[0x0f],
            tex_scales: [self.bp[0x25], self.bp[0x26]],
            iref: self.bp[0x27],
            ..IndirectTevSnapshot::default()
        };
        indirect.matrices.copy_from_slice(&self.bp[0x06..0x0f]);
        indirect.commands.copy_from_slice(&self.bp[0x10..0x20]);
        let mut fog_range_k = [0; 5];
        fog_range_k.copy_from_slice(&self.bp[0xe9..0xee]);
        let mut fog_words = [0; 5];
        fog_words.copy_from_slice(&self.bp[0xee..0xf3]);
        PipelineSnapshot {
            z_mode: self.bp[0x40],
            blend_mode: self.bp[0x41],
            alpha_test: self.bp[0xf3],
            cull_mode: ((self.bp[0x00] >> 14) & 3) as u8,
            scissor_x,
            scissor_y,
            scissor_width: (width as u32).min(EFB_WIDTH - scissor_x),
            scissor_height: (height as u32).min(EFB_HEIGHT - scissor_y),
            pixel_control: self.bp[0x43],
            constant_alpha: self.bp[0x42],
            z_texture_bias: self.bp[0xf4],
            z_texture_mode: self.bp[0xf5],
            fog_range_base: self.bp[0xe8],
            fog_range_k,
            fog_words,
            viewport_half_width_bits: self.xf[0x101a],
            indirect_tev: indirect,
        }
    }

    fn exact_raster_snapshot(&self) -> ExactRasterSnapshot {
        let mut viewport_bits = [0; 6];
        viewport_bits.copy_from_slice(&self.xf[0x101a..0x1020]);
        let mut projection_bits = [0; 6];
        projection_bits.copy_from_slice(&self.xf[0x1020..0x1026]);
        ExactRasterSnapshot {
            bp_gen_mode: self.bp[0x00],
            bp_scissor_top_left: self.bp[0x20],
            bp_scissor_bottom_right: self.bp[0x21],
            bp_scissor_offset: self.bp[0x59],
            xf_clip_disable: self.xf[0x1005],
            viewport_bits,
            projection_bits,
            projection_type: self.xf[0x1026],
        }
    }

    fn tev_snapshot(&self) -> TevSnapshot {
        let stage_count = (((self.bp[0x00] >> 10) & 0x0f) + 1).min(16) as u8;
        let mut stages = [TevStageSnapshot::default(); 16];
        for (stage_index, stage) in stages.iter_mut().enumerate().take(usize::from(stage_count)) {
            let odd = stage_index & 1 != 0;
            let order = self.bp[0x28 + (stage_index >> 1)];
            let order_shift = if odd { 12 } else { 0 };
            let ksel = self.bp[0xf6 + (stage_index >> 1)];
            *stage = TevStageSnapshot {
                color_combiner: self.bp[0xc0 + stage_index * 2],
                alpha_combiner: self.bp[0xc1 + stage_index * 2],
                texture_map: ((order >> order_shift) & 7) as u8,
                texture_coord: ((order >> (order_shift + 3)) & 7) as u8,
                texture_enabled: order >> (order_shift + 6) & 1 != 0,
                color_channel: ((order >> (order_shift + 7)) & 7) as u8,
                konst_color_selector: ((ksel >> if odd { 14 } else { 4 }) & 0x1f) as u8,
                konst_alpha_selector: ((ksel >> if odd { 19 } else { 9 }) & 0x1f) as u8,
            };
        }
        let mut swap_tables = [[0; 4]; 4];
        for (table, swap_table) in swap_tables.iter_mut().enumerate() {
            let rg = self.bp[0xf6 + table * 2];
            let ba = self.bp[0xf7 + table * 2];
            *swap_table = [
                (rg & 3) as u8,
                ((rg >> 2) & 3) as u8,
                (ba & 3) as u8,
                ((ba >> 2) & 3) as u8,
            ];
        }
        TevSnapshot {
            stages,
            stage_count,
            color_registers: self.tev_color,
            konst_registers: self.tev_konst,
            swap_tables,
        }
    }

    fn texture_register_snapshots(&self) -> [TextureRegisterSnapshot; 8] {
        let mut textures = [TextureRegisterSnapshot::default(); 8];
        for (texture_map, texture) in textures.iter_mut().enumerate() {
            let slot = texture_map & 3;
            let bank = if texture_map >= 4 { 0x20 } else { 0 };
            *texture = TextureRegisterSnapshot {
                mode0: self.bp[0x80 + bank + slot],
                mode1: self.bp[0x84 + bank + slot],
                image0: self.bp[0x88 + bank + slot],
                image1: self.bp[0x8c + bank + slot],
                image2: self.bp[0x90 + bank + slot],
                image3: self.bp[0x94 + bank + slot],
                tlut: self.bp[0x98 + bank + slot],
            };
        }
        textures
    }

    fn texture_use_order(&self) -> TextureUseOrder {
        let tev = self.tev_snapshot();
        let indirect = self.pipeline_snapshot().indirect_tev;
        let num_tex_gens = indirect.xf_num_tex_gens as u8;
        let num_indirect_stages = ((indirect.gen_mode >> 16) & 7) as u8;
        let effective = |requested: u8| {
            if num_tex_gens == 0 {
                None
            } else if requested < num_tex_gens {
                Some(requested)
            } else {
                Some(0)
            }
        };
        let mut order = TextureUseOrder::default();
        for stage_index in 0..usize::from(tev.stage_count) {
            let stage = tev.stages[stage_index];
            if stage.texture_enabled && num_tex_gens != 0 {
                order.push(TextureUse {
                    kind: TextureUseKind::Direct,
                    tev_stage: stage_index as u8,
                    texture_map: stage.texture_map,
                    requested_tex_coord: stage.texture_coord,
                    effective_tex_coord: effective(stage.texture_coord),
                });
            }
        }
        for stage_index in 0..usize::from(tev.stage_count) {
            let command = indirect.commands[stage_index];
            let indirect_stage = (command & 3) as u8;
            let bump_alpha = (command >> 7) & 3;
            let matrix = (command >> 9) & 3;
            if (bump_alpha == 0 && matrix == 0) || indirect_stage >= num_indirect_stages {
                continue;
            }
            let reference = (indirect.iref >> (u32::from(indirect_stage) * 6)) & 0x3f;
            let requested = ((reference >> 3) & 7) as u8;
            order.push(TextureUse {
                kind: TextureUseKind::Indirect {
                    stage: indirect_stage,
                },
                tev_stage: stage_index as u8,
                texture_map: (reference & 7) as u8,
                requested_tex_coord: requested,
                effective_tex_coord: effective(requested),
            });
        }
        order
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct TextureCopyMetadata {
    output_width: u32,
    output_height: u32,
    layout: Option<TextureCopyLayout>,
    no_op: bool,
}

fn texture_copy_metadata(
    source_x: u32,
    source_y: u32,
    source_width: u32,
    source_height: u32,
    copy_command: u32,
    stride: u32,
) -> TextureCopyMetadata {
    if source_x >= EFB_WIDTH || source_y >= EFB_HEIGHT {
        return TextureCopyMetadata {
            no_op: true,
            ..TextureCopyMetadata::default()
        };
    }
    let divisor = if copy_command & 0x0200 != 0 { 2 } else { 1 };
    let clipped_width = source_width.min(EFB_WIDTH - source_x);
    let clipped_height = source_height.min(EFB_HEIGHT - source_y);
    let output_width = clipped_width / divisor;
    let output_height = clipped_height / divisor;
    if output_width == 0 || output_height == 0 {
        return TextureCopyMetadata {
            no_op: true,
            ..TextureCopyMetadata::default()
        };
    }
    let copy_format = (u8::from(copy_command & 0x08 != 0) << 3) | ((copy_command >> 4) & 7) as u8;
    let base_format = match copy_format {
        0 => Some(0),
        1 | 7 | 8 | 9 | 10 => Some(1),
        2 => Some(2),
        3 | 11 | 12 => Some(3),
        4 => Some(4),
        5 => Some(5),
        6 => Some(6),
        _ => None,
    };
    let layout = base_format.map(|base_format| {
        let (block_width, block_height, block_bytes) = match base_format {
            0 => (8, 8, 32),
            1 | 2 => (8, 4, 32),
            3..=5 => (4, 4, 32),
            6 => (4, 4, 64),
            _ => (1, 1, 0),
        };
        let row_bytes = output_width.div_ceil(block_width) * block_bytes;
        let row_count = output_height.div_ceil(block_height);
        TextureCopyLayout {
            copy_format,
            base_format,
            block_width: block_width as u8,
            block_height: block_height as u8,
            block_bytes: block_bytes as u8,
            row_bytes,
            row_count,
            byte_length: row_bytes * row_count,
            direct_compatible: stride == row_bytes,
        }
    });
    TextureCopyMetadata {
        output_width,
        output_height,
        layout,
        no_op: false,
    }
}

fn read_be_u16(source: &[u8], offset: usize) -> u16 {
    u16::from(source[offset]) << 8 | u16::from(source[offset + 1])
}

fn read_be_u32(source: &[u8], offset: usize) -> u32 {
    u32::from(source[offset]) << 24
        | u32::from(source[offset + 1]) << 16
        | u32::from(source[offset + 2]) << 8
        | u32::from(source[offset + 3])
}

fn validate_xf_range(start: u16, count: u8) -> Result<(), DecodeError> {
    let end = usize::from(start)
        .checked_add(usize::from(count))
        .ok_or(DecodeError::XfRange { start, count })?;
    if end > XF_REGISTER_COUNT {
        return Err(DecodeError::XfRange { start, count });
    }
    Ok(())
}

fn attribute_status(vcd_low: u32, vcd_high: u32, index: usize) -> u32 {
    if index < 4 {
        (vcd_low >> (9 + index * 2)) & 3
    } else {
        (vcd_high >> ((index - 4) * 2)) & 3
    }
}

fn component_bytes(format: u32) -> u32 {
    if format <= 1 {
        1
    } else if format <= 3 {
        2
    } else {
        4
    }
}

fn attribute_bytes(status: u32, direct_bytes: u32) -> u32 {
    match status {
        0 => 0,
        1 => direct_bytes,
        2 => 1,
        _ => 2,
    }
}

fn signed_11(value: u32) -> i32 {
    if value & 0x0400 != 0 {
        value as i32 - 0x0800
    } else {
        value as i32
    }
}

fn tev_register_index(encoded: usize) -> usize {
    if encoded == 0 { 3 } else { encoded - 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug)]
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

    fn be32(value: u32) -> [u8; 4] {
        value.to_be_bytes()
    }

    fn cp(register: u8, value: u32) -> Vec<u8> {
        let mut command = vec![0x08, register];
        command.extend_from_slice(&be32(value));
        command
    }

    fn bp(register: u8, value: u32) -> Vec<u8> {
        let mut command = vec![0x61];
        command.extend_from_slice(&be32(u32::from(register) << 24 | value & 0x00ff_ffff));
        command
    }

    fn xf(start: u16, values: &[u32]) -> Vec<u8> {
        assert!(!values.is_empty() && values.len() <= 16);
        let header = ((values.len() as u32 - 1) << 16) | u32::from(start);
        let mut command = vec![0x10];
        command.extend_from_slice(&be32(header));
        for value in values {
            command.extend_from_slice(&be32(*value));
        }
        command
    }

    fn call(address: u32, length: u32) -> Vec<u8> {
        let mut command = vec![0x40];
        command.extend_from_slice(&be32(address));
        command.extend_from_slice(&be32(length));
        command
    }

    fn fresh_decoder() -> ResidentGxDecoder {
        ResidentGxDecoder::try_new(DecoderLimits::default()).unwrap()
    }

    fn append_records(
        decoder: &mut ResidentGxDecoder,
        memory: &mut TestMemory,
        chunks: &[&[u8]],
    ) -> Vec<SemanticRecord> {
        let mut records = Vec::new();
        for chunk in chunks {
            let batch = decoder.append(chunk, memory).unwrap();
            records.extend_from_slice(batch.records());
        }
        records
    }

    #[test]
    fn browser_oracle_stream_is_invariant_across_every_chunk_boundary() {
        // This is the browser FIFO oracle's mixed CP/XF/BP/primitive grammar with a real
        // two-byte direct position format instead of its stubbed vertex-size callback.
        let mut stream = vec![0x00];
        stream.extend(cp(0x50, 1 << 9));
        stream.extend(cp(0x70, 0));
        stream.extend(xf(0x10, &[0x1112_1314, 0x2122_2324]));
        stream.extend(bp(0x41, 0x0042_4344));
        stream.extend([0x90, 0x00, 0x03, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56]);
        stream.push(0x7f);

        let mut direct_decoder = fresh_decoder();
        let mut direct_memory = TestMemory::new(0x1000);
        let expected = append_records(&mut direct_decoder, &mut direct_memory, &[&stream]);
        assert_eq!(direct_decoder.buffered_bytes(), 0);
        assert_eq!(direct_decoder.stats().decoded_commands, 7);
        assert_eq!(direct_decoder.stats().unsupported_opcodes, 1);

        for split in 1..stream.len() {
            let mut decoder = fresh_decoder();
            let mut memory = TestMemory::new(0x1000);
            let actual = append_records(
                &mut decoder,
                &mut memory,
                &[&stream[..split], &stream[split..]],
            );
            assert_eq!(actual, expected, "two-way split at byte {split}");
        }

        let chunks: Vec<&[u8]> = (0..stream.len())
            .map(|index| &stream[index..index + 1])
            .collect();
        let mut decoder = fresh_decoder();
        let mut memory = TestMemory::new(0x1000);
        assert_eq!(append_records(&mut decoder, &mut memory, &chunks), expected);
    }

    #[test]
    fn incomplete_commands_have_no_effect_and_publish_exact_retry_size() {
        let command = xf(0x20, &[0x0102_0304, 0x0506_0708]);
        let mut decoder = fresh_decoder();
        let mut memory = TestMemory::new(1);

        let first = decoder.append(&command[..4], &mut memory).unwrap();
        assert_eq!(first.status, DecodeStatus::NeedMore { command_bytes: 5 });
        assert_eq!(decoder.xf_registers()[0x20], 0);
        let second = decoder.append(&command[4..5], &mut memory).unwrap();
        assert_eq!(second.status, DecodeStatus::NeedMore { command_bytes: 13 });
        assert_eq!(decoder.xf_registers()[0x20], 0);
        let third = decoder.append(&command[5..], &mut memory).unwrap();
        assert_eq!(third.status, DecodeStatus::Drained);
        assert_eq!(
            decoder.xf_registers()[0x20..0x22],
            [0x0102_0304, 0x0506_0708]
        );
        assert_eq!(decoder.retry_at_command_bytes(), 1);
    }

    #[test]
    fn carry_overflow_is_atomic() {
        let limits = DecoderLimits {
            maximum_carry_bytes: 8,
            maximum_display_list_bytes: 8,
            maximum_expanded_display_list_bytes: 8,
            maximum_vertex_bytes_per_decode: 8,
            maximum_resident_bytes: 512,
            ..DecoderLimits::default()
        };
        let mut decoder = ResidentGxDecoder::try_new(limits).unwrap();
        let mut memory = TestMemory::new(1);
        decoder.append(&cp(0x50, 1 << 9), &mut memory).unwrap();
        let first = [0x90, 0, 4, 1, 2, 3, 4];
        let status = decoder.append(&first, &mut memory).unwrap().status;
        assert_eq!(status, DecodeStatus::NeedMore { command_bytes: 11 });
        let before = (decoder.buffered_bytes(), decoder.stats());
        let error = decoder.append(&[6, 7], &mut memory).unwrap_err();
        assert_eq!(
            error,
            DecodeError::CarryOverflow {
                requested: 9,
                maximum: 8
            }
        );
        assert_eq!((decoder.buffered_bytes(), decoder.stats()), before);
    }

    #[test]
    fn drained_carry_releases_capacity_before_new_guest_payload() {
        const CARRY_BYTES: usize = 32 * 1024;
        const VERTEX_BYTES: usize = 24 * 1024;
        let limits = DecoderLimits {
            maximum_carry_bytes: CARRY_BYTES,
            maximum_display_list_bytes: CARRY_BYTES,
            maximum_expanded_display_list_bytes: CARRY_BYTES,
            maximum_vertex_bytes_per_decode: CARRY_BYTES,
            // The second decode simultaneously retains its CALL stream, display-list bytes,
            // semantic output, and copied draw payload. It must not also retain the first
            // decode's 32-KiB backing allocation invisibly.
            maximum_resident_bytes: 64 * 1024,
            ..DecoderLimits::default()
        };
        let mut decoder = ResidentGxDecoder::try_new(limits).unwrap();
        let mut memory = TestMemory::new(0x100 + VERTEX_BYTES + 3);

        let first = decoder.append(&vec![0; CARRY_BYTES], &mut memory).unwrap();
        assert_eq!(first.status, DecodeStatus::Drained);
        drop(first);
        assert_eq!(decoder.carry.capacity(), 0);

        let mut list = vec![0x90];
        list.extend((VERTEX_BYTES as u16).to_be_bytes());
        list.extend(vec![0xa5; VERTEX_BYTES]);
        memory.write(0x100, &list);
        let mut top = cp(0x50, 1); // One matrix-index byte per vertex.
        top.extend(call(0x100, list.len() as u32));
        let second = decoder.append(&top, &mut memory).unwrap();
        assert_eq!(second.status, DecodeStatus::Drained);
        assert_eq!(second.draws().len(), 1);
        assert_eq!(second.draws()[0].encoded_vertices.len(), VERTEX_BYTES);
        drop(second);
        assert_eq!(decoder.carry.capacity(), 0);
    }

    #[test]
    fn malformed_opcode_xf_range_and_reserved_vertex_format_fail_without_panics() {
        let mut decoder = fresh_decoder();
        let mut memory = TestMemory::new(1);
        let batch = decoder.append(&[0x7f], &mut memory).unwrap();
        let records = batch.records();
        assert_eq!(
            records,
            [SemanticRecord::UnsupportedOpcode {
                opcode: 0x7f,
                in_display_list: false
            }]
        );

        let malformed_range = xf(0x1057, &[1, 2]);
        assert_eq!(
            decoder.append(&malformed_range, &mut memory).unwrap_err(),
            DecodeError::XfRange {
                start: 0x1057,
                count: 2
            }
        );

        let mut decoder = fresh_decoder();
        let mut stream = cp(0x50, 1 << 9);
        stream.extend(cp(0x70, 7 << 1));
        stream.extend([0x90, 0, 1]);
        stream.extend([0; 8]);
        let batch = decoder.append(&stream, &mut memory).unwrap();
        let records = batch.records();
        let draw_index = records
            .iter()
            .find_map(|record| match record {
                SemanticRecord::Draw { draw_index } => Some(draw_index.to_owned()),
                _ => None,
            })
            .unwrap();
        let draw = batch.draw(draw_index).unwrap();
        assert_eq!(draw.format.bytes_per_vertex, 8);
        assert_eq!(
            draw.format.issues.bits() & VertexFormatIssues::POSITION_FORMAT,
            VertexFormatIssues::POSITION_FORMAT
        );
    }

    #[test]
    fn indexed_xf_load_uses_exact_cp_base_stride_and_is_atomic() {
        let mut decoder = fresh_decoder();
        let mut memory = TestMemory::new(0x1000);
        memory.write(0x340, &0x1122_3344_u32.to_be_bytes());
        memory.write(0x344, &0x5566_7788_u32.to_be_bytes());
        let mut stream = cp(0xac, 0x300);
        stream.extend(cp(0xbc, 0x40));
        stream.push(0x20);
        stream.extend(be32((1 << 16) | (1 << 12) | 0x100));
        decoder.append(&stream, &mut memory).unwrap();
        assert_eq!(
            decoder.xf_registers()[0x100..0x102],
            [0x1122_3344, 0x5566_7788]
        );

        let before = decoder.xf_registers()[0x100..0x102].to_vec();
        let mut rejected = cp(0xac, 0x00ff_0000);
        rejected.extend(cp(0xbc, 8));
        rejected.push(0x20);
        rejected.extend(be32((1 << 16) | (1 << 12) | 0x100));
        assert!(matches!(
            decoder.append(&rejected, &mut memory),
            Err(DecodeError::IndexedXfRead { .. })
        ));
        assert_eq!(decoder.xf_registers()[0x100..0x102], before);
    }

    #[test]
    fn nested_display_lists_execute_in_return_stack_order() {
        let mut memory = TestMemory::new(0x400);
        let mut inner = bp(0x41, 0x0000_0003);
        inner.push(0x48);
        memory.write(0x200, &inner);
        let mut outer = bp(0x41, 0x0000_0001);
        outer.extend(call(0x200, inner.len() as u32));
        outer.extend(bp(0x41, 0x0000_0002));
        memory.write(0x100, &outer);
        let mut top = call(0x100, outer.len() as u32);
        top.extend(bp(0x41, 0x0000_0004));

        let mut decoder = fresh_decoder();
        let batch = decoder.append(&top, &mut memory).unwrap();
        let records = batch.records();
        let values: Vec<u32> = records
            .iter()
            .filter_map(|record| match record {
                SemanticRecord::BpLoad {
                    register: 0x41,
                    value,
                } => Some(*value),
                _ => None,
            })
            .collect();
        assert_eq!(values, [1, 3, 2, 4]);
        assert_eq!(decoder.display_list_depth(), 0);
        assert_eq!(decoder.bp_registers()[0x41], 4);
        assert_eq!(decoder.stats().invalidations, 1);
    }

    #[test]
    fn display_list_recursion_depth_truncation_and_expansion_are_typed() {
        let mut memory = TestMemory::new(0x400);
        let recursion = call(0x100, 9);
        memory.write(0x100, &recursion);
        let mut decoder = fresh_decoder();
        assert_eq!(
            decoder.append(&call(0x100, 9), &mut memory).unwrap_err(),
            DecodeError::RecursiveDisplayList {
                address: 0x100,
                length: 9
            }
        );

        memory.write(0x100, &call(0x200, 9));
        memory.write(0x200, &call(0x300, 1));
        memory.write(0x300, &[0]);
        let limits = DecoderLimits {
            maximum_display_list_depth: 2,
            ..DecoderLimits::default()
        };
        let mut decoder = ResidentGxDecoder::try_new(limits).unwrap();
        assert_eq!(
            decoder.append(&call(0x100, 9), &mut memory).unwrap_err(),
            DecodeError::DisplayListDepth { maximum: 2 }
        );

        memory.write(0x180, &[0x61, 0x12]);
        let mut decoder = fresh_decoder();
        assert_eq!(
            decoder.append(&call(0x180, 2), &mut memory).unwrap_err(),
            DecodeError::TruncatedDisplayList {
                address: 0x180,
                cursor: 0,
                required: 5,
                available: 2
            }
        );
    }

    #[test]
    fn aggregate_limit_covers_carry_nested_lists_and_owned_draw_output_together() {
        let output_retained =
            3 * core::mem::size_of::<SemanticRecord>() + core::mem::size_of::<DrawSnapshot>() + 30;
        let requested = 15 + 42 + 20 + output_retained;
        let maximum = requested - 1;
        let limits = DecoderLimits {
            maximum_carry_bytes: 64,
            maximum_display_list_bytes: 64,
            maximum_display_list_depth: 4,
            maximum_expanded_display_list_bytes: 128,
            maximum_vertex_bytes_per_decode: 64,
            maximum_resident_bytes: maximum,
            ..DecoderLimits::default()
        };
        let mut memory = TestMemory::new(0x400);
        memory.write(0x200, &[0; 20]);
        let mut outer = vec![0x90, 0, 30];
        outer.extend([0xaa; 30]);
        outer.extend(call(0x200, 20));
        assert_eq!(outer.len(), 42);
        memory.write(0x100, &outer);
        let mut top = cp(0x50, 1); // One matrix-index byte per vertex.
        top.extend(call(0x100, outer.len() as u32));
        assert_eq!(top.len(), 15);

        let mut decoder = ResidentGxDecoder::try_new(limits).unwrap();
        assert_eq!(
            decoder.append(&top, &mut memory).unwrap_err(),
            DecodeError::ResidentBytes { requested, maximum }
        );
        assert_eq!(decoder.display_list_depth(), 1);
    }

    #[test]
    fn texture_copy_barrier_retains_nested_then_outer_suffix_order() {
        let mut memory = TestMemory::new(0x400);
        let mut list = bp(0x52, 0);
        list.extend(bp(0x41, 0x11));
        memory.write(0x100, &list);
        let mut top = call(0x100, list.len() as u32);
        top.extend(bp(0x41, 0x22));
        let mut decoder = fresh_decoder();
        let first = decoder.append(&top, &mut memory).unwrap();
        let terminal = first
            .records()
            .iter()
            .find_map(|record| match record {
                SemanticRecord::Terminal(terminal) => Some(terminal.to_owned()),
                _ => None,
            })
            .unwrap();
        assert_eq!(terminal.kind, TerminalKind::TextureCopy);
        assert_eq!(terminal.barrier, Some(BarrierClass::TextureCopyReceipt));
        assert_eq!(
            first.status,
            DecodeStatus::Blocked {
                sequence: terminal.sequence,
                class: BarrierClass::TextureCopyReceipt
            }
        );
        drop(first);
        assert_eq!(decoder.display_list_depth(), 1);
        assert!(matches!(
            decoder.append(&[0], &mut memory),
            Err(DecodeError::BarrierPending { .. })
        ));

        let resumed = decoder
            .acknowledge_terminal(terminal.sequence, &mut memory)
            .unwrap();
        let values: Vec<u32> = resumed
            .records()
            .iter()
            .filter_map(|record| match record {
                SemanticRecord::BpLoad {
                    register: 0x41,
                    value,
                } => Some(*value),
                _ => None,
            })
            .collect();
        assert_eq!(values, [0x11, 0x22]);
        assert_eq!(resumed.status, DecodeStatus::Drained);
    }

    #[test]
    fn xfb_and_clipped_texture_terminals_do_not_stall_fifo() {
        let mut memory = TestMemory::new(1);
        let mut decoder = fresh_decoder();
        let mut xfb = bp(0x52, 0x4000);
        xfb.extend(bp(0x41, 1));
        let batch = decoder.append(&xfb, &mut memory).unwrap();
        assert_eq!(batch.status, DecodeStatus::Drained);
        assert_eq!(decoder.pending_barrier(), None);
        assert_eq!(decoder.bp_registers()[0x41], 1);

        let mut decoder = fresh_decoder();
        let mut clipped = bp(0x49, 700);
        clipped.extend(bp(0x52, 0));
        clipped.extend(bp(0x41, 2));
        let batch = decoder.append(&clipped, &mut memory).unwrap();
        let terminal = batch
            .records()
            .iter()
            .find_map(|record| match record {
                SemanticRecord::Terminal(terminal) => Some(terminal.to_owned()),
                _ => None,
            })
            .unwrap();
        assert!(terminal.no_op);
        assert_eq!(terminal.barrier, None);
        assert_eq!(decoder.bp_registers()[0x41], 2);
    }

    #[test]
    fn efb_peek_matches_browser_aperture_and_canonical_alpha_rules() {
        let mut decoder = fresh_decoder();
        assert_eq!(
            decoder
                .request_efb_peek(EfbPeekRequest {
                    physical_address: 0x088f_0500,
                    alpha_read_mode: 2,
                    earlier_renderer_terminal: false,
                })
                .unwrap(),
            EfbPeekResult::ImmediateZero {
                combined_plane: true
            }
        );
        assert_eq!(
            decoder
                .request_efb_peek(EfbPeekRequest {
                    physical_address: 0x080f_0a00,
                    alpha_read_mode: 2,
                    earlier_renderer_terminal: false,
                })
                .unwrap(),
            EfbPeekResult::ImmediateZero {
                combined_plane: false
            }
        );
        assert_eq!(
            decoder
                .request_efb_peek(EfbPeekRequest {
                    physical_address: 0x084f_0500,
                    alpha_read_mode: 2,
                    earlier_renderer_terminal: true,
                })
                .unwrap(),
            EfbPeekResult::YieldForEarlierTerminal
        );
        let EfbPeekResult::Terminal(terminal) = decoder
            .request_efb_peek(EfbPeekRequest {
                physical_address: 0x084f_0500,
                alpha_read_mode: 3,
                earlier_renderer_terminal: false,
            })
            .unwrap()
        else {
            panic!("valid EFB peek did not produce a terminal");
        };
        assert_eq!((terminal.source_x, terminal.source_y), (320, 240));
        assert_eq!(terminal.destination, 1);
        assert_eq!(terminal.stride, 0);
        assert_eq!(terminal.barrier, Some(BarrierClass::EfbPeekReceipt));
    }

    #[test]
    fn sdk_like_indexed_triangle_captures_exact_draw_and_texture_state() {
        let mut stream = cp(0x50, (3 << 9) | (3 << 11) | (1 << 13));
        // POS: XYZ/F32; NRM: N3/F32; CLR0: RGBA8888. Indexed attributes consume
        // two bytes each, direct color consumes four: eight bytes per vertex.
        stream.extend(cp(0x70, 1 | (4 << 1) | (4 << 10) | (5 << 14)));
        stream.extend(bp(0x00, (1 << 10) | (2 << 14) | (1 << 16)));
        stream.extend(bp(0x28, (3 << 0) | (2 << 3) | (1 << 6) | (4 << 7)));
        stream.extend(bp(0xc0, 0x0012_3456));
        stream.extend(bp(0xc1, 0x0065_4321));
        stream.extend(bp(0xf6, (7 << 4) | (9 << 9)));
        stream.extend(bp(0x80, 0x0039_abcd));
        stream.extend(bp(0x84, 0x0000_2010));
        stream.extend(xf(0x103f, &[3]));
        stream.push(0x90);
        stream.extend([0, 3]);
        stream.extend((0..24).map(|byte| byte as u8));

        let mut decoder = fresh_decoder();
        let mut memory = TestMemory::new(1);
        let batch = decoder.append(&stream, &mut memory).unwrap();
        let records = batch.records();
        let draw_index = records
            .iter()
            .find_map(|record| match record {
                SemanticRecord::Draw { draw_index } => Some(draw_index.to_owned()),
                _ => None,
            })
            .unwrap();
        let draw = batch.draw(draw_index).unwrap();
        assert_eq!(draw.opcode, 0x90);
        assert_eq!(draw.topology, 2);
        assert_eq!(draw.vertex_count, 3);
        assert_eq!(draw.format.bytes_per_vertex, 8);
        assert_eq!(
            draw.encoded_vertices,
            (0..24).map(|byte| byte as u8).collect::<Vec<_>>()
        );
        assert_eq!(draw.pipeline.cull_mode, 2);
        assert_eq!(draw.pipeline.indirect_tev.xf_num_tex_gens, 3);
        assert_eq!(draw.textures[0].mode0, 0x0039_abcd);
        assert_eq!(draw.textures[0].mode1, 0x0000_2010);
        assert_eq!(draw.tev.stage_count, 2);
        assert_eq!(draw.tev.stages[0].texture_map, 3);
        assert_eq!(draw.tev.stages[0].texture_coord, 2);
        assert!(draw.tev.stages[0].texture_enabled);
        assert_eq!(draw.texture_use_order.len(), 1);
        assert_eq!(
            draw.texture_use_order.as_slice()[0],
            Some(TextureUse {
                kind: TextureUseKind::Direct,
                tev_stage: 0,
                texture_map: 3,
                requested_tex_coord: 2,
                effective_tex_coord: Some(2)
            })
        );
    }
}
