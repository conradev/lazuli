//! Host-neutral resident GX texture and TMEM materialization.
//!
//! The FIFO decoder authenticates BP writes and snapshots draw-local texture registers. This
//! module consumes those values without invoking a renderer or any browser API. It owns the
//! architected 1 MiB TMEM image, applies preload/TLUT side effects atomically, and turns the
//! texture maps used by one draw into bounded RGBA8 mip payloads (or an exact EFB-copy reference).
//!
//! Integration must walk `SemanticRecord`s in order. At each `Draw`, materialize that draw before
//! replaying any later BP/TMEM record, transfer the batch with `TextureBatch::into_retained`, and
//! accumulate the charged result until the terminal. Draw-local register snapshots cannot recover
//! an earlier TMEM image after a later preload or TLUT upload has executed.

use core::fmt;
use core::fmt::Write as _;
use core::marker::PhantomData;
use std::string::String;
use std::vec::Vec;

use super::resident_fifo::{
    DrawSnapshot, GxMemory, MemoryError, SemanticRecord, TextureRegisterSnapshot,
};

pub const TMEM_BYTES: usize = 1024 * 1024;
pub const TMEM_LINE_BYTES: usize = 32;
pub const MAX_TEXTURE_DIMENSION: u32 = 1024;
const BP_WORD_MAX: u32 = 0x00ff_ffff;
const TEXTURE_MAP_COUNT: usize = 8;
const MAX_MIP_LEVELS: usize = 11;

/// Hash the compact, physically tiled bytes written by an EFB texture copy.
///
/// The copy producer must scatter any padded guest rows into a compact `row_bytes * row_count`
/// receipt before calling this helper. Materialization uses this exact hash to prove that a
/// recorded copy still names the bytes at its destination rather than a later guest overwrite.
pub fn materialized_texture_hash(bytes: &[u8]) -> u32 {
    let mut hash = 0x811c_9dc5u32;
    for byte in bytes {
        hash = (hash ^ u32::from(*byte)).wrapping_mul(0x0100_0193);
    }
    hash
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextureLimits {
    /// Largest encoded source accepted for one texture chain.
    pub maximum_source_bytes: usize,
    /// Largest sum of decoded payloads returned by one leased batch.
    pub maximum_output_bytes: usize,
    /// Largest sum of encoded automatic-cache snapshots retained across draws.
    pub maximum_cache_bytes: usize,
    /// Largest individual BP preload/TLUT transfer.
    pub maximum_tmem_transfer_bytes: usize,
    /// Number of materialized EFB-copy generations remembered for direct references.
    pub maximum_texture_copy_references: usize,
    /// One ceiling over TMEM, retained cache bytes, source staging, and leased output pixels.
    pub maximum_resident_bytes: usize,
}

impl Default for TextureLimits {
    fn default() -> Self {
        Self {
            maximum_source_bytes: 8 * 1024 * 1024,
            maximum_output_bytes: 24 * 1024 * 1024,
            maximum_cache_bytes: 8 * 1024 * 1024,
            maximum_tmem_transfer_bytes: 4 * 1024 * 1024,
            maximum_texture_copy_references: 64,
            maximum_resident_bytes: 48 * 1024 * 1024,
        }
    }
}

impl TextureLimits {
    fn validate(self) -> Result<Self, TextureError> {
        if self.maximum_source_bytes == 0 {
            return Err(TextureError::InvalidLimit("maximum_source_bytes"));
        }
        if self.maximum_output_bytes == 0 {
            return Err(TextureError::InvalidLimit("maximum_output_bytes"));
        }
        if self.maximum_tmem_transfer_bytes == 0 {
            return Err(TextureError::InvalidLimit("maximum_tmem_transfer_bytes"));
        }
        if self.maximum_texture_copy_references == 0 {
            return Err(TextureError::InvalidLimit(
                "maximum_texture_copy_references",
            ));
        }
        let maximum_staging_bytes = self
            .maximum_source_bytes
            .max(self.maximum_tmem_transfer_bytes);
        let required = TMEM_BYTES
            .checked_add(maximum_staging_bytes)
            .and_then(|value| value.checked_add(self.maximum_output_bytes))
            .and_then(|value| value.checked_add(self.maximum_cache_bytes))
            .ok_or(TextureError::ArithmeticOverflow("resident byte limit"))?;
        if self.maximum_resident_bytes < required {
            return Err(TextureError::InvalidLimit("maximum_resident_bytes"));
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextureAllocationSite {
    Tmem,
    TmemTransfer,
    Source,
    MipLayout,
    Pixels,
    Batch,
    Key,
    TextureCopyReferences,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TmemBank {
    Even,
    Odd,
    Tlut,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TextureError {
    InvalidLimit(&'static str),
    InvalidTextureMap(u8),
    InvalidBpValue {
        register: u8,
        value: u32,
    },
    UnsupportedFormat(u8),
    ReservedMipFilter(u8),
    InvalidTlutFormat(u8),
    ArithmeticOverflow(&'static str),
    SourceTooLarge {
        requested: usize,
        maximum: usize,
    },
    OutputTooLarge {
        requested: usize,
        maximum: usize,
    },
    TmemTransferTooLarge {
        requested: usize,
        maximum: usize,
    },
    ResidentBytes {
        requested: usize,
        maximum: usize,
    },
    TmemRange {
        bank: TmemBank,
        offset: usize,
        length: usize,
    },
    MemoryRead {
        address: u32,
        length: usize,
        source: MemoryError,
    },
    Allocation {
        site: TextureAllocationSite,
    },
    InvalidTextureCopy(&'static str),
    StaleTextureCopy {
        latest: u32,
        received: u32,
    },
    InternalInvariant(&'static str),
}

impl fmt::Display for TextureError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLimit(name) => write!(formatter, "invalid resident texture limit {name}"),
            Self::InvalidTextureMap(map) => write!(formatter, "invalid GX texture map {map}"),
            Self::InvalidBpValue { register, value } => write!(
                formatter,
                "unauthenticated BP value {value:#010x} for register {register:#04x}"
            ),
            Self::UnsupportedFormat(format) => {
                write!(formatter, "unsupported GX texture format {format:#x}")
            }
            Self::ReservedMipFilter(filter) => {
                write!(formatter, "reserved GX mip filter {filter}")
            }
            Self::InvalidTlutFormat(format) => {
                write!(formatter, "invalid GX TLUT format {format}")
            }
            Self::ArithmeticOverflow(what) => write!(formatter, "{what} overflows"),
            Self::SourceTooLarge { requested, maximum } => write!(
                formatter,
                "GX texture source is too large: {requested} > {maximum}"
            ),
            Self::OutputTooLarge { requested, maximum } => write!(
                formatter,
                "GX decoded texture output is too large: {requested} > {maximum}"
            ),
            Self::TmemTransferTooLarge { requested, maximum } => write!(
                formatter,
                "GX TMEM transfer is too large: {requested} > {maximum}"
            ),
            Self::ResidentBytes { requested, maximum } => write!(
                formatter,
                "resident GX texture bytes exceed bound: {requested} > {maximum}"
            ),
            Self::TmemRange {
                bank,
                offset,
                length,
            } => write!(
                formatter,
                "GX {bank:?} TMEM range {offset:#x}+{length:#x} is out of bounds"
            ),
            Self::MemoryRead {
                address,
                length,
                source,
            } => write!(
                formatter,
                "GX texture memory read failed at {address:#010x} ({length} bytes): {source:?}"
            ),
            Self::Allocation { site } => {
                write!(
                    formatter,
                    "resident GX texture allocation failed at {site:?}"
                )
            }
            Self::InvalidTextureCopy(reason) => {
                write!(formatter, "invalid GX texture-copy reference: {reason}")
            }
            Self::StaleTextureCopy { latest, received } => write!(
                formatter,
                "stale GX texture-copy generation {received}, latest is {latest}"
            ),
            Self::InternalInvariant(reason) => {
                write!(formatter, "resident GX texture invariant failed: {reason}")
            }
        }
    }
}

impl std::error::Error for TextureError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum TextureFormat {
    I4     = 0,
    I8     = 1,
    Ia4    = 2,
    Ia8    = 3,
    Rgb565 = 4,
    Rgb5a3 = 5,
    Rgba8  = 6,
    C4     = 8,
    C8     = 9,
    C14x2  = 10,
    Cmpr   = 14,
}

impl TextureFormat {
    fn from_raw(value: u8) -> Result<Self, TextureError> {
        match value {
            0 => Ok(Self::I4),
            1 => Ok(Self::I8),
            2 => Ok(Self::Ia4),
            3 => Ok(Self::Ia8),
            4 => Ok(Self::Rgb565),
            5 => Ok(Self::Rgb5a3),
            6 => Ok(Self::Rgba8),
            8 => Ok(Self::C4),
            9 => Ok(Self::C8),
            10 => Ok(Self::C14x2),
            14 => Ok(Self::Cmpr),
            _ => Err(TextureError::UnsupportedFormat(value)),
        }
    }

    pub const fn raw(self) -> u8 {
        self as u8
    }

    pub const fn is_indexed(self) -> bool {
        matches!(self, Self::C4 | Self::C8 | Self::C14x2)
    }

    fn palette_entries(self) -> u32 {
        match self {
            Self::C4 => 16,
            Self::C8 => 256,
            Self::C14x2 => 16_384,
            _ => 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum TlutFormat {
    Ia8    = 0,
    Rgb565 = 1,
    Rgb5a3 = 2,
}

impl TlutFormat {
    fn from_raw(value: u8) -> Result<Self, TextureError> {
        match value {
            0 => Ok(Self::Ia8),
            1 => Ok(Self::Rgb565),
            2 => Ok(Self::Rgb5a3),
            _ => Err(TextureError::InvalidTlutFormat(value)),
        }
    }

    pub const fn raw(self) -> u8 {
        self as u8
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StrictV7Classification {
    GenuineMip,
    BaseOnlyCompanion,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StrictV7Rejection {
    NonCanonicalMode0Bits,
    NonCanonicalMode1Bits,
    ReservedMinFilter,
    UnsupportedLodBiasClamp,
    ReservedAnisotropy,
    UnsupportedAnisotropyFilterCombination,
    WrapSRequiresPowerOfTwo,
    WrapTRequiresPowerOfTwo,
    MippedTextureMustBePowerOfTwo,
    IndexedTextureCannotUseMipLinear,
    AnisotropyRequiresMipChain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StrictV7Preflight {
    Accepted(StrictV7Classification),
    Rejected(StrictV7Rejection),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SamplerState {
    pub mode0: u32,
    pub mode1: u32,
    pub wrap_s: u8,
    pub wrap_t: u8,
    pub mag_linear: bool,
    pub min_filter: u8,
    pub mip_mode: u8,
    pub min_linear: bool,
    pub diagonal_lod: bool,
    pub max_anisotropy: u8,
    pub lod_bias_raw: u8,
    pub lod_bias_sixteenths: i8,
    pub lod_min_raw: u8,
    pub lod_max_raw: u8,
    pub effective_lod_min_raw: u8,
    pub effective_lod_max_raw: u8,
    pub strict_v7: StrictV7Preflight,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MipLevel {
    pub level: u8,
    pub width: u32,
    pub height: u32,
    pub blocks_wide: u32,
    pub blocks_high: u32,
    pub encoded_offset: usize,
    pub encoded_bytes: usize,
    pub pixel_offset: usize,
    pub pixel_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PaletteInfo {
    pub offset: u32,
    pub format: TlutFormat,
    pub entries: u32,
    pub hash: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextureOrigin {
    MainMemory,
    ManualTmem {
        even_offset: u32,
        odd_offset: u32,
        generation: u64,
    },
    EfbCopy {
        generation: u32,
    },
}

/// Exact fields needed to construct an `lzgx_packet::TextureInput` without exposing packet bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TexturePacketInput<'a> {
    pub key: &'a str,
    pub pixels: Option<&'a [u8]>,
    pub address: u32,
    pub generation: u32,
    pub width: u32,
    pub height: u32,
    pub mip_level_count: u32,
}

/// One resident-owned canonical texture. Pixel storage stays private so it cannot escape the
/// mutable materializer lease and defeat aggregate live-byte accounting.
#[derive(Debug, PartialEq, Eq)]
pub struct MaterializedTexture {
    map: u8,
    key: String,
    pixels: Option<Vec<u8>>,
    address: u32,
    generation: u32,
    width: u32,
    height: u32,
    format: TextureFormat,
    sampler: SamplerState,
    mip_levels: Vec<MipLevel>,
    source_hash: u32,
    palette: Option<PaletteInfo>,
    origin: TextureOrigin,
    retained_bytes: usize,
}

impl MaterializedTexture {
    pub const fn map(&self) -> u8 {
        self.map
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn pixels(&self) -> Option<&[u8]> {
        self.pixels.as_deref()
    }

    pub const fn address(&self) -> u32 {
        self.address
    }

    pub const fn generation(&self) -> u32 {
        self.generation
    }

    pub const fn width(&self) -> u32 {
        self.width
    }

    pub const fn height(&self) -> u32 {
        self.height
    }

    pub const fn format(&self) -> TextureFormat {
        self.format
    }

    pub const fn sampler(&self) -> SamplerState {
        self.sampler
    }

    pub fn mip_levels(&self) -> &[MipLevel] {
        &self.mip_levels
    }

    pub const fn source_hash(&self) -> u32 {
        self.source_hash
    }

    pub const fn palette(&self) -> Option<PaletteInfo> {
        self.palette
    }

    pub const fn origin(&self) -> TextureOrigin {
        self.origin
    }

    /// Exact owned allocation charge that must follow this texture into a pending packet.
    pub const fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }

    pub fn packet_input(&self) -> TexturePacketInput<'_> {
        TexturePacketInput {
            key: &self.key,
            pixels: self.pixels.as_deref(),
            address: self.address,
            generation: self.generation,
            width: self.width,
            height: self.height,
            mip_level_count: self.mip_levels.len() as u32,
        }
    }
}

/// A batch holds a mutable lifetime lease on its source materializer. The caller can encode all
/// returned textures into one packet, but cannot ask the materializer to retain another batch
/// while these guest-amplified payloads remain live.
#[derive(Debug, PartialEq, Eq)]
pub struct TextureBatch<'materializer> {
    textures: Vec<MaterializedTexture>,
    output_pixel_bytes: usize,
    retained_bytes: usize,
    _lease: PhantomData<&'materializer mut ResidentTextureMaterializer>,
}

impl TextureBatch<'_> {
    pub fn textures(&self) -> &[MaterializedTexture] {
        &self.textures
    }

    pub fn get(&self, map: u8) -> Option<&MaterializedTexture> {
        self.textures.iter().find(|texture| texture.map == map)
    }

    pub const fn output_pixel_bytes(&self) -> usize {
        self.output_pixel_bytes
    }

    pub const fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }

    /// Transfer packet-bound ownership out of the materializer lease. The returned wrapper keeps
    /// the byte charge inseparable from its private textures so a central terminal accumulator can
    /// enforce one global pending-packet ceiling across arbitrarily many decoder batches.
    pub fn into_retained(self) -> RetainedTextureBatch {
        RetainedTextureBatch {
            textures: self.textures,
            output_pixel_bytes: self.output_pixel_bytes,
            retained_bytes: self.retained_bytes,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct RetainedTextureBatch {
    textures: Vec<MaterializedTexture>,
    output_pixel_bytes: usize,
    retained_bytes: usize,
}

impl RetainedTextureBatch {
    pub fn textures(&self) -> &[MaterializedTexture] {
        &self.textures
    }

    pub fn get(&self, map: u8) -> Option<&MaterializedTexture> {
        self.textures.iter().find(|texture| texture.map == map)
    }

    pub const fn output_pixel_bytes(&self) -> usize {
        self.output_pixel_bytes
    }

    pub const fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }

    /// Hand ownership and its exact charges to the central pending-packet accumulator. The tuple
    /// deliberately contains no pixel vectors separate from their `MaterializedTexture` owners.
    pub fn into_parts(self) -> (Vec<MaterializedTexture>, usize, usize) {
        (self.textures, self.output_pixel_bytes, self.retained_bytes)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextureCopyReference {
    pub destination: u32,
    pub generation: u32,
    pub width: u32,
    pub height: u32,
    pub format: u8,
    pub stride: u32,
    pub row_bytes: u32,
    pub row_count: u32,
    pub materialized_hash: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextureStats {
    pub materializations: u64,
    pub decoded_bytes: u64,
    pub source_reads: u64,
    pub source_read_bytes: u64,
    pub automatic_cache_hits: u64,
    pub automatic_cache_stores: u64,
    pub automatic_cache_evictions: u64,
    pub tmem_preloads: u64,
    pub tmem_preload_bytes: u64,
    pub tlut_loads: u64,
    pub tlut_load_bytes: u64,
    pub efb_copy_references: u64,
    pub efb_copy_hash_misses: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TextureLayout {
    block_width: u32,
    block_height: u32,
    block_bytes: u32,
}

impl TextureLayout {
    const fn for_format(format: TextureFormat) -> Self {
        match format {
            TextureFormat::I4 | TextureFormat::C4 | TextureFormat::Cmpr => Self {
                block_width: 8,
                block_height: 8,
                block_bytes: 32,
            },
            TextureFormat::I8 | TextureFormat::Ia4 | TextureFormat::C8 => Self {
                block_width: 8,
                block_height: 4,
                block_bytes: 32,
            },
            TextureFormat::Ia8
            | TextureFormat::Rgb565
            | TextureFormat::Rgb5a3
            | TextureFormat::C14x2 => Self {
                block_width: 4,
                block_height: 4,
                block_bytes: 32,
            },
            TextureFormat::Rgba8 => Self {
                block_width: 4,
                block_height: 4,
                block_bytes: 64,
            },
        }
    }
}

#[derive(Debug)]
struct TexturePlan {
    snapshot: TextureRegisterSnapshot,
    format: TextureFormat,
    layout: TextureLayout,
    width: u32,
    height: u32,
    address: u32,
    manual_tmem: bool,
    even_offset: usize,
    odd_offset: usize,
    mip_levels: Vec<MipLevel>,
    encoded_bytes: usize,
    decoded_bytes: usize,
    sampler: SamplerState,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct CacheBank {
    base: usize,
    size: usize,
}

impl CacheBank {
    fn overlaps(self, other: Self) -> bool {
        if self.size == 0 || other.size == 0 {
            return false;
        }
        let Some(self_end) = self.base.checked_add(self.size) else {
            return true;
        };
        let Some(other_end) = other.base.checked_add(other.size) else {
            return true;
        };
        self.base < other_end && other.base < self_end
    }

    fn within_tmem(self) -> bool {
        self.base
            .checked_add(self.size)
            .is_some_and(|end| end <= TMEM_BYTES)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct CacheGeometry {
    even: CacheBank,
    odd: CacheBank,
    fits: bool,
}

impl CacheGeometry {
    fn overlaps(self, other: Self) -> bool {
        self.even.overlaps(other.even)
            || self.even.overlaps(other.odd)
            || self.odd.overlaps(other.even)
            || self.odd.overlaps(other.odd)
    }
}

#[derive(Debug, Default)]
struct TextureCacheSlot {
    identity: Option<TextureRegisterSnapshot>,
    source: Vec<u8>,
    source_hash: u32,
    geometry: CacheGeometry,
}

impl TextureCacheSlot {
    fn clear(&mut self) -> usize {
        let bytes = self.source.capacity();
        *self = Self::default();
        bytes
    }
}

#[derive(Debug)]
pub struct ResidentTextureMaterializer {
    limits: TextureLimits,
    bp: [u32; 0x100],
    tmem: Vec<u8>,
    tmem_generation: u64,
    slots: [TextureCacheSlot; TEXTURE_MAP_COUNT],
    cache_bytes: usize,
    texture_copies: Vec<TextureCopyReference>,
    latest_texture_copy_generation: u32,
    stats: TextureStats,
}

impl ResidentTextureMaterializer {
    pub fn try_new(limits: TextureLimits) -> Result<Self, TextureError> {
        let limits = limits.validate()?;
        let mut tmem = Vec::new();
        tmem.try_reserve_exact(TMEM_BYTES)
            .map_err(|_| TextureError::Allocation {
                site: TextureAllocationSite::Tmem,
            })?;
        tmem.resize(TMEM_BYTES, 0);
        let mut bp = [0; 0x100];
        bp[0xfe] = BP_WORD_MAX;
        Ok(Self {
            limits,
            bp,
            tmem,
            tmem_generation: 0,
            slots: core::array::from_fn(|_| TextureCacheSlot::default()),
            cache_bytes: 0,
            texture_copies: Vec::new(),
            latest_texture_copy_generation: 0,
            stats: TextureStats::default(),
        })
    }

    pub fn limits(&self) -> TextureLimits {
        self.limits
    }

    pub fn bp_registers(&self) -> &[u32; 0x100] {
        &self.bp
    }

    pub fn tmem(&self) -> &[u8] {
        &self.tmem
    }

    pub const fn tmem_generation(&self) -> u64 {
        self.tmem_generation
    }

    pub const fn cache_bytes(&self) -> usize {
        self.cache_bytes
    }

    pub const fn stats(&self) -> TextureStats {
        self.stats
    }

    /// Replay one semantic record at its exact position in the FIFO stream. A caller must stop at
    /// every `SemanticRecord::Draw`, materialize its draw-local snapshots, and transfer/drop the
    /// returned lease before replaying the following record.
    pub fn replay_record<M: GxMemory>(
        &mut self,
        record: &SemanticRecord,
        memory: &mut M,
    ) -> Result<(), TextureError> {
        if let SemanticRecord::BpLoad { register, value } = *record {
            self.apply_bp_load(register, value, memory)?;
        }
        Ok(())
    }

    /// Apply one already mask-resolved BP record. TMEM-producing commands stage the complete
    /// source before changing TMEM, so a failed guest read cannot leave a partial upload.
    pub fn apply_bp_load<M: GxMemory>(
        &mut self,
        register: u8,
        value: u32,
        memory: &mut M,
    ) -> Result<(), TextureError> {
        if value > BP_WORD_MAX {
            return Err(TextureError::InvalidBpValue { register, value });
        }
        self.bp[usize::from(register)] = value;
        if let Some(map) = texture_map_for_register(register) {
            self.clear_cache_slot(map)?;
        }
        match register {
            0x63 if value != 0 => self.execute_preload(memory),
            0x65 => self.execute_tlut_load(memory),
            0x66 => {
                self.invalidate_texture_cache();
                Ok(())
            }
            _ => Ok(()),
        }
    }

    pub fn invalidate_texture_cache(&mut self) {
        for slot in &mut self.slots {
            if slot.source.capacity() != 0 {
                self.stats.automatic_cache_evictions =
                    self.stats.automatic_cache_evictions.saturating_add(1);
            }
            *slot = TextureCacheSlot::default();
        }
        self.cache_bytes = 0;
    }

    pub fn record_texture_copy(
        &mut self,
        reference: TextureCopyReference,
    ) -> Result<(), TextureError> {
        validate_texture_copy(reference)?;
        if reference.generation <= self.latest_texture_copy_generation {
            return Err(TextureError::StaleTextureCopy {
                latest: self.latest_texture_copy_generation,
                received: reference.generation,
            });
        }
        let replaced = self
            .texture_copies
            .iter()
            .position(|entry| entry.destination == reference.destination);
        let needs_growth = replaced.is_none()
            && self.texture_copies.len() < self.limits.maximum_texture_copy_references
            && self.texture_copies.len() == self.texture_copies.capacity();
        if needs_growth {
            self.texture_copies
                .try_reserve_exact(1)
                .map_err(|_| TextureError::Allocation {
                    site: TextureAllocationSite::TextureCopyReferences,
                })?;
        }
        if let Some(index) = replaced {
            self.texture_copies.remove(index);
        } else if self.texture_copies.len() == self.limits.maximum_texture_copy_references {
            self.texture_copies.remove(0);
        }
        self.texture_copies.push(reference);
        self.latest_texture_copy_generation = reference.generation;
        Ok(())
    }

    pub fn materialize_draw<'materializer, M: GxMemory>(
        &'materializer mut self,
        draw: &DrawSnapshot,
        memory: &mut M,
    ) -> Result<TextureBatch<'materializer>, TextureError> {
        let mut mask = 0u8;
        for texture_use in draw.texture_use_order.as_slice().iter().flatten() {
            mask |= 1 << texture_use.texture_map;
        }
        self.materialize_maps(&draw.textures, mask, memory)
    }

    pub fn materialize_map<'materializer, M: GxMemory>(
        &'materializer mut self,
        map: u8,
        snapshot: TextureRegisterSnapshot,
        memory: &mut M,
    ) -> Result<TextureBatch<'materializer>, TextureError> {
        if usize::from(map) >= TEXTURE_MAP_COUNT {
            return Err(TextureError::InvalidTextureMap(map));
        }
        let mut snapshots = [TextureRegisterSnapshot::default(); TEXTURE_MAP_COUNT];
        snapshots[usize::from(map)] = snapshot;
        self.materialize_maps(&snapshots, 1 << map, memory)
    }

    pub fn materialize_maps<'materializer, M: GxMemory>(
        &'materializer mut self,
        snapshots: &[TextureRegisterSnapshot; TEXTURE_MAP_COUNT],
        used_map_mask: u8,
        memory: &mut M,
    ) -> Result<TextureBatch<'materializer>, TextureError> {
        let mut plans: [Option<TexturePlan>; TEXTURE_MAP_COUNT] = core::array::from_fn(|_| None);
        let mut requested = 0usize;
        for map in 0..TEXTURE_MAP_COUNT {
            if used_map_mask & (1 << map) == 0 {
                continue;
            }
            plans[map] = Some(self.build_plan(snapshots[map])?);
            requested += 1;
        }
        let mut textures = Vec::new();
        textures
            .try_reserve_exact(requested)
            .map_err(|_| TextureError::Allocation {
                site: TextureAllocationSite::Batch,
            })?;

        let cacheable = self.prepare_cache_geometry(&plans)?;
        let mut output_pixel_bytes = 0usize;
        let mut retained_bytes = 0usize;
        for map in 0..TEXTURE_MAP_COUNT {
            let Some(plan) = plans[map].as_ref() else {
                continue;
            };
            let texture =
                self.materialize_plan(map as u8, plan, cacheable[map], output_pixel_bytes, memory)?;
            output_pixel_bytes = output_pixel_bytes
                .checked_add(texture.pixels.as_ref().map_or(0, Vec::capacity))
                .ok_or(TextureError::ArithmeticOverflow("texture batch output"))?;
            if output_pixel_bytes > self.limits.maximum_output_bytes {
                return Err(TextureError::OutputTooLarge {
                    requested: output_pixel_bytes,
                    maximum: self.limits.maximum_output_bytes,
                });
            }
            retained_bytes = retained_bytes.checked_add(texture.retained_bytes).ok_or(
                TextureError::ArithmeticOverflow("retained texture batch bytes"),
            )?;
            textures.push(texture);
        }

        Ok(TextureBatch {
            textures,
            output_pixel_bytes,
            retained_bytes,
            _lease: PhantomData,
        })
    }

    fn build_plan(&self, snapshot: TextureRegisterSnapshot) -> Result<TexturePlan, TextureError> {
        let width = (snapshot.image0 & 0x3ff) + 1;
        let height = ((snapshot.image0 >> 10) & 0x3ff) + 1;
        if width > MAX_TEXTURE_DIMENSION || height > MAX_TEXTURE_DIMENSION {
            return Err(TextureError::InternalInvariant(
                "BP texture dimensions exceed their field width",
            ));
        }
        let format = TextureFormat::from_raw(((snapshot.image0 >> 20) & 0xf) as u8)?;
        let layout = TextureLayout::for_format(format);
        let mip_mode = ((snapshot.mode0 >> 5) & 3) as u8;
        if mip_mode == 3 {
            return Err(TextureError::ReservedMipFilter(
                ((snapshot.mode0 >> 5) & 7) as u8,
            ));
        }
        let theoretical_levels = max_mip_levels(width, height);
        let level_count = if mip_mode == 0 {
            1
        } else {
            let max_lod_raw = ((snapshot.mode1 >> 8) & 0xff) as u8;
            let requested = u32::from(max_lod_raw).div_ceil(16) + 1;
            theoretical_levels.min(requested)
        };
        let (mip_levels, encoded_bytes, decoded_bytes) =
            build_mip_layout(width, height, layout, level_count, self.limits)?;
        let sampler = sampler_state(
            snapshot.mode0,
            snapshot.mode1,
            format,
            width,
            height,
            level_count,
        );
        Ok(TexturePlan {
            snapshot,
            format,
            layout,
            width,
            height,
            address: snapshot.image3 << 5,
            manual_tmem: snapshot.image1 & 0x0020_0000 != 0,
            even_offset: ((snapshot.image1 & 0x7fff) as usize) * TMEM_LINE_BYTES,
            odd_offset: ((snapshot.image2 & 0x7fff) as usize) * TMEM_LINE_BYTES,
            mip_levels,
            encoded_bytes,
            decoded_bytes,
            sampler,
        })
    }

    fn materialize_plan<M: GxMemory>(
        &mut self,
        map: u8,
        plan: &TexturePlan,
        cacheable: bool,
        prior_output_bytes: usize,
        memory: &mut M,
    ) -> Result<MaterializedTexture, TextureError> {
        let map_index = usize::from(map);
        let cache_hit = !plan.manual_tmem
            && cacheable
            && self.slots[map_index].identity == Some(plan.snapshot)
            && self.slots[map_index].source.len() == plan.encoded_bytes;

        if cache_hit {
            let source_hash = self.slots[map_index].source_hash;
            let source = &self.slots[map_index].source;
            let texture = materialize_source(
                map,
                plan,
                source,
                source_hash,
                &self.tmem,
                self.tmem_generation,
                None,
                prior_output_bytes,
                self.cache_bytes,
                self.tmem.capacity(),
                0,
                self.limits,
            )?;
            self.stats.automatic_cache_hits = self.stats.automatic_cache_hits.saturating_add(1);
            self.note_materialization(&texture);
            return Ok(texture);
        }

        let source = if plan.manual_tmem {
            gather_tmem_source(plan, &self.tmem, self.limits)?
        } else {
            self.read_source(plan.address, plan.encoded_bytes, memory)?
        };
        let source_hash = materialized_texture_hash(&source);

        let copy_reference = if plan.manual_tmem {
            None
        } else {
            self.match_texture_copy(plan, source_hash)
        };
        let texture = materialize_source(
            map,
            plan,
            &source,
            source_hash,
            &self.tmem,
            self.tmem_generation,
            copy_reference,
            prior_output_bytes,
            self.cache_bytes,
            self.tmem.capacity(),
            source.capacity(),
            self.limits,
        )?;

        if cacheable && !plan.manual_tmem {
            self.store_cache(
                map_index,
                plan.snapshot,
                source,
                source_hash,
                cache_geometry(plan)?,
            )?;
        }
        if matches!(texture.origin, TextureOrigin::EfbCopy { .. }) {
            self.stats.efb_copy_references = self.stats.efb_copy_references.saturating_add(1);
        }
        self.note_materialization(&texture);
        Ok(texture)
    }

    fn note_materialization(&mut self, texture: &MaterializedTexture) {
        self.stats.materializations = self.stats.materializations.saturating_add(1);
        self.stats.decoded_bytes = self
            .stats
            .decoded_bytes
            .saturating_add(texture.pixels.as_ref().map_or(0, |pixels| pixels.len()) as u64);
    }

    fn read_source<M: GxMemory>(
        &mut self,
        address: u32,
        length: usize,
        memory: &mut M,
    ) -> Result<Vec<u8>, TextureError> {
        validate_u32_range(address, length)?;
        let mut source = allocate_zeroed(length, TextureAllocationSite::Source)?;
        memory
            .read_exact(address, &mut source)
            .map_err(|source| TextureError::MemoryRead {
                address,
                length,
                source,
            })?;
        self.stats.source_reads = self.stats.source_reads.saturating_add(1);
        self.stats.source_read_bytes = self.stats.source_read_bytes.saturating_add(length as u64);
        Ok(source)
    }

    fn match_texture_copy(
        &mut self,
        plan: &TexturePlan,
        source_hash: u32,
    ) -> Option<TextureCopyReference> {
        let index = self
            .texture_copies
            .iter()
            .position(|entry| entry.destination == plan.address)?;
        let reference = self.texture_copies[index];
        let compatible = plan.mip_levels.len() == 1
            && reference.width == plan.width
            && reference.height == plan.height
            && reference.format == plan.format.raw()
            && reference.stride == reference.row_bytes
            && reference.row_count == plan.height.div_ceil(plan.layout.block_height)
            && reference.materialized_hash == source_hash;
        if compatible {
            Some(reference)
        } else {
            self.texture_copies.remove(index);
            self.stats.efb_copy_hash_misses = self.stats.efb_copy_hash_misses.saturating_add(1);
            None
        }
    }

    fn execute_preload<M: GxMemory>(&mut self, memory: &mut M) -> Result<(), TextureError> {
        let source_address = (self.bp[0x60] << 5) & 0x01ff_ffff;
        let even_offset = ((self.bp[0x61] & 0x7fff) as usize) * TMEM_LINE_BYTES;
        let odd_offset = ((self.bp[0x62] & 0x7fff) as usize) * TMEM_LINE_BYTES;
        let command = self.bp[0x63];
        let line_count = (command & 0x7fff) as usize;
        let preload_type = (command >> 15) & 3;
        if line_count == 0 {
            return Ok(());
        }
        let source_bytes = line_count
            .checked_mul(if preload_type == 3 { 64 } else { 32 })
            .ok_or(TextureError::ArithmeticOverflow("TMEM preload bytes"))?;
        self.validate_tmem_transfer(source_bytes)?;
        validate_u32_range(source_address, source_bytes)?;
        let mut staging = allocate_zeroed(source_bytes, TextureAllocationSite::TmemTransfer)?;
        memory
            .read_exact(source_address, &mut staging)
            .map_err(|source| TextureError::MemoryRead {
                address: source_address,
                length: source_bytes,
                source,
            })?;
        let next_generation = self
            .tmem_generation
            .checked_add(1)
            .ok_or(TextureError::ArithmeticOverflow("TMEM generation"))?;

        if preload_type == 3 {
            let bank_bytes = line_count
                .checked_mul(TMEM_LINE_BYTES)
                .ok_or(TextureError::ArithmeticOverflow("split TMEM preload bytes"))?;
            validate_tmem_range(TmemBank::Even, even_offset, bank_bytes)?;
            validate_tmem_range(TmemBank::Odd, odd_offset, bank_bytes)?;
            for line in 0..line_count {
                let source = line * 64;
                let even = even_offset + line * TMEM_LINE_BYTES;
                let odd = odd_offset + line * TMEM_LINE_BYTES;
                self.tmem[even..even + TMEM_LINE_BYTES]
                    .copy_from_slice(&staging[source..source + TMEM_LINE_BYTES]);
                self.tmem[odd..odd + TMEM_LINE_BYTES]
                    .copy_from_slice(&staging[source + TMEM_LINE_BYTES..source + 64]);
            }
        } else {
            validate_tmem_range(TmemBank::Even, even_offset, source_bytes)?;
            self.tmem[even_offset..even_offset + source_bytes].copy_from_slice(&staging);
        }
        self.tmem_generation = next_generation;
        self.invalidate_texture_cache();
        self.stats.tmem_preloads = self.stats.tmem_preloads.saturating_add(1);
        self.stats.tmem_preload_bytes = self
            .stats
            .tmem_preload_bytes
            .saturating_add(source_bytes as u64);
        Ok(())
    }

    fn execute_tlut_load<M: GxMemory>(&mut self, memory: &mut M) -> Result<(), TextureError> {
        let source_address = (self.bp[0x64] << 5) & 0x01ff_ffff;
        let destination = ((self.bp[0x65] & 0x3ff) as usize) << 9;
        let byte_count = (((self.bp[0x65] >> 10) & 0x7ff) as usize)
            .checked_mul(TMEM_LINE_BYTES)
            .ok_or(TextureError::ArithmeticOverflow("TLUT load bytes"))?;
        if byte_count == 0 {
            return Ok(());
        }
        self.validate_tmem_transfer(byte_count)?;
        validate_tmem_range(TmemBank::Tlut, destination, byte_count)?;
        validate_u32_range(source_address, byte_count)?;
        let mut staging = allocate_zeroed(byte_count, TextureAllocationSite::TmemTransfer)?;
        memory
            .read_exact(source_address, &mut staging)
            .map_err(|source| TextureError::MemoryRead {
                address: source_address,
                length: byte_count,
                source,
            })?;
        let next_generation = self
            .tmem_generation
            .checked_add(1)
            .ok_or(TextureError::ArithmeticOverflow("TMEM generation"))?;
        self.tmem[destination..destination + byte_count].copy_from_slice(&staging);
        self.tmem_generation = next_generation;
        self.invalidate_texture_cache();
        self.stats.tlut_loads = self.stats.tlut_loads.saturating_add(1);
        self.stats.tlut_load_bytes = self.stats.tlut_load_bytes.saturating_add(byte_count as u64);
        Ok(())
    }

    fn validate_tmem_transfer(&self, requested: usize) -> Result<(), TextureError> {
        if requested > self.limits.maximum_tmem_transfer_bytes {
            return Err(TextureError::TmemTransferTooLarge {
                requested,
                maximum: self.limits.maximum_tmem_transfer_bytes,
            });
        }
        let resident = self
            .tmem
            .capacity()
            .checked_add(self.cache_bytes)
            .and_then(|value| value.checked_add(requested))
            .ok_or(TextureError::ArithmeticOverflow(
                "TMEM transfer resident bytes",
            ))?;
        if resident > self.limits.maximum_resident_bytes {
            return Err(TextureError::ResidentBytes {
                requested: resident,
                maximum: self.limits.maximum_resident_bytes,
            });
        }
        Ok(())
    }

    fn prepare_cache_geometry(
        &mut self,
        plans: &[Option<TexturePlan>; TEXTURE_MAP_COUNT],
    ) -> Result<[bool; TEXTURE_MAP_COUNT], TextureError> {
        let mut geometries = [CacheGeometry::default(); TEXTURE_MAP_COUNT];
        let mut eligible = [false; TEXTURE_MAP_COUNT];
        for map in 0..TEXTURE_MAP_COUNT {
            if let Some(plan) = plans[map].as_ref() {
                if !plan.manual_tmem {
                    geometries[map] = cache_geometry(plan)?;
                    eligible[map] = geometries[map].fits
                        && geometries[map].even.within_tmem()
                        && geometries[map].odd.within_tmem()
                        && !geometries[map].even.overlaps(geometries[map].odd);
                }
            } else if self.slots[map].identity.is_some() {
                geometries[map] = self.slots[map].geometry;
            }
        }
        for left in 0..TEXTURE_MAP_COUNT {
            if plans[left].is_none() || !eligible[left] {
                continue;
            }
            for right in 0..TEXTURE_MAP_COUNT {
                if left == right || self.slots[right].identity.is_none() && plans[right].is_none() {
                    continue;
                }
                if geometries[left].overlaps(geometries[right]) {
                    eligible[left] = false;
                    if plans[right].is_some() {
                        eligible[right] = false;
                    } else {
                        self.clear_cache_slot(right)?;
                    }
                }
            }
        }
        Ok(eligible)
    }

    fn store_cache(
        &mut self,
        map: usize,
        identity: TextureRegisterSnapshot,
        source: Vec<u8>,
        source_hash: u32,
        geometry: CacheGeometry,
    ) -> Result<(), TextureError> {
        self.clear_cache_slot(map)?;
        let bytes = source.capacity();
        let next_cache =
            self.cache_bytes
                .checked_add(bytes)
                .ok_or(TextureError::ArithmeticOverflow(
                    "automatic texture cache bytes",
                ))?;
        if next_cache > self.limits.maximum_cache_bytes {
            return Ok(());
        }
        let resident = self.tmem.capacity().checked_add(next_cache).ok_or(
            TextureError::ArithmeticOverflow("automatic cache resident bytes"),
        )?;
        if resident > self.limits.maximum_resident_bytes {
            return Err(TextureError::ResidentBytes {
                requested: resident,
                maximum: self.limits.maximum_resident_bytes,
            });
        }
        self.slots[map] = TextureCacheSlot {
            identity: Some(identity),
            source,
            source_hash,
            geometry,
        };
        self.cache_bytes = next_cache;
        self.stats.automatic_cache_stores = self.stats.automatic_cache_stores.saturating_add(1);
        Ok(())
    }

    fn clear_cache_slot(&mut self, map: usize) -> Result<(), TextureError> {
        let removed = self.slots[map].clear();
        if removed != 0 {
            self.cache_bytes =
                self.cache_bytes
                    .checked_sub(removed)
                    .ok_or(TextureError::InternalInvariant(
                        "automatic texture cache accounting",
                    ))?;
            self.stats.automatic_cache_evictions =
                self.stats.automatic_cache_evictions.saturating_add(1);
        }
        Ok(())
    }
}

fn texture_map_for_register(register: u8) -> Option<usize> {
    for (bank, base) in [(0usize, 0x80u8), (4usize, 0xa0u8)] {
        let relative = register.checked_sub(base)?;
        if relative < 0x1c {
            return Some(bank + usize::from(relative & 3));
        }
    }
    None
}

fn build_mip_layout(
    width: u32,
    height: u32,
    layout: TextureLayout,
    level_count: u32,
    limits: TextureLimits,
) -> Result<(Vec<MipLevel>, usize, usize), TextureError> {
    if level_count == 0 || level_count as usize > MAX_MIP_LEVELS {
        return Err(TextureError::InternalInvariant("invalid mip level count"));
    }
    let mut levels = Vec::new();
    levels
        .try_reserve_exact(level_count as usize)
        .map_err(|_| TextureError::Allocation {
            site: TextureAllocationSite::MipLayout,
        })?;
    let mut level_width = width;
    let mut level_height = height;
    let mut encoded_offset = 0usize;
    let mut pixel_offset = 0usize;
    for level in 0..level_count {
        let blocks_wide = level_width.div_ceil(layout.block_width);
        let blocks_high = level_height.div_ceil(layout.block_height);
        let encoded_bytes = usize::try_from(
            blocks_wide
                .checked_mul(blocks_high)
                .and_then(|value| value.checked_mul(layout.block_bytes))
                .ok_or(TextureError::ArithmeticOverflow("mip encoded bytes"))?,
        )
        .map_err(|_| TextureError::ArithmeticOverflow("mip encoded bytes"))?;
        let pixel_bytes = usize::try_from(
            level_width
                .checked_mul(level_height)
                .and_then(|value| value.checked_mul(4))
                .ok_or(TextureError::ArithmeticOverflow("mip pixel bytes"))?,
        )
        .map_err(|_| TextureError::ArithmeticOverflow("mip pixel bytes"))?;
        levels.push(MipLevel {
            level: level as u8,
            width: level_width,
            height: level_height,
            blocks_wide,
            blocks_high,
            encoded_offset,
            encoded_bytes,
            pixel_offset,
            pixel_bytes,
        });
        encoded_offset = encoded_offset
            .checked_add(encoded_bytes)
            .ok_or(TextureError::ArithmeticOverflow("mip source end"))?;
        pixel_offset = pixel_offset
            .checked_add(pixel_bytes)
            .ok_or(TextureError::ArithmeticOverflow("mip pixel end"))?;
        level_width = (level_width / 2).max(1);
        level_height = (level_height / 2).max(1);
    }
    if encoded_offset > limits.maximum_source_bytes {
        return Err(TextureError::SourceTooLarge {
            requested: encoded_offset,
            maximum: limits.maximum_source_bytes,
        });
    }
    if pixel_offset > limits.maximum_output_bytes {
        return Err(TextureError::OutputTooLarge {
            requested: pixel_offset,
            maximum: limits.maximum_output_bytes,
        });
    }
    Ok((levels, encoded_offset, pixel_offset))
}

fn max_mip_levels(width: u32, height: u32) -> u32 {
    u32::BITS - width.max(height).leading_zeros()
}

fn sampler_state(
    raw_mode0: u32,
    raw_mode1: u32,
    format: TextureFormat,
    width: u32,
    height: u32,
    level_count: u32,
) -> SamplerState {
    let mode0 = raw_mode0 & 0x0039_ffff;
    let mode1 = raw_mode1 & 0xffff;
    let min_filter = ((mode0 >> 5) & 7) as u8;
    let mip_mode = min_filter & 3;
    let uses_mips = mip_mode != 0;
    let lod_min_raw = (mode1 & 0xff) as u8;
    let lod_max_raw = ((mode1 >> 8) & 0xff) as u8;
    let resident_max = ((level_count - 1).saturating_mul(16)).min(0xff) as u8;
    let effective_lod_max_raw = if uses_mips {
        lod_max_raw.min(resident_max)
    } else {
        0
    };
    let effective_lod_min_raw = if uses_mips {
        lod_min_raw.min(effective_lod_max_raw)
    } else {
        0
    };
    let lod_bias_raw = ((mode0 >> 9) & 0xff) as u8;
    let strict_v7 = strict_v7_preflight(raw_mode0, raw_mode1, format, width, height, level_count);
    SamplerState {
        mode0,
        mode1,
        wrap_s: (mode0 & 3) as u8,
        wrap_t: ((mode0 >> 2) & 3) as u8,
        mag_linear: mode0 & (1 << 4) != 0,
        min_filter,
        mip_mode,
        min_linear: mode0 & (1 << 7) != 0,
        diagonal_lod: mode0 & (1 << 8) != 0,
        max_anisotropy: 1 << ((mode0 >> 19) & 3),
        lod_bias_raw,
        lod_bias_sixteenths: (lod_bias_raw as i8) >> 1,
        lod_min_raw,
        lod_max_raw,
        effective_lod_min_raw,
        effective_lod_max_raw,
        strict_v7,
    }
}

fn strict_v7_preflight(
    raw_mode0: u32,
    raw_mode1: u32,
    format: TextureFormat,
    width: u32,
    height: u32,
    level_count: u32,
) -> StrictV7Preflight {
    let reject = StrictV7Preflight::Rejected;
    if raw_mode0 & !0x0039_ffff != 0 {
        return reject(StrictV7Rejection::NonCanonicalMode0Bits);
    }
    if raw_mode1 & !0x0000_ffff != 0 {
        return reject(StrictV7Rejection::NonCanonicalMode1Bits);
    }
    let min_filter = ((raw_mode0 >> 5) & 7) as u8;
    let mip_mode = min_filter & 3;
    if mip_mode == 3 {
        return reject(StrictV7Rejection::ReservedMinFilter);
    }
    if raw_mode0 & (1 << 21) != 0 {
        return reject(StrictV7Rejection::UnsupportedLodBiasClamp);
    }
    let anisotropy = ((raw_mode0 >> 19) & 3) as u8;
    if anisotropy == 3 {
        return reject(StrictV7Rejection::ReservedAnisotropy);
    }
    let mag_linear = raw_mode0 & (1 << 4) != 0;
    let min_linear = raw_mode0 & (1 << 7) != 0;
    let diagonal_lod = raw_mode0 & (1 << 8) != 0;
    let native_anisotropy = anisotropy != 0 && !diagonal_lod;
    if native_anisotropy && (!mag_linear || !min_linear || min_filter != 6) {
        return reject(StrictV7Rejection::UnsupportedAnisotropyFilterCombination);
    }
    let power_of_two = |value: u32| value.is_power_of_two();
    let wrap_s = raw_mode0 & 3;
    let wrap_t = (raw_mode0 >> 2) & 3;
    if matches!(wrap_s, 1 | 2) && !power_of_two(width) {
        return reject(StrictV7Rejection::WrapSRequiresPowerOfTwo);
    }
    if matches!(wrap_t, 1 | 2) && !power_of_two(height) {
        return reject(StrictV7Rejection::WrapTRequiresPowerOfTwo);
    }
    if mip_mode != 0 && (!power_of_two(width) || !power_of_two(height)) {
        return reject(StrictV7Rejection::MippedTextureMustBePowerOfTwo);
    }
    if format.is_indexed() && mip_mode == 2 {
        return reject(StrictV7Rejection::IndexedTextureCannotUseMipLinear);
    }
    if native_anisotropy && level_count < 2 {
        return reject(StrictV7Rejection::AnisotropyRequiresMipChain);
    }
    StrictV7Preflight::Accepted(if mip_mode != 0 && level_count > 1 {
        StrictV7Classification::GenuineMip
    } else {
        StrictV7Classification::BaseOnlyCompanion
    })
}

fn cache_geometry(plan: &TexturePlan) -> Result<CacheGeometry, TextureError> {
    let even_capacity = cache_bank_capacity(plan.snapshot.image1)?;
    let odd_capacity = cache_bank_capacity(plan.snapshot.image2)?;
    let base = plan
        .mip_levels
        .first()
        .ok_or(TextureError::InternalInvariant("texture has no base mip"))?;
    let block_count = usize::try_from(base.blocks_wide.checked_mul(base.blocks_high).ok_or(
        TextureError::ArithmeticOverflow("texture cache block count"),
    )?)
    .map_err(|_| TextureError::ArithmeticOverflow("texture cache block count"))?;
    let required_bank_bytes = block_count
        .checked_mul(TMEM_LINE_BYTES)
        .ok_or(TextureError::ArithmeticOverflow("texture cache bank bytes"))?;
    let mipmapped = plan.mip_levels.len() > 1;
    let uses_odd = mipmapped || plan.format == TextureFormat::Rgba8;
    let even_size = if mipmapped {
        even_capacity
            .checked_mul(2)
            .ok_or(TextureError::ArithmeticOverflow("even texture cache size"))?
    } else {
        even_capacity
    };
    let odd_size = if uses_odd {
        if mipmapped && plan.format == TextureFormat::Rgba8 {
            odd_capacity
                .checked_mul(2)
                .ok_or(TextureError::ArithmeticOverflow("odd texture cache size"))?
        } else {
            odd_capacity
        }
    } else {
        0
    };
    Ok(CacheGeometry {
        even: CacheBank {
            base: plan.even_offset,
            size: even_size,
        },
        odd: CacheBank {
            base: plan.odd_offset,
            size: odd_size,
        },
        fits: required_bank_bytes <= even_capacity
            && (!uses_odd || required_bank_bytes <= odd_capacity),
    })
}

fn cache_bank_capacity(word: u32) -> Result<usize, TextureError> {
    let width = (word >> 15) & 7;
    let height = (word >> 18) & 7;
    512usize
        .checked_shl(width)
        .and_then(|value| value.checked_shl(height))
        .ok_or(TextureError::ArithmeticOverflow(
            "texture cache bank capacity",
        ))
}

fn gather_tmem_source(
    plan: &TexturePlan,
    tmem: &[u8],
    limits: TextureLimits,
) -> Result<Vec<u8>, TextureError> {
    let resident =
        tmem.len()
            .checked_add(plan.encoded_bytes)
            .ok_or(TextureError::ArithmeticOverflow(
                "manual TMEM source resident bytes",
            ))?;
    if resident > limits.maximum_resident_bytes {
        return Err(TextureError::ResidentBytes {
            requested: resident,
            maximum: limits.maximum_resident_bytes,
        });
    }
    let mut source = allocate_zeroed(plan.encoded_bytes, TextureAllocationSite::Source)?;
    let mut even_cursor = plan.even_offset;
    let mut odd_cursor = plan.odd_offset;
    if plan.format == TextureFormat::Rgba8 {
        for level in &plan.mip_levels {
            let blocks = usize::try_from(
                level
                    .blocks_wide
                    .checked_mul(level.blocks_high)
                    .ok_or(TextureError::ArithmeticOverflow("RGBA8 TMEM blocks"))?,
            )
            .map_err(|_| TextureError::ArithmeticOverflow("RGBA8 TMEM blocks"))?;
            for block in 0..blocks {
                validate_tmem_range(TmemBank::Even, even_cursor, TMEM_LINE_BYTES)?;
                validate_tmem_range(TmemBank::Odd, odd_cursor, TMEM_LINE_BYTES)?;
                let destination = level
                    .encoded_offset
                    .checked_add(block * 64)
                    .ok_or(TextureError::ArithmeticOverflow("RGBA8 TMEM destination"))?;
                source[destination..destination + TMEM_LINE_BYTES]
                    .copy_from_slice(&tmem[even_cursor..even_cursor + TMEM_LINE_BYTES]);
                source[destination + TMEM_LINE_BYTES..destination + 64]
                    .copy_from_slice(&tmem[odd_cursor..odd_cursor + TMEM_LINE_BYTES]);
                even_cursor += TMEM_LINE_BYTES;
                odd_cursor += TMEM_LINE_BYTES;
            }
        }
    } else {
        for level in &plan.mip_levels {
            let (bank, cursor) = if level.level & 1 == 0 {
                (TmemBank::Even, &mut even_cursor)
            } else {
                (TmemBank::Odd, &mut odd_cursor)
            };
            validate_tmem_range(bank, *cursor, level.encoded_bytes)?;
            source[level.encoded_offset..level.encoded_offset + level.encoded_bytes]
                .copy_from_slice(&tmem[*cursor..*cursor + level.encoded_bytes]);
            *cursor += level.encoded_bytes;
        }
    }
    Ok(source)
}

#[allow(clippy::too_many_arguments)]
fn materialize_source(
    map: u8,
    plan: &TexturePlan,
    source: &[u8],
    source_hash: u32,
    tmem: &[u8],
    tmem_generation: u64,
    copy_reference: Option<TextureCopyReference>,
    prior_output_bytes: usize,
    cache_bytes: usize,
    tmem_capacity: usize,
    source_staging_bytes: usize,
    limits: TextureLimits,
) -> Result<MaterializedTexture, TextureError> {
    if source.len() != plan.encoded_bytes {
        return Err(TextureError::InternalInvariant(
            "encoded texture source length mismatch",
        ));
    }
    let palette = palette_info(plan, tmem)?;
    let generation = copy_reference.map_or(0, |reference| reference.generation);
    let origin = if let Some(reference) = copy_reference {
        TextureOrigin::EfbCopy {
            generation: reference.generation,
        }
    } else if plan.manual_tmem {
        TextureOrigin::ManualTmem {
            even_offset: plan.even_offset as u32,
            odd_offset: plan.odd_offset as u32,
            generation: tmem_generation,
        }
    } else {
        TextureOrigin::MainMemory
    };
    let key = texture_key(map, plan, source_hash, palette, origin, generation)?;
    let pixels = if copy_reference.is_some() {
        None
    } else {
        let prospective = prior_output_bytes
            .checked_add(plan.decoded_bytes)
            .ok_or(TextureError::ArithmeticOverflow("texture output bytes"))?;
        if prospective > limits.maximum_output_bytes {
            return Err(TextureError::OutputTooLarge {
                requested: prospective,
                maximum: limits.maximum_output_bytes,
            });
        }
        let resident = tmem_capacity
            .checked_add(cache_bytes)
            .and_then(|value| value.checked_add(source_staging_bytes))
            .and_then(|value| value.checked_add(prospective))
            .ok_or(TextureError::ArithmeticOverflow("texture resident bytes"))?;
        if resident > limits.maximum_resident_bytes {
            return Err(TextureError::ResidentBytes {
                requested: resident,
                maximum: limits.maximum_resident_bytes,
            });
        }
        let mut pixels = allocate_zeroed(plan.decoded_bytes, TextureAllocationSite::Pixels)?;
        for level in &plan.mip_levels {
            let source_level = source
                .get(level.encoded_offset..level.encoded_offset + level.encoded_bytes)
                .ok_or(TextureError::InternalInvariant("mip source range"))?;
            let pixel_level = pixels
                .get_mut(level.pixel_offset..level.pixel_offset + level.pixel_bytes)
                .ok_or(TextureError::InternalInvariant("mip pixel range"))?;
            decode_level(
                pixel_level,
                level.width,
                level.height,
                plan.format,
                plan.layout,
                source_level,
                palette.map(|info| {
                    let start = info.offset as usize;
                    let bytes = info.entries as usize * 2;
                    (&tmem[start..start + bytes], info.format)
                }),
            )?;
        }
        Some(pixels)
    };
    let mip_levels = clone_mip_levels(&plan.mip_levels)?;
    let retained_bytes = key
        .capacity()
        .checked_add(pixels.as_ref().map_or(0, Vec::capacity))
        .and_then(|value| {
            value.checked_add(
                mip_levels
                    .capacity()
                    .checked_mul(core::mem::size_of::<MipLevel>())?,
            )
        })
        .ok_or(TextureError::ArithmeticOverflow(
            "materialized texture retained bytes",
        ))?;
    Ok(MaterializedTexture {
        map,
        key,
        pixels,
        address: plan.address,
        generation,
        width: plan.width,
        height: plan.height,
        format: plan.format,
        sampler: plan.sampler,
        mip_levels,
        source_hash,
        palette,
        origin,
        retained_bytes,
    })
}

fn clone_mip_levels(levels: &[MipLevel]) -> Result<Vec<MipLevel>, TextureError> {
    let mut copy = Vec::new();
    copy.try_reserve_exact(levels.len())
        .map_err(|_| TextureError::Allocation {
            site: TextureAllocationSite::MipLayout,
        })?;
    copy.extend_from_slice(levels);
    Ok(copy)
}

fn palette_info(plan: &TexturePlan, tmem: &[u8]) -> Result<Option<PaletteInfo>, TextureError> {
    let entries = plan.format.palette_entries();
    if entries == 0 {
        return Ok(None);
    }
    let offset = (plan.snapshot.tlut & 0x3ff) << 9;
    let format = TlutFormat::from_raw(((plan.snapshot.tlut >> 10) & 3) as u8)?;
    let bytes = usize::try_from(entries)
        .map_err(|_| TextureError::ArithmeticOverflow("TLUT entry count"))?
        .checked_mul(2)
        .ok_or(TextureError::ArithmeticOverflow("TLUT bytes"))?;
    validate_tmem_range(TmemBank::Tlut, offset as usize, bytes)?;
    let palette = tmem
        .get(offset as usize..offset as usize + bytes)
        .ok_or(TextureError::InternalInvariant("validated TLUT range"))?;
    Ok(Some(PaletteInfo {
        offset,
        format,
        entries,
        hash: materialized_texture_hash(palette),
    }))
}

fn texture_key(
    map: u8,
    plan: &TexturePlan,
    source_hash: u32,
    palette: Option<PaletteInfo>,
    origin: TextureOrigin,
    generation: u32,
) -> Result<String, TextureError> {
    let palette_offset = palette.map_or(0, |info| info.offset);
    let palette_format = palette.map_or(0, |info| u32::from(info.format.raw()));
    let palette_hash = palette.map_or(0, |info| info.hash);
    let mut key = String::new();
    key.try_reserve_exact(192)
        .map_err(|_| TextureError::Allocation {
            site: TextureAllocationSite::Key,
        })?;
    write!(
        key,
        "{}:{}:{}:{}:{}:{}:{}:{}:{}:{}:",
        map,
        plan.address,
        plan.width,
        plan.height,
        plan.format.raw(),
        plan.mip_levels.len(),
        source_hash,
        palette_offset,
        palette_format,
        palette_hash
    )
    .map_err(|_| TextureError::Allocation {
        site: TextureAllocationSite::Key,
    })?;
    match origin {
        TextureOrigin::EfbCopy { .. } => write!(key, "{generation}"),
        TextureOrigin::MainMemory => key.write_str("ram"),
        TextureOrigin::ManualTmem {
            even_offset,
            odd_offset,
            generation,
        } => write!(key, "tmem-{generation}-{even_offset}-{odd_offset}"),
    }
    .map_err(|_| TextureError::Allocation {
        site: TextureAllocationSite::Key,
    })?;
    Ok(key)
}

fn decode_level(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    format: TextureFormat,
    layout: TextureLayout,
    source: &[u8],
    palette: Option<(&[u8], TlutFormat)>,
) -> Result<(), TextureError> {
    let expected_pixels = usize::try_from(
        width
            .checked_mul(height)
            .and_then(|value| value.checked_mul(4))
            .ok_or(TextureError::ArithmeticOverflow("decoded level bytes"))?,
    )
    .map_err(|_| TextureError::ArithmeticOverflow("decoded level bytes"))?;
    if pixels.len() != expected_pixels {
        return Err(TextureError::InternalInvariant(
            "decoded level output length",
        ));
    }
    let blocks_wide = width.div_ceil(layout.block_width);
    let blocks_high = height.div_ceil(layout.block_height);
    let expected_source = usize::try_from(
        blocks_wide
            .checked_mul(blocks_high)
            .and_then(|value| value.checked_mul(layout.block_bytes))
            .ok_or(TextureError::ArithmeticOverflow(
                "decoded level source bytes",
            ))?,
    )
    .map_err(|_| TextureError::ArithmeticOverflow("decoded level source bytes"))?;
    if source.len() != expected_source {
        return Err(TextureError::InternalInvariant(
            "decoded level source length",
        ));
    }
    let mut block_offset = 0usize;
    for block_y in 0..blocks_high {
        for block_x in 0..blocks_wide {
            let origin_x = block_x * layout.block_width;
            let origin_y = block_y * layout.block_height;
            match format {
                TextureFormat::I4 | TextureFormat::C4 => {
                    for row in 0..8u32 {
                        for pair in 0..4u32 {
                            let offset = block_offset + row as usize * 4 + pair as usize;
                            let value = read_byte(source, offset)?;
                            for (within, nibble) in [(0, value >> 4), (1, value & 0xf)] {
                                let color = if format == TextureFormat::I4 {
                                    let intensity = expand4(nibble);
                                    [intensity, intensity, intensity, intensity]
                                } else {
                                    palette_color(u32::from(nibble), palette)?
                                };
                                write_pixel(
                                    pixels,
                                    width,
                                    height,
                                    origin_x + pair * 2 + within,
                                    origin_y + row,
                                    color,
                                )?;
                            }
                        }
                    }
                }
                TextureFormat::I8 | TextureFormat::Ia4 | TextureFormat::C8 => {
                    for row in 0..4u32 {
                        for column in 0..8u32 {
                            let offset = block_offset + row as usize * 8 + column as usize;
                            let value = read_byte(source, offset)?;
                            let color = match format {
                                TextureFormat::I8 => [value, value, value, value],
                                TextureFormat::Ia4 => {
                                    let alpha = expand4(value >> 4);
                                    let intensity = expand4(value & 0xf);
                                    [intensity, intensity, intensity, alpha]
                                }
                                TextureFormat::C8 => palette_color(u32::from(value), palette)?,
                                _ => {
                                    return Err(TextureError::InternalInvariant(
                                        "8-bit texture dispatch",
                                    ));
                                }
                            };
                            write_pixel(
                                pixels,
                                width,
                                height,
                                origin_x + column,
                                origin_y + row,
                                color,
                            )?;
                        }
                    }
                }
                TextureFormat::Ia8
                | TextureFormat::Rgb565
                | TextureFormat::Rgb5a3
                | TextureFormat::C14x2 => {
                    for row in 0..4u32 {
                        for column in 0..4u32 {
                            let offset = block_offset + (row as usize * 4 + column as usize) * 2;
                            let color = match format {
                                TextureFormat::Ia8 => {
                                    let alpha = read_byte(source, offset)?;
                                    let intensity = read_byte(source, offset + 1)?;
                                    [intensity, intensity, intensity, alpha]
                                }
                                TextureFormat::Rgb565 => rgb565(read_u16(source, offset)?),
                                TextureFormat::Rgb5a3 => rgb5a3(read_u16(source, offset)?),
                                TextureFormat::C14x2 => {
                                    let index = read_u16(source, offset)? & 0x3fff;
                                    palette_color(u32::from(index), palette)?
                                }
                                _ => {
                                    return Err(TextureError::InternalInvariant(
                                        "16-bit texture dispatch",
                                    ));
                                }
                            };
                            write_pixel(
                                pixels,
                                width,
                                height,
                                origin_x + column,
                                origin_y + row,
                                color,
                            )?;
                        }
                    }
                }
                TextureFormat::Rgba8 => {
                    for row in 0..4u32 {
                        for column in 0..4u32 {
                            let plane = row as usize * 8 + column as usize * 2;
                            let alpha = read_byte(source, block_offset + plane)?;
                            let red = read_byte(source, block_offset + plane + 1)?;
                            let green = read_byte(source, block_offset + 32 + plane)?;
                            let blue = read_byte(source, block_offset + 32 + plane + 1)?;
                            write_pixel(
                                pixels,
                                width,
                                height,
                                origin_x + column,
                                origin_y + row,
                                [red, green, blue, alpha],
                            )?;
                        }
                    }
                }
                TextureFormat::Cmpr => {
                    for sub_block in 0..4u32 {
                        decode_cmpr_block(
                            pixels,
                            width,
                            height,
                            origin_x + (sub_block & 1) * 4,
                            origin_y + (sub_block >> 1) * 4,
                            source,
                            block_offset + sub_block as usize * 8,
                        )?;
                    }
                }
            }
            block_offset = block_offset
                .checked_add(layout.block_bytes as usize)
                .ok_or(TextureError::ArithmeticOverflow("texture block cursor"))?;
        }
    }
    if block_offset != source.len() {
        return Err(TextureError::InternalInvariant("texture block cursor"));
    }
    Ok(())
}

fn decode_cmpr_block(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    origin_x: u32,
    origin_y: u32,
    source: &[u8],
    offset: usize,
) -> Result<(), TextureError> {
    let first_value = read_u16(source, offset)?;
    let second_value = read_u16(source, offset + 2)?;
    let first = rgb565(first_value);
    let second = rgb565(second_value);
    let (third, fourth) = if first_value > second_value {
        (
            [
                cmpr_blend(second[0], first[0]),
                cmpr_blend(second[1], first[1]),
                cmpr_blend(second[2], first[2]),
                0xff,
            ],
            [
                cmpr_blend(first[0], second[0]),
                cmpr_blend(first[1], second[1]),
                cmpr_blend(first[2], second[2]),
                0xff,
            ],
        )
    } else {
        let middle = [
            ((u16::from(first[0]) + u16::from(second[0])) / 2) as u8,
            ((u16::from(first[1]) + u16::from(second[1])) / 2) as u8,
            ((u16::from(first[2]) + u16::from(second[2])) / 2) as u8,
            0xff,
        ];
        (middle, [middle[0], middle[1], middle[2], 0])
    };
    let colors = [first, second, third, fourth];
    for row in 0..4u32 {
        let mut indexes = read_byte(source, offset + 4 + row as usize)?;
        for column in 0..4u32 {
            let color = colors[usize::from(indexes >> 6)];
            write_pixel(
                pixels,
                width,
                height,
                origin_x + column,
                origin_y + row,
                color,
            )?;
            indexes <<= 2;
        }
    }
    Ok(())
}

fn palette_color(
    index: u32,
    palette: Option<(&[u8], TlutFormat)>,
) -> Result<[u8; 4], TextureError> {
    let (palette, format) = palette.ok_or(TextureError::InternalInvariant(
        "indexed texture without a TLUT",
    ))?;
    let offset = usize::try_from(index)
        .map_err(|_| TextureError::ArithmeticOverflow("TLUT index"))?
        .checked_mul(2)
        .ok_or(TextureError::ArithmeticOverflow("TLUT index"))?;
    let first = read_byte(palette, offset)?;
    let second = read_byte(palette, offset + 1)?;
    Ok(match format {
        TlutFormat::Ia8 => [second, second, second, first],
        TlutFormat::Rgb565 => rgb565(u16::from_be_bytes([first, second])),
        TlutFormat::Rgb5a3 => rgb5a3(u16::from_be_bytes([first, second])),
    })
}

fn read_byte(source: &[u8], offset: usize) -> Result<u8, TextureError> {
    source
        .get(offset)
        .copied()
        .ok_or(TextureError::InternalInvariant("texture source byte range"))
}

fn read_u16(source: &[u8], offset: usize) -> Result<u16, TextureError> {
    Ok(u16::from_be_bytes([
        read_byte(source, offset)?,
        read_byte(source, offset + 1)?,
    ]))
}

fn write_pixel(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    color: [u8; 4],
) -> Result<(), TextureError> {
    if x >= width || y >= height {
        return Ok(());
    }
    let offset = usize::try_from(
        y.checked_mul(width)
            .and_then(|value| value.checked_add(x))
            .and_then(|value| value.checked_mul(4))
            .ok_or(TextureError::ArithmeticOverflow("texture pixel offset"))?,
    )
    .map_err(|_| TextureError::ArithmeticOverflow("texture pixel offset"))?;
    let destination = pixels
        .get_mut(offset..offset + 4)
        .ok_or(TextureError::InternalInvariant("texture pixel range"))?;
    destination.copy_from_slice(&color);
    Ok(())
}

const fn expand3(value: u8) -> u8 {
    (value << 5) | (value << 2) | (value >> 1)
}

const fn expand4(value: u8) -> u8 {
    (value << 4) | value
}

const fn expand5(value: u16) -> u8 {
    ((value << 3) | (value >> 2)) as u8
}

const fn expand6(value: u16) -> u8 {
    ((value << 2) | (value >> 4)) as u8
}

const fn rgb565(value: u16) -> [u8; 4] {
    [
        expand5((value >> 11) & 0x1f),
        expand6((value >> 5) & 0x3f),
        expand5(value & 0x1f),
        0xff,
    ]
}

const fn rgb5a3(value: u16) -> [u8; 4] {
    if value & 0x8000 != 0 {
        [
            expand5((value >> 10) & 0x1f),
            expand5((value >> 5) & 0x1f),
            expand5(value & 0x1f),
            0xff,
        ]
    } else {
        [
            expand4(((value >> 8) & 0xf) as u8),
            expand4(((value >> 4) & 0xf) as u8),
            expand4((value & 0xf) as u8),
            expand3(((value >> 12) & 7) as u8),
        ]
    }
}

fn cmpr_blend(first: u8, second: u8) -> u8 {
    ((u16::from(first) * 3 + u16::from(second) * 5) >> 3) as u8
}

fn validate_texture_copy(reference: TextureCopyReference) -> Result<(), TextureError> {
    if reference.generation == 0 {
        return Err(TextureError::InvalidTextureCopy("zero generation"));
    }
    if reference.destination & 31 != 0 {
        return Err(TextureError::InvalidTextureCopy("unaligned destination"));
    }
    if reference.width == 0
        || reference.height == 0
        || reference.width > MAX_TEXTURE_DIMENSION
        || reference.height > MAX_TEXTURE_DIMENSION
    {
        return Err(TextureError::InvalidTextureCopy("dimensions"));
    }
    let format = TextureFormat::from_raw(reference.format)
        .map_err(|_| TextureError::InvalidTextureCopy("format"))?;
    if format.is_indexed() || format == TextureFormat::Cmpr {
        return Err(TextureError::InvalidTextureCopy("non-copy format"));
    }
    let layout = TextureLayout::for_format(format);
    let row_bytes = reference
        .width
        .div_ceil(layout.block_width)
        .checked_mul(layout.block_bytes)
        .ok_or(TextureError::InvalidTextureCopy("row byte overflow"))?;
    let row_count = reference.height.div_ceil(layout.block_height);
    if reference.row_bytes != row_bytes || reference.row_count != row_count {
        return Err(TextureError::InvalidTextureCopy("physical layout"));
    }
    if reference.stride < reference.row_bytes || reference.stride & 31 != 0 {
        return Err(TextureError::InvalidTextureCopy("stride"));
    }
    let extent = reference
        .row_count
        .checked_sub(1)
        .and_then(|rows| rows.checked_mul(reference.stride))
        .and_then(|bytes| bytes.checked_add(reference.row_bytes))
        .ok_or(TextureError::InvalidTextureCopy("extent overflow"))?;
    validate_u32_range(
        reference.destination,
        usize::try_from(extent).map_err(|_| TextureError::InvalidTextureCopy("extent overflow"))?,
    )
    .map_err(|_| TextureError::InvalidTextureCopy("address range"))?;
    Ok(())
}

fn validate_tmem_range(bank: TmemBank, offset: usize, length: usize) -> Result<(), TextureError> {
    if offset
        .checked_add(length)
        .is_none_or(|end| end > TMEM_BYTES)
    {
        return Err(TextureError::TmemRange {
            bank,
            offset,
            length,
        });
    }
    Ok(())
}

fn validate_u32_range(address: u32, length: usize) -> Result<(), TextureError> {
    if length == 0 {
        return Ok(());
    }
    let length = u32::try_from(length)
        .map_err(|_| TextureError::ArithmeticOverflow("guest memory read length"))?;
    address
        .checked_add(length - 1)
        .ok_or(TextureError::ArithmeticOverflow("guest memory read range"))?;
    Ok(())
}

fn allocate_zeroed(length: usize, site: TextureAllocationSite) -> Result<Vec<u8>, TextureError> {
    let mut output = Vec::new();
    output
        .try_reserve_exact(length)
        .map_err(|_| TextureError::Allocation { site })?;
    output.resize(length, 0);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct TestMemory {
        bytes: Vec<u8>,
        reads: Vec<(u32, usize)>,
        split: usize,
        reject: Option<(u32, usize)>,
    }

    impl TestMemory {
        fn new(length: usize) -> Self {
            Self {
                bytes: vec![0; length],
                reads: Vec::new(),
                split: usize::MAX,
                reject: None,
            }
        }

        fn write(&mut self, address: usize, bytes: &[u8]) {
            self.bytes[address..address + bytes.len()].copy_from_slice(bytes);
        }
    }

    impl GxMemory for TestMemory {
        fn read_exact(&mut self, address: u32, destination: &mut [u8]) -> Result<(), MemoryError> {
            self.reads.push((address, destination.len()));
            if self.reject == Some((address, destination.len())) {
                return Err(MemoryError::Rejected);
            }
            let start = address as usize;
            let end = start
                .checked_add(destination.len())
                .ok_or(MemoryError::OutOfBounds)?;
            let source = self.bytes.get(start..end).ok_or(MemoryError::OutOfBounds)?;
            if self.split == usize::MAX {
                destination.copy_from_slice(source);
                return Ok(());
            }
            let mut cursor = 0usize;
            while cursor < destination.len() {
                let absolute = start + cursor;
                let boundary = ((absolute / self.split) + 1) * self.split;
                let count = (boundary - absolute).min(destination.len() - cursor);
                destination[cursor..cursor + count]
                    .copy_from_slice(&source[cursor..cursor + count]);
                cursor += count;
            }
            Ok(())
        }
    }

    fn materializer() -> ResidentTextureMaterializer {
        ResidentTextureMaterializer::try_new(TextureLimits::default()).unwrap()
    }

    fn snapshot(
        address: u32,
        width: u32,
        height: u32,
        format: TextureFormat,
    ) -> TextureRegisterSnapshot {
        TextureRegisterSnapshot {
            mode0: 0,
            mode1: 0,
            image0: (width - 1) | ((height - 1) << 10) | (u32::from(format.raw()) << 20),
            // Two non-overlapping, SDK-sized 32 KiB automatic cache banks.
            image1: (3 << 15) | (3 << 18),
            image2: 0x1000 | (3 << 15) | (3 << 18),
            image3: address >> 5,
            tlut: 0,
        }
    }

    fn decode_one(
        format: TextureFormat,
        width: u32,
        height: u32,
        source: &[u8],
        palette: Option<(TlutFormat, Vec<u8>)>,
    ) -> Vec<u8> {
        let address = 0x100u32;
        let mut memory = TestMemory::new(0x20_000);
        memory.write(address as usize, source);
        let mut texture = materializer();
        let mut registers = snapshot(address, width, height, format);
        if let Some((palette_format, palette)) = palette {
            let palette_address = 0x8000u32;
            assert_eq!(palette.len() % TMEM_LINE_BYTES, 0);
            memory.write(palette_address as usize, &palette);
            texture
                .apply_bp_load(0x64, palette_address >> 5, &mut memory)
                .unwrap();
            texture
                .apply_bp_load(
                    0x65,
                    ((palette.len() / TMEM_LINE_BYTES) as u32) << 10,
                    &mut memory,
                )
                .unwrap();
            registers.tlut = u32::from(palette_format.raw()) << 10;
        }
        let batch = texture.materialize_map(0, registers, &mut memory).unwrap();
        batch.get(0).unwrap().pixels().unwrap().to_vec()
    }

    #[test]
    fn direct_format_matrix_matches_browser_oracle_texels() {
        let mut i4 = vec![0; 32];
        i4[0] = 0x1f;
        let i4_pixels = decode_one(TextureFormat::I4, 8, 8, &i4, None);
        assert_eq!(&i4_pixels[..8], &[17, 17, 17, 17, 255, 255, 255, 255]);
        assert_eq!(materialized_texture_hash(&i4_pixels), 0x9a7c_fca5);

        let mut i8 = vec![0; 32];
        i8[0] = 0x34;
        let i8_pixels = decode_one(TextureFormat::I8, 8, 4, &i8, None);
        assert_eq!(&i8_pixels[..4], &[52, 52, 52, 52]);
        assert_eq!(materialized_texture_hash(&i8_pixels), 0x511e_1055);

        let mut ia4 = vec![0; 32];
        ia4[0] = 0xa3;
        let ia4_pixels = decode_one(TextureFormat::Ia4, 8, 4, &ia4, None);
        assert_eq!(&ia4_pixels[..4], &[51, 51, 51, 170]);
        assert_eq!(materialized_texture_hash(&ia4_pixels), 0xc178_884e);

        let mut ia8 = vec![0; 32];
        ia8[..2].copy_from_slice(&[0xa0, 0x21]);
        let ia8_pixels = decode_one(TextureFormat::Ia8, 4, 4, &ia8, None);
        assert_eq!(&ia8_pixels[..4], &[33, 33, 33, 160]);
        assert_eq!(materialized_texture_hash(&ia8_pixels), 0xcaf5_f946);

        let mut rgb565 = vec![0; 32];
        rgb565[..2].copy_from_slice(&[0xf8, 0x00]);
        let rgb565_pixels = decode_one(TextureFormat::Rgb565, 4, 4, &rgb565, None);
        assert_eq!(&rgb565_pixels[..4], &[255, 0, 0, 255]);
        assert_eq!(materialized_texture_hash(&rgb565_pixels), 0xabb5_2eba);

        let mut rgb5a3 = vec![0; 32];
        rgb5a3[..2].copy_from_slice(&[0xfc, 0x00]);
        let rgb5a3_pixels = decode_one(TextureFormat::Rgb5a3, 4, 4, &rgb5a3, None);
        assert_eq!(&rgb5a3_pixels[..4], &[255, 0, 0, 255]);
        assert_eq!(materialized_texture_hash(&rgb5a3_pixels), 0x6229_1063);

        let mut rgba8 = vec![0; 64];
        rgba8[..2].copy_from_slice(&[0x44, 0x11]);
        rgba8[32..34].copy_from_slice(&[0x22, 0x33]);
        let rgba8_pixels = decode_one(TextureFormat::Rgba8, 4, 4, &rgba8, None);
        assert_eq!(&rgba8_pixels[..4], &[17, 34, 51, 68]);
        assert_eq!(materialized_texture_hash(&rgba8_pixels), 0xe44e_0c6d);
    }

    #[test]
    fn packet_key_and_public_receipt_hash_match_browser_oracle() {
        let address = 0x100u32;
        let mut source = [0; 32];
        source[0] = 0x1f;
        assert_eq!(materialized_texture_hash(&source), 0xa958_92da);

        let mut memory = TestMemory::new(0x1000);
        memory.write(address as usize, &source);
        let mut texture = materializer();
        let batch = texture
            .materialize_map(0, snapshot(address, 8, 8, TextureFormat::I4), &mut memory)
            .unwrap();
        let result = batch.get(0).unwrap();
        assert_eq!(result.source_hash(), 0xa958_92da);
        assert_eq!(result.key(), "0:256:8:8:0:1:2841154266:0:0:0:ram");
    }

    #[test]
    fn cmpr_uses_the_browser_oracles_flipper_weighted_colors() {
        let mut source = vec![0; 32];
        for sub_block in 0..4 {
            let offset = sub_block * 8;
            source[offset..offset + 4].copy_from_slice(&[0xf8, 0x00, 0x00, 0x1f]);
            source[offset + 4] = 0x1b;
        }
        let pixels = decode_one(TextureFormat::Cmpr, 8, 8, &source, None);
        assert_eq!(&pixels[0..4], &[255, 0, 0, 255]);
        assert_eq!(&pixels[4..8], &[0, 0, 255, 255]);
        assert_eq!(&pixels[8..12], &[159, 0, 95, 255]);
        assert_eq!(&pixels[12..16], &[95, 0, 159, 255]);
        assert_eq!(materialized_texture_hash(&pixels), 0x4223_0e75);
    }

    #[test]
    fn indexed_formats_and_all_tlut_decoders_match_browser_ordering() {
        let mut c4_source = vec![0; 32];
        c4_source[0] = 0x12;
        let mut ia8_palette = vec![0; 32];
        ia8_palette[2..6].copy_from_slice(&[0x40, 0x20, 0x80, 0x70]);
        let c4 = decode_one(
            TextureFormat::C4,
            8,
            8,
            &c4_source,
            Some((TlutFormat::Ia8, ia8_palette)),
        );
        assert_eq!(&c4[..8], &[32, 32, 32, 64, 112, 112, 112, 128]);
        assert_eq!(materialized_texture_hash(&c4), 0x5a55_4775);

        let mut c8_source = vec![0; 32];
        c8_source[0] = 1;
        let mut rgb565_palette = vec![0; 512];
        rgb565_palette[2..4].copy_from_slice(&[0x07, 0xe0]);
        let c8 = decode_one(
            TextureFormat::C8,
            8,
            4,
            &c8_source,
            Some((TlutFormat::Rgb565, rgb565_palette)),
        );
        assert_eq!(&c8[..4], &[0, 255, 0, 255]);
        assert_eq!(materialized_texture_hash(&c8), 0x454f_33a0);

        let mut c14_source = vec![0; 32];
        c14_source[..2].copy_from_slice(&[0x00, 0x01]);
        let mut rgb5a3_palette = vec![0; 32_768];
        rgb5a3_palette[2..4].copy_from_slice(&[0x8c, 0x00]);
        let c14 = decode_one(
            TextureFormat::C14x2,
            4,
            4,
            &c14_source,
            Some((TlutFormat::Rgb5a3, rgb5a3_palette)),
        );
        assert_eq!(&c14[..4], &[24, 0, 0, 255]);
        assert_eq!(materialized_texture_hash(&c14), 0x098b_eac0);
    }

    #[test]
    fn mip_chain_layout_and_payload_match_the_browser_oracle() {
        let address = 0x100u32;
        let mut memory = TestMemory::new(0x1000);
        for (level, value) in [0x11, 0x22, 0x33, 0x44].into_iter().enumerate() {
            memory.bytes[address as usize + level * 32..address as usize + (level + 1) * 32]
                .fill(value);
        }
        let mut registers = snapshot(address, 8, 8, TextureFormat::I4);
        registers.mode0 = 1 << 5;
        registers.mode1 = 0x30 << 8;
        let mut texture = materializer();
        let batch = texture.materialize_map(0, registers, &mut memory).unwrap();
        let result = batch.get(0).unwrap();
        assert_eq!(
            result
                .mip_levels()
                .iter()
                .map(|level| (
                    level.level,
                    level.width,
                    level.height,
                    level.encoded_offset,
                    level.pixel_offset,
                    level.pixel_bytes,
                ))
                .collect::<Vec<_>>(),
            vec![
                (0, 8, 8, 0, 0, 256),
                (1, 4, 4, 32, 256, 64),
                (2, 2, 2, 64, 320, 16),
                (3, 1, 1, 96, 336, 4),
            ]
        );
        let pixels = result.pixels().unwrap();
        assert_eq!(pixels.len(), 340);
        assert_eq!(&pixels[0..4], &[17; 4]);
        assert_eq!(&pixels[256..260], &[34; 4]);
        assert_eq!(&pixels[320..324], &[51; 4]);
        assert_eq!(&pixels[336..340], &[68; 4]);
        assert_eq!(materialized_texture_hash(pixels), 0xcd6f_bc55);
        assert_eq!(memory.reads, vec![(address, 128)]);
        assert_eq!(result.packet_input().mip_level_count, 4);
    }

    #[test]
    fn tiled_edges_clip_without_touching_padding_texels() {
        let source = vec![0xff; 32];
        let pixels = decode_one(TextureFormat::I4, 3, 2, &source, None);
        assert_eq!(pixels.len(), 24);
        assert!(pixels.iter().all(|byte| *byte == 0xff));
    }

    #[test]
    fn source_read_crosses_host_memory_boundaries_as_one_authenticated_range() {
        let address = 0x1e0u32;
        let source = (0..64u8).collect::<Vec<_>>();
        let mut memory = TestMemory::new(0x400);
        memory.split = 0x200;
        memory.write(address as usize, &source);
        let mut texture = materializer();
        let batch = texture
            .materialize_map(
                0,
                snapshot(address, 4, 4, TextureFormat::Rgba8),
                &mut memory,
            )
            .unwrap();
        assert_eq!(memory.reads, vec![(address, 64)]);
        assert_eq!(batch.get(0).unwrap().pixels().unwrap()[0], source[1]);
    }

    #[test]
    fn ordinary_and_split_preloads_are_atomic_and_manual_sources_never_read_dram() {
        let preload_address = 0x200u32;
        let mut memory = TestMemory::new(0x1000);
        memory.bytes[preload_address as usize..preload_address as usize + 64].fill(0x5a);
        let mut texture = materializer();
        texture
            .apply_bp_load(0x60, preload_address >> 5, &mut memory)
            .unwrap();
        texture.apply_bp_load(0x61, 4, &mut memory).unwrap();
        texture.apply_bp_load(0x63, 2, &mut memory).unwrap();
        assert_eq!(&texture.tmem()[128..192], &[0x5a; 64]);
        assert_eq!(texture.tmem_generation(), 1);

        memory.reads.clear();
        let mut manual = snapshot(0x800, 8, 8, TextureFormat::I4);
        manual.image1 = 0x0020_0000 | 4;
        manual.image2 = 0x1000;
        let batch = texture.materialize_map(0, manual, &mut memory).unwrap();
        assert!(memory.reads.is_empty());
        assert_eq!(&batch.get(0).unwrap().pixels().unwrap()[..4], &[0x55; 4]);
        drop(batch);

        let split_address = 0x400u32;
        for offset in 0..32 {
            memory.bytes[split_address as usize + offset] = offset as u8;
            memory.bytes[split_address as usize + 32 + offset] = 0x80 + offset as u8;
        }
        texture
            .apply_bp_load(0x60, split_address >> 5, &mut memory)
            .unwrap();
        texture.apply_bp_load(0x61, 8, &mut memory).unwrap();
        texture.apply_bp_load(0x62, 16, &mut memory).unwrap();
        texture
            .apply_bp_load(0x63, (3 << 15) | 1, &mut memory)
            .unwrap();
        assert_eq!(&texture.tmem()[256..288], &memory.bytes[0x400..0x420]);
        assert_eq!(&texture.tmem()[512..544], &memory.bytes[0x420..0x440]);
    }

    #[test]
    fn manual_rgba8_rejoins_ar_and_gb_tmem_banks() {
        let source_address = 0x200u32;
        let mut memory = TestMemory::new(0x1000);
        let mut source = vec![0; 64];
        source[..2].copy_from_slice(&[0x44, 0x11]);
        source[32..34].copy_from_slice(&[0x22, 0x33]);
        memory.write(source_address as usize, &source);
        let mut texture = materializer();
        texture
            .apply_bp_load(0x60, source_address >> 5, &mut memory)
            .unwrap();
        texture.apply_bp_load(0x61, 4, &mut memory).unwrap();
        texture.apply_bp_load(0x62, 8, &mut memory).unwrap();
        texture
            .apply_bp_load(0x63, (3 << 15) | 1, &mut memory)
            .unwrap();
        memory.reads.clear();
        let mut registers = snapshot(0x800, 4, 4, TextureFormat::Rgba8);
        registers.image1 = 0x0020_0000 | 4;
        registers.image2 = 8;
        let batch = texture.materialize_map(0, registers, &mut memory).unwrap();
        assert_eq!(
            &batch.get(0).unwrap().pixels().unwrap()[..4],
            &[17, 34, 51, 68]
        );
        assert!(memory.reads.is_empty());
    }

    #[test]
    fn manual_mip_chain_alternates_even_and_odd_banks_byte_exactly() {
        let even_source = 0x200u32;
        let odd_source = 0x300u32;
        let mut memory = TestMemory::new(0x1000);
        memory.bytes[even_source as usize..even_source as usize + 32].fill(0x11);
        memory.bytes[even_source as usize + 32..even_source as usize + 64].fill(0x33);
        memory.bytes[odd_source as usize..odd_source as usize + 32].fill(0x22);
        memory.bytes[odd_source as usize + 32..odd_source as usize + 64].fill(0x44);
        let mut texture = materializer();
        texture
            .apply_bp_load(0x60, even_source >> 5, &mut memory)
            .unwrap();
        texture.apply_bp_load(0x61, 4, &mut memory).unwrap();
        texture.apply_bp_load(0x63, 2, &mut memory).unwrap();
        texture
            .apply_bp_load(0x60, odd_source >> 5, &mut memory)
            .unwrap();
        texture.apply_bp_load(0x61, 8, &mut memory).unwrap();
        texture.apply_bp_load(0x63, 2, &mut memory).unwrap();

        let mut registers = snapshot(0, 8, 8, TextureFormat::I4);
        registers.mode0 = 1 << 5;
        registers.mode1 = 0x30 << 8;
        registers.image1 = 0x0020_0000 | 4;
        registers.image2 = 8;
        memory.reads.clear();
        let batch = texture.materialize_map(0, registers, &mut memory).unwrap();
        let pixels = batch.get(0).unwrap().pixels().unwrap();
        assert_eq!(materialized_texture_hash(pixels), 0xcd6f_bc55);
        assert_eq!(&pixels[0..4], &[17; 4]);
        assert_eq!(&pixels[256..260], &[34; 4]);
        assert_eq!(&pixels[320..324], &[51; 4]);
        assert_eq!(&pixels[336..340], &[68; 4]);
        assert!(memory.reads.is_empty());
    }

    #[test]
    fn sparse_nonzero_tlut_destination_is_hashed_and_decoded_in_place() {
        let texture_address = 0x100u32;
        let palette_address = 0x800u32;
        let palette_slot = 7u32;
        let mut memory = TestMemory::new(0x1000);
        memory.bytes[texture_address as usize..texture_address as usize + 32].fill(0);
        memory.bytes[texture_address as usize] = 0x10;
        memory.bytes[palette_address as usize + 2..palette_address as usize + 4]
            .copy_from_slice(&[0xff, 0x6a]);
        let mut texture = materializer();
        texture
            .apply_bp_load(0x64, palette_address >> 5, &mut memory)
            .unwrap();
        texture
            .apply_bp_load(0x65, palette_slot | (1 << 10), &mut memory)
            .unwrap();
        let mut registers = snapshot(texture_address, 8, 8, TextureFormat::C4);
        registers.tlut = palette_slot;
        let batch = texture.materialize_map(0, registers, &mut memory).unwrap();
        let result = batch.get(0).unwrap();
        assert_eq!(&result.pixels().unwrap()[..4], &[106, 106, 106, 255]);
        assert_eq!(result.palette().unwrap().offset, palette_slot << 9);
        assert_eq!(result.palette().unwrap().entries, 16);
    }

    #[test]
    fn automatic_tmem_cache_survives_dram_overwrite_until_invalidate() {
        let address = 0x100u32;
        let mut memory = TestMemory::new(0x1000);
        memory.bytes[address as usize..address as usize + 32].fill(0x11);
        let registers = snapshot(address, 8, 8, TextureFormat::I4);
        let mut texture = materializer();
        let first = texture
            .materialize_map(0, registers, &mut memory)
            .unwrap()
            .into_retained();
        assert_eq!(&first.get(0).unwrap().pixels().unwrap()[..4], &[17; 4]);
        assert_eq!(texture.cache_bytes(), 32);

        memory.bytes[address as usize..address as usize + 32].fill(0x22);
        let second = texture
            .materialize_map(0, registers, &mut memory)
            .unwrap()
            .into_retained();
        assert_eq!(&second.get(0).unwrap().pixels().unwrap()[..4], &[17; 4]);
        assert_eq!(memory.reads, vec![(address, 32)]);

        texture.apply_bp_load(0x66, 0, &mut memory).unwrap();
        let third = texture.materialize_map(0, registers, &mut memory).unwrap();
        assert_eq!(&third.get(0).unwrap().pixels().unwrap()[..4], &[34; 4]);
        assert_eq!(memory.reads, vec![(address, 32), (address, 32)]);
    }

    #[test]
    fn exact_efb_copy_reference_omits_pixels_but_hash_mismatch_falls_back_to_ram() {
        let address = 0x100u32;
        let source = vec![0x11; 32];
        let mut memory = TestMemory::new(0x1000);
        memory.write(address as usize, &source);
        let registers = snapshot(address, 8, 8, TextureFormat::I4);
        let mut texture = materializer();
        texture
            .record_texture_copy(TextureCopyReference {
                destination: address,
                generation: 7,
                width: 8,
                height: 8,
                format: TextureFormat::I4.raw(),
                stride: 32,
                row_bytes: 32,
                row_count: 1,
                materialized_hash: materialized_texture_hash(&source),
            })
            .unwrap();
        let referenced = texture
            .materialize_map(0, registers, &mut memory)
            .unwrap()
            .into_retained();
        let result = referenced.get(0).unwrap();
        assert_eq!(result.pixels(), None);
        assert_eq!(result.generation(), 7);
        assert_eq!(result.origin(), TextureOrigin::EfbCopy { generation: 7 });
        assert!(result.retained_bytes() < 1024);

        let other_address = 0x200u32;
        memory.bytes[other_address as usize..other_address as usize + 32].fill(0x22);
        let mut mismatch = materializer();
        mismatch
            .record_texture_copy(TextureCopyReference {
                destination: other_address,
                generation: 8,
                width: 8,
                height: 8,
                format: TextureFormat::I4.raw(),
                stride: 32,
                row_bytes: 32,
                row_count: 1,
                materialized_hash: materialized_texture_hash(&source),
            })
            .unwrap();
        let fallback = mismatch
            .materialize_map(
                0,
                snapshot(other_address, 8, 8, TextureFormat::I4),
                &mut memory,
            )
            .unwrap();
        assert!(fallback.get(0).unwrap().pixels().is_some());
        assert_eq!(fallback.get(0).unwrap().generation(), 0);
        assert_eq!(mismatch.stats().efb_copy_hash_misses, 1);
    }

    #[test]
    fn manual_and_cached_sources_never_alias_a_later_efb_copy_generation() {
        let address = 0x100u32;
        let mut memory = TestMemory::new(0x1000);
        memory.bytes[address as usize..address as usize + 32].fill(0x11);
        let registers = snapshot(address, 8, 8, TextureFormat::I4);
        let mut texture = materializer();
        let first = texture
            .materialize_map(0, registers, &mut memory)
            .unwrap()
            .into_retained();
        assert!(first.get(0).unwrap().pixels().is_some());
        texture
            .record_texture_copy(TextureCopyReference {
                destination: address,
                generation: 1,
                width: 8,
                height: 8,
                format: 0,
                stride: 32,
                row_bytes: 32,
                row_count: 1,
                materialized_hash: materialized_texture_hash(&[0x22; 32]),
            })
            .unwrap();
        memory.bytes[address as usize..address as usize + 32].fill(0x22);
        let cached = texture.materialize_map(0, registers, &mut memory).unwrap();
        assert_eq!(cached.get(0).unwrap().origin(), TextureOrigin::MainMemory);
        assert_eq!(&cached.get(0).unwrap().pixels().unwrap()[..4], &[17; 4]);
    }

    #[test]
    fn retained_transfer_keeps_an_inseparable_exact_byte_charge() {
        let address = 0x100u32;
        let mut memory = TestMemory::new(0x1000);
        memory.bytes[address as usize..address as usize + 32].fill(0x11);
        let mut texture = materializer();
        let batch = texture
            .materialize_map(0, snapshot(address, 8, 8, TextureFormat::I4), &mut memory)
            .unwrap();
        assert!(batch.retained_bytes() >= batch.output_pixel_bytes());
        let retained = batch.into_retained();
        assert!(retained.retained_bytes() >= 256);
        assert_eq!(retained.output_pixel_bytes(), 256);
        // Ownership transfer releases the materializer lease while the charged payload is live.
        let next = texture
            .materialize_map(1, snapshot(address, 8, 8, TextureFormat::I4), &mut memory)
            .unwrap();
        assert_eq!(next.textures().len(), 1);

        drop(next);
        let (textures, output_bytes, retained_bytes) = retained.into_parts();
        assert_eq!(textures.len(), 1);
        assert_eq!(output_bytes, 256);
        assert!(retained_bytes >= output_bytes);
        assert_eq!(textures[0].retained_bytes(), retained_bytes);
    }

    #[test]
    fn failed_preload_is_atomic_and_preserves_tmem_generation() {
        let source_address = 0x200u32;
        let mut memory = TestMemory::new(0x1000);
        memory.bytes[source_address as usize..source_address as usize + 64].fill(0xaa);
        memory.reject = Some((source_address, 64));
        let mut texture = materializer();
        texture.tmem[128..192].fill(0x55);
        texture
            .apply_bp_load(0x60, source_address >> 5, &mut memory)
            .unwrap();
        texture.apply_bp_load(0x61, 4, &mut memory).unwrap();
        assert_eq!(
            texture.apply_bp_load(0x63, 2, &mut memory),
            Err(TextureError::MemoryRead {
                address: source_address,
                length: 64,
                source: MemoryError::Rejected,
            })
        );
        assert_eq!(&texture.tmem()[128..192], &[0x55; 64]);
        assert_eq!(texture.tmem_generation(), 0);
    }

    #[test]
    fn invalid_tmem_range_rejects_without_partial_split_write() {
        let source_address = 0x200u32;
        let mut memory = TestMemory::new(0x1000);
        memory.bytes[source_address as usize..source_address as usize + 128].fill(0xaa);
        let mut texture = materializer();
        texture.tmem[0..64].fill(0x55);
        texture
            .apply_bp_load(0x60, source_address >> 5, &mut memory)
            .unwrap();
        texture.apply_bp_load(0x61, 0, &mut memory).unwrap();
        texture.apply_bp_load(0x62, 0x7fff, &mut memory).unwrap();
        assert!(matches!(
            texture.apply_bp_load(0x63, (3 << 15) | 2, &mut memory),
            Err(TextureError::TmemRange {
                bank: TmemBank::Odd,
                ..
            })
        ));
        assert_eq!(&texture.tmem()[0..64], &[0x55; 64]);
        assert_eq!(texture.tmem_generation(), 0);
    }

    #[test]
    fn malformed_formats_mips_tluts_and_ranges_fail_closed() {
        let mut memory = TestMemory::new(0x1000);
        let mut texture = materializer();
        let mut invalid_format = snapshot(0x100, 8, 8, TextureFormat::I4);
        invalid_format.image0 = (invalid_format.image0 & !(0xf << 20)) | (7 << 20);
        assert_eq!(
            texture.materialize_map(0, invalid_format, &mut memory),
            Err(TextureError::UnsupportedFormat(7))
        );
        assert!(memory.reads.is_empty());

        let mut reserved_mip = snapshot(0x100, 8, 8, TextureFormat::I4);
        reserved_mip.mode0 = 3 << 5;
        assert_eq!(
            texture.materialize_map(0, reserved_mip, &mut memory),
            Err(TextureError::ReservedMipFilter(3))
        );

        let mut invalid_tlut = snapshot(0x100, 8, 8, TextureFormat::C4);
        invalid_tlut.tlut = 3 << 10;
        assert_eq!(
            texture.materialize_map(0, invalid_tlut, &mut memory),
            Err(TextureError::InvalidTlutFormat(3))
        );

        let mut short = TestMemory::new(0x110);
        assert_eq!(
            texture.materialize_map(0, snapshot(0x100, 8, 8, TextureFormat::I4), &mut short,),
            Err(TextureError::MemoryRead {
                address: 0x100,
                length: 32,
                source: MemoryError::OutOfBounds,
            })
        );
    }

    #[test]
    fn batch_output_limit_covers_all_unique_maps() {
        let mut limits = TextureLimits::default();
        limits.maximum_output_bytes = 300;
        limits.maximum_resident_bytes = TMEM_BYTES
            + limits.maximum_source_bytes
            + limits.maximum_output_bytes
            + limits.maximum_cache_bytes;
        let mut texture = ResidentTextureMaterializer::try_new(limits).unwrap();
        let mut memory = TestMemory::new(0x1000);
        memory.bytes[0x100..0x120].fill(0x11);
        memory.bytes[0x200..0x220].fill(0x22);
        let mut snapshots = [TextureRegisterSnapshot::default(); 8];
        snapshots[0] = snapshot(0x100, 8, 8, TextureFormat::I4);
        snapshots[1] = snapshot(0x200, 8, 8, TextureFormat::I4);
        assert!(matches!(
            texture.materialize_maps(&snapshots, 0b11, &mut memory),
            Err(TextureError::OutputTooLarge { .. })
        ));
    }

    #[test]
    fn stale_and_noncanonical_texture_copy_receipts_are_rejected() {
        let mut texture = materializer();
        let valid = TextureCopyReference {
            destination: 0x100,
            generation: 2,
            width: 8,
            height: 8,
            format: 0,
            stride: 32,
            row_bytes: 32,
            row_count: 1,
            materialized_hash: 1,
        };
        texture.record_texture_copy(valid).unwrap();
        assert_eq!(
            texture.record_texture_copy(TextureCopyReference {
                generation: 2,
                ..valid
            }),
            Err(TextureError::StaleTextureCopy {
                latest: 2,
                received: 2,
            })
        );
        let mut fresh = materializer();
        assert_eq!(
            fresh.record_texture_copy(TextureCopyReference {
                generation: 1,
                stride: 16,
                ..valid
            }),
            Err(TextureError::InvalidTextureCopy("stride"))
        );
    }

    #[test]
    fn strict_v7_sampler_state_preserves_oracle_rejection_order() {
        let address = 0x100u32;
        let mut memory = TestMemory::new(0x1000);
        memory.bytes[address as usize..address as usize + 128].fill(0x11);
        let mut registers = snapshot(address, 8, 8, TextureFormat::I4);
        registers.mode0 = 0xffc0_0000 | (1 << 5);
        registers.mode1 = 0xabcd_0000 | (0x30 << 8) | 4;
        let mut texture = materializer();
        let batch = texture.materialize_map(0, registers, &mut memory).unwrap();
        let sampler = batch.get(0).unwrap().sampler();
        assert_eq!(sampler.mode0, registers.mode0 & 0x0039_ffff);
        assert_eq!(sampler.mode1, 0x3004);
        assert_eq!(
            sampler.strict_v7,
            StrictV7Preflight::Rejected(StrictV7Rejection::NonCanonicalMode0Bits)
        );
        assert_eq!(sampler.effective_lod_min_raw, 4);
        assert_eq!(sampler.effective_lod_max_raw, 0x30);
    }

    #[test]
    fn ordered_tmem_replay_must_materialize_before_a_later_preload() {
        let first_address = 0x200u32;
        let second_address = 0x400u32;
        let mut memory = TestMemory::new(0x1000);
        memory.bytes[first_address as usize..first_address as usize + 32].fill(0x11);
        memory.bytes[second_address as usize..second_address as usize + 32].fill(0x22);
        let mut texture = materializer();
        texture
            .apply_bp_load(0x60, first_address >> 5, &mut memory)
            .unwrap();
        texture.apply_bp_load(0x61, 4, &mut memory).unwrap();
        texture.apply_bp_load(0x63, 1, &mut memory).unwrap();

        let mut draw_state = snapshot(0, 8, 8, TextureFormat::I4);
        draw_state.image1 = 0x0020_0000 | 4;
        let first_draw = texture
            .materialize_map(0, draw_state, &mut memory)
            .unwrap()
            .into_retained();

        texture
            .apply_bp_load(0x60, second_address >> 5, &mut memory)
            .unwrap();
        texture.apply_bp_load(0x63, 1, &mut memory).unwrap();
        let second_draw = texture
            .materialize_map(0, draw_state, &mut memory)
            .unwrap()
            .into_retained();
        assert_eq!(&first_draw.get(0).unwrap().pixels().unwrap()[..4], &[17; 4]);
        assert_eq!(
            &second_draw.get(0).unwrap().pixels().unwrap()[..4],
            &[34; 4]
        );
    }
}
