//! MPC750 address translation and translation-lookaside buffers.
//!
//! This module deliberately depends only on architected register words and a
//! byte-addressable physical-memory interface.  The same implementation can
//! therefore serve the native emulator, a browser machine compiled to Wasm,
//! and isolated conformance tests.  In particular, no host pointer or
//! JavaScript convention is part of the translation contract.

use gekko::Cpu;

use crate::system::mem::{IPL_LEN, IPL_START, L2C_LEN, L2C_START, Memory, RAM_LEN, RAM_START};

/// Machine-state bit enabling data address translation.
pub const MSR_DR: u32 = 0x0010;
/// Machine-state bit enabling instruction address translation.
pub const MSR_IR: u32 = 0x0020;
/// Machine-state bit selecting problem (user) state.
pub const MSR_PR: u32 = 0x4000;

/// Number of sets in each MPC750 instruction/data TLB.
pub const TLB_SET_COUNT: usize = 64;
/// Number of ways in each MPC750 instruction/data TLB set.
pub const TLB_WAY_COUNT: usize = 2;

const PAGE_OFFSET_MASK: u32 = 0x0fff;
const PAGE_INDEX_MASK: u32 = 0xffff;
const VSID_MASK: u32 = 0x00ff_ffff;
const PTE_REFERENCED: u32 = 0x0100;
const PTE_CHANGED: u32 = 0x0080;

/// Physical memory used by the hashed-page-table walker.
///
/// Implementations may map the physical addresses into native allocations or
/// into an imported WebAssembly linear memory.  `is_backed` must guarantee
/// that every byte in the requested range can subsequently be read and
/// written through the other two methods.
pub trait ByteMemory {
    /// Whether the complete physical byte range is backed.
    fn is_backed(&self, physical: u32, len: u32) -> bool;

    /// Reads one physical byte, or `None` when it is not backed.
    fn read_byte(&self, physical: u32) -> Option<u8>;

    /// Writes one physical byte, returning whether it was backed.
    fn write_byte(&mut self, physical: u32, value: u8) -> bool;
}

impl ByteMemory for [u8] {
    fn is_backed(&self, physical: u32, len: u32) -> bool {
        (physical as usize)
            .checked_add(len as usize)
            .is_some_and(|end| end <= self.len())
    }

    fn read_byte(&self, physical: u32) -> Option<u8> {
        self.get(physical as usize).copied()
    }

    fn write_byte(&mut self, physical: u32, value: u8) -> bool {
        let Some(byte) = self.get_mut(physical as usize) else {
            return false;
        };
        *byte = value;
        true
    }
}

impl ByteMemory for Vec<u8> {
    fn is_backed(&self, physical: u32, len: u32) -> bool {
        self.as_slice().is_backed(physical, len)
    }

    fn read_byte(&self, physical: u32) -> Option<u8> {
        self.as_slice().read_byte(physical)
    }

    fn write_byte(&mut self, physical: u32, value: u8) -> bool {
        self.as_mut_slice().write_byte(physical, value)
    }
}

/// Canonical native/mapped-system backing for the MMU page walker.
///
/// RAM and locked cache are readable/writable PTE storage.  IPL bytes remain
/// visible to physical probes through `read_byte`, but the read-only IPL is
/// intentionally not reported by `is_backed`: architectural page-table
/// history must never turn a ROM mapping into writable storage.  This is the
/// same distinction the browser runtime previously enforced by accepting only
/// writable physical RAM for a PTEG.
impl ByteMemory for Memory {
    fn is_backed(&self, physical: u32, len: u32) -> bool {
        physical_region_offset(physical, len, RAM_START, RAM_LEN).is_some()
            || physical_region_offset(physical, len, L2C_START, L2C_LEN).is_some()
    }

    fn read_byte(&self, physical: u32) -> Option<u8> {
        if let Some(offset) = physical_region_offset(physical, 1, RAM_START, RAM_LEN) {
            return self.ram().get(offset).copied();
        }
        if let Some(offset) = physical_region_offset(physical, 1, L2C_START, L2C_LEN) {
            return self.l2c().get(offset).copied();
        }
        let offset = physical_region_offset(physical, 1, IPL_START, IPL_LEN / 2)?;
        self.ipl().get(offset).copied()
    }

    fn write_byte(&mut self, physical: u32, value: u8) -> bool {
        if let Some(offset) = physical_region_offset(physical, 1, RAM_START, RAM_LEN) {
            self.ram_mut()[offset] = value;
            return true;
        }
        if let Some(offset) = physical_region_offset(physical, 1, L2C_START, L2C_LEN) {
            self.l2c_mut()[offset] = value;
            return true;
        }
        false
    }
}

fn physical_region_offset(
    physical: u32,
    len: u32,
    region_start: u32,
    region_len: usize,
) -> Option<usize> {
    let offset = physical.checked_sub(region_start)? as usize;
    offset
        .checked_add(len as usize)
        .is_some_and(|end| end <= region_len)
        .then_some(offset)
}

/// Raw upper/lower words of one instruction or data BAT pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BatPair {
    pub upper: u32,
    pub lower: u32,
}

impl BatPair {
    pub const fn new(upper: u32, lower: u32) -> Self {
        Self { upper, lower }
    }
}

/// MPC750 BATL PP permission check used by both instruction and data BATs.
pub const fn bat_allows_access(lower: u32, write: bool) -> bool {
    let protection = lower & 3;
    if write {
        protection == 2
    } else {
        protection != 0
    }
}

/// Translates through one BAT pair, including privilege validity and PP.
///
/// `None` deliberately combines non-match and protection for pointer-style
/// callers.  Use `resolve_*_bat` when precise protection classification is
/// required.
pub const fn translate_bat_address(
    effective: u32,
    bat: BatPair,
    user_mode: bool,
    write: bool,
) -> Option<u32> {
    let valid = if user_mode { 1 } else { 2 };
    if bat.upper & valid == 0 || !bat_allows_access(bat.lower, write) {
        return None;
    }
    let block_mask = ((bat.upper >> 2) & 0x7ff) << 17;
    let address_mask = block_mask | 0x1ffff;
    let region_mask = !address_mask;
    if effective & region_mask != bat.upper & region_mask {
        return None;
    }
    let physical_base = (bat.lower & 0xfffe_0000) & region_mask;
    Some(physical_base | (effective & address_mask))
}

/// Complete Ks/Kp and PP permission matrix for a data PTE.
pub const fn data_page_allows_access(msr: u32, segment: u32, pte1: u32, write: bool) -> bool {
    let key = selected_key(msr, segment);
    let protection = pte1 & 3;
    if !write {
        return key == 0 || protection != 0;
    }
    if key == 0 {
        protection != 3
    } else {
        protection == 2
    }
}

impl From<&gekko::Bat> for BatPair {
    fn from(bat: &gekko::Bat) -> Self {
        let bits = bat.to_bits();
        Self {
            upper: (bits >> 32) as u32,
            lower: bits as u32,
        }
    }
}

/// Complete architected input to address translation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TranslationRegisters {
    pub msr: u32,
    pub instruction_bats: [BatPair; 4],
    pub data_bats: [BatPair; 4],
    pub segments: [u32; 16],
    pub sdr1: u32,
}

impl TranslationRegisters {
    /// Takes one coherent snapshot of the native CPU translation registers.
    pub fn from_cpu(cpu: &Cpu) -> Self {
        let memory = &cpu.supervisor.memory;
        Self {
            msr: cpu.supervisor.config.msr.to_bits(),
            instruction_bats: memory.ibat.each_ref().map(BatPair::from),
            data_bats: memory.dbat.each_ref().map(BatPair::from),
            segments: memory.sr,
            sdr1: memory.sdr1,
        }
    }
}

/// Whether a translation is an observational probe or a real CPU access.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TranslationEffect {
    /// Do not touch replacement state, fill a TLB, or update PTE history.
    #[default]
    Probe,
    /// Apply MPC750 TLB residency and referenced/changed side effects.
    Architectural,
}

impl TranslationEffect {
    const fn is_architectural(self) -> bool {
        matches!(self, Self::Architectural)
    }
}

/// Kind of translated memory access.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessKind {
    Instruction,
    DataRead,
    DataWrite,
}

impl AccessKind {
    pub const fn is_write(self) -> bool {
        matches!(self, Self::DataWrite)
    }
}

/// The resident TLB location associated with a page translation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TlbLocation {
    pub set: u8,
    pub way: u8,
}

/// Metadata retained for a hashed-page mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageMapping {
    pub pte0: u32,
    pub pte1: u32,
    pub pte_physical: u32,
    pub secondary: bool,
    pub slot: u8,
    pub vsid: u32,
    pub key: u8,
    pub protection: u8,
    pub wimg: u8,
    pub tlb_hit: bool,
    pub location: Option<TlbLocation>,
}

/// Source of a successful (or permission-denied) translation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranslationSource {
    Real,
    Bat { index: u8, protection: u8, wimg: u8 },
    Page(PageMapping),
}

/// A completely resolved effective-to-physical mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Translation {
    pub effective: u32,
    pub physical: u32,
    pub access: AccessKind,
    pub source: TranslationSource,
}

/// A contiguous effective range and its first resolved mapping.
///
/// The implementation retains every validated mapping while resolving the
/// range, but keeps the common one/two-segment case inline without a heap
/// allocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RangeTranslation {
    pub effective: u32,
    pub physical: u32,
    pub len: u64,
    pub access: AccessKind,
    pub segments: u32,
    pub first: Translation,
}

/// Failure while validating a translated range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeTranslationFault {
    InvalidRange {
        effective: u32,
        physical: Option<u32>,
        len: u64,
        access: AccessKind,
    },
    Translation {
        effective_start: u32,
        len: u64,
        fault_effective: u32,
        fault: TranslationFault,
    },
    NonContiguous {
        effective_start: u32,
        physical_start: u32,
        len: u64,
        fault_effective: u32,
        fault_physical: u32,
        access: AccessKind,
    },
}

impl Translation {
    pub const fn page(self) -> Option<PageMapping> {
        match self.source {
            TranslationSource::Page(page) => Some(page),
            TranslationSource::Real | TranslationSource::Bat { .. } => None,
        }
    }
}

/// Why an instruction page cannot be executed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoExecuteReason {
    DirectStoreSegment,
    SegmentNoExecute,
}

/// Precise terminal translation fault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranslationFault {
    /// A matching BAT/PTE denied the access.  It must not fall through.
    Protection { mapping: Translation },
    /// Instruction fetch from a guarded page.
    Guarded { mapping: Translation },
    /// Data translation selected an SR[T] direct-store segment.
    DirectStore { effective: u32, access: AccessKind },
    /// Instruction translation selected SR[T] or SR[N].
    NoExecute {
        effective: u32,
        reason: NoExecuteReason,
    },
    /// The selected primary or secondary PTEG is outside physical memory.
    PageTableUnbacked {
        effective: u32,
        access: AccessKind,
        pteg: u32,
        secondary: bool,
    },
    /// Neither the primary nor secondary PTEG contained an exact PTE0 match.
    PageFault {
        effective: u32,
        access: AccessKind,
        primary_pteg: u32,
        secondary_pteg: u32,
    },
}

impl TranslationFault {
    pub const fn effective(self) -> u32 {
        match self {
            Self::Protection { mapping } | Self::Guarded { mapping } => mapping.effective,
            Self::DirectStore { effective, .. }
            | Self::NoExecute { effective, .. }
            | Self::PageTableUnbacked { effective, .. }
            | Self::PageFault { effective, .. } => effective,
        }
    }

    pub const fn access(self) -> AccessKind {
        match self {
            Self::Protection { mapping } | Self::Guarded { mapping } => mapping.access,
            Self::DirectStore { access, .. }
            | Self::PageTableUnbacked { access, .. }
            | Self::PageFault { access, .. } => access,
            Self::NoExecute { .. } => AccessKind::Instruction,
        }
    }

    /// DSISR cause bits used by the browser runtime for this data fault.
    pub const fn data_storage_cause(self) -> Option<u32> {
        let access = self.access();
        if matches!(access, AccessKind::Instruction) {
            return None;
        }
        let mut cause = if access.is_write() { 0x0200_0000 } else { 0 };
        cause |= match self {
            Self::PageFault { .. } => 0x4000_0000,
            Self::Protection { .. } => 0x0800_0000,
            Self::DirectStore { .. } => 0x0400_0000,
            Self::PageTableUnbacked { .. } => 0,
            Self::Guarded { .. } | Self::NoExecute { .. } => return None,
        };
        Some(cause)
    }

    /// SRR1 cause bits used by an instruction-storage exception, when the
    /// fault is architecturally an ISI rather than a host-backing failure.
    pub const fn instruction_storage_cause(self) -> Option<u32> {
        match self {
            Self::PageFault {
                access: AccessKind::Instruction,
                ..
            } => Some(0x4000_0000),
            Self::Protection { mapping } if matches!(mapping.access, AccessKind::Instruction) => {
                Some(0x0800_0000)
            }
            Self::Guarded { .. } | Self::NoExecute { .. } => Some(0x1000_0000),
            Self::PageTableUnbacked { .. }
            | Self::DirectStore { .. }
            | Self::PageFault { .. }
            | Self::Protection { .. } => None,
        }
    }
}

/// Result of the BAT-only stage.  A miss means hashed translation is still
/// required; it is not itself an instruction/data-storage fault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatResolution {
    Mapped(Translation),
    Protection(Translation),
    Miss,
}

/// Exact primary/secondary hashed-page-table lookup vector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageTableVector {
    pub primary_pteg: u32,
    pub secondary_pteg: u32,
    pub primary_pte0: u32,
    pub secondary_pte0: u32,
}

/// Computes the architected hashed-page lookup vector for one effective page.
pub const fn page_table_vector(effective: u32, segment: u32, sdr1: u32) -> PageTableVector {
    let vsid = segment & VSID_MASK;
    let page_index = (effective >> 12) & PAGE_INDEX_MASK;
    let api = (effective >> 22) & 0x3f;
    let primary_hash = ((vsid & 0x7ffff) ^ page_index) & 0x7ffff;
    let secondary_hash = (!primary_hash) & 0x7ffff;
    let table_base = sdr1 & 0xffff_0000;
    let table_mask = 0x3ff | ((sdr1 & 0x1ff) << 10);
    let primary_pteg = table_base | ((primary_hash & table_mask) << 6);
    let secondary_pteg = table_base | ((secondary_hash & table_mask) << 6);
    let pte0_base = 0x8000_0000 | (vsid << 7) | api;
    PageTableVector {
        primary_pteg,
        secondary_pteg,
        primary_pte0: pte0_base,
        secondary_pte0: pte0_base | 0x40,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TlbEntry {
    pte0: u32,
    pte1: u32,
    pte_physical: u32,
    secondary: bool,
    slot: u8,
    vsid: u32,
    page_index: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct TlbSet {
    entries: [Option<TlbEntry>; TLB_WAY_COUNT],
    lru: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DataPageRequest {
    effective: u32,
    msr: u32,
    segment: u32,
    sdr1: u32,
    access: AccessKind,
    effect: TranslationEffect,
}

/// Retains exact preflight results.  Scalar and single-boundary accesses use
/// the inline slots; only larger DMA/debug ranges allocate.
struct ValidatedMappings {
    inline: [Option<Translation>; 2],
    spill: Vec<Translation>,
    len: u32,
}

impl ValidatedMappings {
    fn new() -> Self {
        Self {
            inline: [None, None],
            spill: Vec::new(),
            len: 0,
        }
    }

    fn push(&mut self, mapping: Translation) {
        if self.len < 2 && self.spill.is_empty() {
            self.inline[self.len as usize] = Some(mapping);
        } else {
            if self.spill.is_empty() {
                self.spill.reserve(4);
                self.spill.push(self.inline[0].take().unwrap());
                self.spill.push(self.inline[1].take().unwrap());
            }
            self.spill.push(mapping);
        }
        self.len += 1;
    }

    fn into_iter(self) -> impl Iterator<Item = Translation> {
        self.inline.into_iter().flatten().chain(self.spill)
    }
}

/// Read-only description of one resident entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResidentEntry {
    pub location: TlbLocation,
    pub pte0: u32,
    pub pte1: u32,
    pub pte_physical: u32,
    pub secondary: bool,
    pub slot: u8,
    pub vsid: u32,
    pub page_index: u16,
}

impl ResidentEntry {
    fn from_entry(location: TlbLocation, entry: TlbEntry) -> Self {
        Self {
            location,
            pte0: entry.pte0,
            pte1: entry.pte1,
            pte_physical: entry.pte_physical,
            secondary: entry.secondary,
            slot: entry.slot,
            vsid: entry.vsid,
            page_index: entry.page_index,
        }
    }
}

/// Counts returned by one set-scoped `tlbie` operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TlbInvalidation {
    pub set: u8,
    pub instruction_entries: u8,
    pub data_entries: u8,
}

/// Rust-authoritative MPC750 instruction/data address translator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mpc750Mmu {
    instruction_tlb: [TlbSet; TLB_SET_COUNT],
    data_tlb: [TlbSet; TLB_SET_COUNT],
}

impl Default for Mpc750Mmu {
    fn default() -> Self {
        Self {
            instruction_tlb: [TlbSet::default(); TLB_SET_COUNT],
            data_tlb: [TlbSet::default(); TLB_SET_COUNT],
        }
    }
}

impl Mpc750Mmu {
    pub fn new() -> Self {
        Self::default()
    }

    /// MPC750 set selection uses effective-address bits 14 through 19.
    pub const fn tlb_set_index(effective: u32) -> u8 {
        ((effective >> 12) & 0x3f) as u8
    }

    /// Invalidates all instruction and data ways selected by the effective
    /// address, matching the set-scoped browser `tlbie` contract.
    pub fn tlbie(&mut self, effective: u32) -> TlbInvalidation {
        let set = Self::tlb_set_index(effective);
        let instruction_entries = invalidate_set(&mut self.instruction_tlb[set as usize]);
        let data_entries = invalidate_set(&mut self.data_tlb[set as usize]);
        TlbInvalidation {
            set,
            instruction_entries,
            data_entries,
        }
    }

    /// MPC750 `tlbsync` orders invalidations but does not discard residency.
    pub fn tlbsync(&mut self) {}

    /// Clears every instruction/data TLB entry and replacement bit.
    pub fn reset(&mut self) {
        self.instruction_tlb.fill(TlbSet::default());
        self.data_tlb.fill(TlbSet::default());
    }

    /// Returns a resident data entry without touching its replacement state.
    pub fn resident_data(&self, effective: u32, vsid: u32) -> Option<ResidentEntry> {
        lookup_tlb(&self.data_tlb, effective, vsid)
            .map(|(entry, location)| ResidentEntry::from_entry(location, entry))
    }

    /// Returns a resident instruction entry without touching replacement state.
    pub fn resident_instruction(&self, effective: u32, vsid: u32) -> Option<ResidentEntry> {
        lookup_tlb(&self.instruction_tlb, effective, vsid)
            .map(|(entry, location)| ResidentEntry::from_entry(location, entry))
    }

    /// Current replacement way for one data set.
    pub fn data_replacement_way(&self, set: u8) -> u8 {
        self.data_tlb[set as usize].lru
    }

    /// Current replacement way for one instruction set.
    pub fn instruction_replacement_way(&self, set: u8) -> u8 {
        self.instruction_tlb[set as usize].lru
    }

    /// Resolves only real mode and DBATs.  `Miss` requires the page walker.
    pub fn resolve_data_bat(
        registers: &TranslationRegisters,
        effective: u32,
        write: bool,
    ) -> BatResolution {
        let access = if write {
            AccessKind::DataWrite
        } else {
            AccessKind::DataRead
        };
        if registers.msr & MSR_DR == 0 {
            return BatResolution::Mapped(Translation {
                effective,
                physical: effective,
                access,
                source: TranslationSource::Real,
            });
        }
        resolve_bats(effective, registers.msr, &registers.data_bats, access)
    }

    /// Resolves only real mode and IBATs.  `Miss` requires the page walker.
    pub fn resolve_instruction_bat(
        registers: &TranslationRegisters,
        effective: u32,
    ) -> BatResolution {
        if registers.msr & MSR_IR == 0 {
            return BatResolution::Mapped(Translation {
                effective,
                physical: effective,
                access: AccessKind::Instruction,
                source: TranslationSource::Real,
            });
        }
        resolve_bats(
            effective,
            registers.msr,
            &registers.instruction_bats,
            AccessKind::Instruction,
        )
    }

    /// Validates and translates a contiguous data range.
    ///
    /// Architectural history is atomic with respect to translation and
    /// contiguity: the complete range is probed and its exact mappings are
    /// retained first.  On success those results commit each page's TLB/R/C
    /// state without a second walk.  A denied page alone gains R, matching the
    /// precise browser DSI contract; preceding pages do not.
    pub fn translate_data_range<M: ByteMemory + ?Sized>(
        &mut self,
        memory: &mut M,
        registers: &TranslationRegisters,
        effective: u32,
        len: u64,
        write: bool,
        effect: TranslationEffect,
    ) -> Result<RangeTranslation, RangeTranslationFault> {
        let access = if write {
            AccessKind::DataWrite
        } else {
            AccessKind::DataRead
        };
        validate_range(effective, len, access)?;

        let preflight = self.preflight_data_range(memory, registers, effective, len, write);
        let validated = match preflight {
            Ok(resolved) => resolved,
            Err(RangeTranslationFault::Translation {
                effective_start,
                len,
                fault_effective,
                fault: TranslationFault::Protection { mapping },
            }) if effect.is_architectural() => {
                let mapping = self.commit_data_history(memory, mapping, false);
                return Err(RangeTranslationFault::Translation {
                    effective_start,
                    len,
                    fault_effective,
                    fault: TranslationFault::Protection { mapping },
                });
            }
            Err(fault) => return Err(fault),
        };
        let segments = validated.len;
        let mut mappings = validated.into_iter();
        let first_probe = mappings
            .next()
            .expect("a non-empty validated range retains its first mapping");
        let first = if effect.is_architectural() {
            let first = self.commit_data_history(memory, first_probe, true);
            for mapping in mappings {
                self.commit_data_history(memory, mapping, true);
            }
            first
        } else {
            first_probe
        };
        Ok(RangeTranslation {
            effective,
            physical: first.physical,
            len,
            access,
            segments,
            first,
        })
    }

    /// Validates and translates a contiguous instruction range without
    /// allocation.  Probe mode is suitable for compilation/disassembly;
    /// architectural mode references and retains each executable page.
    pub fn translate_instruction_range<M: ByteMemory + ?Sized>(
        &mut self,
        memory: &mut M,
        registers: &TranslationRegisters,
        effective: u32,
        len: u64,
        effect: TranslationEffect,
    ) -> Result<RangeTranslation, RangeTranslationFault> {
        validate_range(effective, len, AccessKind::Instruction)?;
        let mut offset = 0u64;
        let mut first = None;
        let mut physical_start = 0;
        let mut segments = 0u32;
        while offset < len {
            let current_effective = effective.wrapping_add(offset as u32);
            let current = self
                .translate_instruction(memory, registers, current_effective, effect)
                .map_err(|fault| RangeTranslationFault::Translation {
                    effective_start: effective,
                    len,
                    fault_effective: current_effective,
                    fault,
                })?;
            if first.is_none() {
                validate_physical_range(effective, current.physical, len, AccessKind::Instruction)?;
                physical_start = current.physical;
                first = Some(current);
            } else if u64::from(current.physical) != u64::from(physical_start) + offset {
                return Err(RangeTranslationFault::NonContiguous {
                    effective_start: effective,
                    physical_start,
                    len,
                    fault_effective: current_effective,
                    fault_physical: current.physical,
                    access: AccessKind::Instruction,
                });
            }
            segments += 1;
            offset += translation_span(current, len - offset);
        }
        Ok(RangeTranslation {
            effective,
            physical: physical_start,
            len,
            access: AccessKind::Instruction,
            segments,
            first: first.expect("non-empty validated range has a first mapping"),
        })
    }

    /// Resolves one data access through real mode, DBATs, and hashed pages.
    pub fn translate_data<M: ByteMemory + ?Sized>(
        &mut self,
        memory: &mut M,
        registers: &TranslationRegisters,
        effective: u32,
        write: bool,
        effect: TranslationEffect,
    ) -> Result<Translation, TranslationFault> {
        match Self::resolve_data_bat(registers, effective, write) {
            BatResolution::Mapped(mapping) => return Ok(mapping),
            BatResolution::Protection(mapping) => {
                return Err(TranslationFault::Protection { mapping });
            }
            BatResolution::Miss => {}
        }

        let access = if write {
            AccessKind::DataWrite
        } else {
            AccessKind::DataRead
        };
        let segment = registers.segments[(effective >> 28) as usize];
        if segment & 0x8000_0000 != 0 {
            return Err(TranslationFault::DirectStore { effective, access });
        }

        let resolved = self.walk_data_page(
            memory,
            DataPageRequest {
                effective,
                msr: registers.msr,
                segment,
                sdr1: registers.sdr1,
                access,
                effect,
            },
        );
        if !effect.is_architectural() {
            return resolved;
        }
        match resolved {
            Ok(mapping) => Ok(self.commit_data_history(memory, mapping, true)),
            Err(TranslationFault::Protection { mapping }) => Err(TranslationFault::Protection {
                mapping: self.commit_data_history(memory, mapping, false),
            }),
            Err(fault) => Err(fault),
        }
    }

    /// Resolves one instruction fetch through real mode, IBATs, and hashed pages.
    pub fn translate_instruction<M: ByteMemory + ?Sized>(
        &mut self,
        memory: &mut M,
        registers: &TranslationRegisters,
        effective: u32,
        effect: TranslationEffect,
    ) -> Result<Translation, TranslationFault> {
        match Self::resolve_instruction_bat(registers, effective) {
            BatResolution::Mapped(mapping) => return Ok(mapping),
            BatResolution::Protection(mapping) => {
                return Err(TranslationFault::Protection { mapping });
            }
            BatResolution::Miss => {}
        }

        let segment = registers.segments[(effective >> 28) as usize];
        if segment & 0x8000_0000 != 0 {
            return Err(TranslationFault::NoExecute {
                effective,
                reason: NoExecuteReason::DirectStoreSegment,
            });
        }
        if segment & 0x1000_0000 != 0 {
            return Err(TranslationFault::NoExecute {
                effective,
                reason: NoExecuteReason::SegmentNoExecute,
            });
        }
        self.walk_instruction_page(
            memory,
            effective,
            registers.msr,
            segment,
            registers.sdr1,
            effect,
        )
    }

    fn walk_data_page<M: ByteMemory + ?Sized>(
        &mut self,
        memory: &mut M,
        request: DataPageRequest,
    ) -> Result<Translation, TranslationFault> {
        let DataPageRequest {
            effective,
            msr,
            segment,
            sdr1,
            access,
            effect,
        } = request;
        let vsid = segment & VSID_MASK;
        let touch = effect.is_architectural();
        if let Some((entry, location)) = lookup_tlb_mut(&mut self.data_tlb, effective, vsid, touch)
        {
            return data_mapping(effective, msr, segment, access, entry, true, Some(location));
        }

        let vector = page_table_vector(effective, segment, sdr1);
        for (secondary, pteg, expected_pte0) in [
            (false, vector.primary_pteg, vector.primary_pte0),
            (true, vector.secondary_pteg, vector.secondary_pte0),
        ] {
            if !memory.is_backed(pteg, 64) {
                return Err(TranslationFault::PageTableUnbacked {
                    effective,
                    access,
                    pteg,
                    secondary,
                });
            }
            for slot in 0..8u8 {
                let pte_physical = pteg + u32::from(slot) * 8;
                let pte0 =
                    read_be_u32(memory, pte_physical).expect("is_backed promised a readable PTEG");
                if pte0 != expected_pte0 {
                    continue;
                }
                let entry = TlbEntry {
                    pte0,
                    pte1: read_be_u32(memory, pte_physical + 4)
                        .expect("is_backed promised a readable PTEG"),
                    pte_physical,
                    secondary,
                    slot,
                    vsid,
                    page_index: page_index(effective),
                };
                return data_mapping(effective, msr, segment, access, entry, false, None);
            }
        }
        Err(TranslationFault::PageFault {
            effective,
            access,
            primary_pteg: vector.primary_pteg,
            secondary_pteg: vector.secondary_pteg,
        })
    }

    fn preflight_data_range<M: ByteMemory + ?Sized>(
        &mut self,
        memory: &mut M,
        registers: &TranslationRegisters,
        effective: u32,
        len: u64,
        write: bool,
    ) -> Result<ValidatedMappings, RangeTranslationFault> {
        let access = if write {
            AccessKind::DataWrite
        } else {
            AccessKind::DataRead
        };
        let mut offset = 0u64;
        let mut mappings = ValidatedMappings::new();
        let mut physical_start = 0;
        while offset < len {
            let current_effective = effective.wrapping_add(offset as u32);
            let current = self
                .translate_data(
                    memory,
                    registers,
                    current_effective,
                    write,
                    TranslationEffect::Probe,
                )
                .map_err(|fault| RangeTranslationFault::Translation {
                    effective_start: effective,
                    len,
                    fault_effective: current_effective,
                    fault,
                })?;
            if mappings.len == 0 {
                validate_physical_range(effective, current.physical, len, access)?;
                physical_start = current.physical;
            } else if u64::from(current.physical) != u64::from(physical_start) + offset {
                return Err(RangeTranslationFault::NonContiguous {
                    effective_start: effective,
                    physical_start,
                    len,
                    fault_effective: current_effective,
                    fault_physical: current.physical,
                    access,
                });
            }
            mappings.push(current);
            offset += translation_span(current, len - offset);
        }
        Ok(mappings)
    }

    fn walk_instruction_page<M: ByteMemory + ?Sized>(
        &mut self,
        memory: &mut M,
        effective: u32,
        msr: u32,
        segment: u32,
        sdr1: u32,
        effect: TranslationEffect,
    ) -> Result<Translation, TranslationFault> {
        let vsid = segment & VSID_MASK;
        let touch = effect.is_architectural();
        if let Some((entry, location)) =
            lookup_tlb_mut(&mut self.instruction_tlb, effective, vsid, touch)
        {
            return instruction_mapping(effective, msr, segment, entry, true, Some(location));
        }

        let vector = page_table_vector(effective, segment, sdr1);
        for (secondary, pteg, expected_pte0) in [
            (false, vector.primary_pteg, vector.primary_pte0),
            (true, vector.secondary_pteg, vector.secondary_pte0),
        ] {
            if !memory.is_backed(pteg, 64) {
                return Err(TranslationFault::PageTableUnbacked {
                    effective,
                    access: AccessKind::Instruction,
                    pteg,
                    secondary,
                });
            }
            for slot in 0..8u8 {
                let pte_physical = pteg + u32::from(slot) * 8;
                let pte0 =
                    read_be_u32(memory, pte_physical).expect("is_backed promised a readable PTEG");
                if pte0 != expected_pte0 {
                    continue;
                }
                let mut pte1 = read_be_u32(memory, pte_physical + 4)
                    .expect("is_backed promised a readable PTEG");
                if touch && pte1 & PTE_REFERENCED == 0 {
                    let history_byte = memory
                        .read_byte(pte_physical + 6)
                        .expect("is_backed promised a readable PTE");
                    assert!(
                        memory.write_byte(pte_physical + 6, history_byte | 1),
                        "is_backed promised a writable PTE"
                    );
                    pte1 |= PTE_REFERENCED;
                }
                let entry = TlbEntry {
                    pte0,
                    pte1,
                    pte_physical,
                    secondary,
                    slot,
                    vsid,
                    page_index: page_index(effective),
                };
                let location = touch.then(|| fill_tlb(&mut self.instruction_tlb, effective, entry));
                return instruction_mapping(effective, msr, segment, entry, false, location);
            }
        }
        Err(TranslationFault::PageFault {
            effective,
            access: AccessKind::Instruction,
            primary_pteg: vector.primary_pteg,
            secondary_pteg: vector.secondary_pteg,
        })
    }

    fn commit_data_history<M: ByteMemory + ?Sized>(
        &mut self,
        memory: &mut M,
        mut mapping: Translation,
        permitted: bool,
    ) -> Translation {
        let TranslationSource::Page(mut page) = mapping.source else {
            return mapping;
        };
        let effective_page = page_index(mapping.effective);
        let mut location = page.location.filter(|location| {
            self.data_tlb[location.set as usize].entries[location.way as usize]
                .is_some_and(|entry| entry.vsid == page.vsid && entry.page_index == effective_page)
        });
        if location.is_none() {
            location = Some(fill_tlb(
                &mut self.data_tlb,
                mapping.effective,
                TlbEntry {
                    pte0: page.pte0,
                    pte1: page.pte1,
                    pte_physical: page.pte_physical,
                    secondary: page.secondary,
                    slot: page.slot,
                    vsid: page.vsid,
                    page_index: effective_page,
                },
            ));
        }
        let location = location.expect("a data translation always acquires a TLB way");
        let set = &mut self.data_tlb[location.set as usize];
        set.lru = location.way ^ 1;
        let resident = set.entries[location.way as usize]
            .as_mut()
            .expect("the selected TLB way is resident");
        let history = if permitted && mapping.access.is_write() {
            PTE_REFERENCED | PTE_CHANGED
        } else {
            PTE_REFERENCED
        };
        let cached_pte1 = resident.pte1;
        let pte1 = cached_pte1 | history;
        if pte1 != cached_pte1 {
            resident.pte1 = pte1;
            let backing = read_be_u32(memory, page.pte_physical + 4)
                .expect("a resident PTE remains physically backed");
            let backing_with_history = backing | history;
            if backing_with_history != backing {
                write_be_u32(memory, page.pte_physical + 4, backing_with_history);
            }
        }
        page.pte1 = pte1;
        page.protection = (pte1 & 3) as u8;
        page.wimg = ((pte1 >> 3) & 0xf) as u8;
        page.location = Some(location);
        mapping.source = TranslationSource::Page(page);
        mapping
    }
}

fn resolve_bats(
    effective: u32,
    msr: u32,
    bats: &[BatPair; 4],
    access: AccessKind,
) -> BatResolution {
    let valid = if msr & MSR_PR != 0 { 1 } else { 2 };
    for (index, bat) in bats.iter().enumerate() {
        if bat.upper & valid == 0 {
            continue;
        }
        let block_mask = ((bat.upper >> 2) & 0x7ff) << 17;
        let address_mask = block_mask | 0x1ffff;
        let region_mask = !address_mask;
        if effective & region_mask != bat.upper & region_mask {
            continue;
        }
        let physical_base = (bat.lower & 0xfffe_0000) & region_mask;
        let mapping = Translation {
            effective,
            physical: physical_base | (effective & address_mask),
            access,
            source: TranslationSource::Bat {
                index: index as u8,
                protection: (bat.lower & 3) as u8,
                wimg: ((bat.lower >> 3) & 0xf) as u8,
            },
        };
        let permitted = bat_allows_access(bat.lower, access.is_write());
        return if permitted {
            BatResolution::Mapped(mapping)
        } else {
            BatResolution::Protection(mapping)
        };
    }
    BatResolution::Miss
}

fn data_mapping(
    effective: u32,
    msr: u32,
    segment: u32,
    access: AccessKind,
    entry: TlbEntry,
    tlb_hit: bool,
    location: Option<TlbLocation>,
) -> Result<Translation, TranslationFault> {
    let key = selected_key(msr, segment);
    let mapping = Translation {
        effective,
        physical: (entry.pte1 & 0xffff_f000) | (effective & PAGE_OFFSET_MASK),
        access,
        source: TranslationSource::Page(PageMapping {
            pte0: entry.pte0,
            pte1: entry.pte1,
            pte_physical: entry.pte_physical,
            secondary: entry.secondary,
            slot: entry.slot,
            vsid: entry.vsid,
            key,
            protection: (entry.pte1 & 3) as u8,
            wimg: ((entry.pte1 >> 3) & 0xf) as u8,
            tlb_hit,
            location,
        }),
    };
    if data_page_allows_access(msr, segment, entry.pte1, access.is_write()) {
        Ok(mapping)
    } else {
        Err(TranslationFault::Protection { mapping })
    }
}

fn instruction_mapping(
    effective: u32,
    msr: u32,
    segment: u32,
    entry: TlbEntry,
    tlb_hit: bool,
    location: Option<TlbLocation>,
) -> Result<Translation, TranslationFault> {
    let key = selected_key(msr, segment);
    let mapping = Translation {
        effective,
        physical: (entry.pte1 & 0xffff_f000) | (effective & PAGE_OFFSET_MASK),
        access: AccessKind::Instruction,
        source: TranslationSource::Page(PageMapping {
            pte0: entry.pte0,
            pte1: entry.pte1,
            pte_physical: entry.pte_physical,
            secondary: entry.secondary,
            slot: entry.slot,
            vsid: entry.vsid,
            key,
            protection: (entry.pte1 & 3) as u8,
            wimg: ((entry.pte1 >> 3) & 0xf) as u8,
            tlb_hit,
            location,
        }),
    };
    if entry.pte1 & 0x08 != 0 {
        return Err(TranslationFault::Guarded { mapping });
    }
    if key == 1 && entry.pte1 & 3 == 0 {
        return Err(TranslationFault::Protection { mapping });
    }
    Ok(mapping)
}

const fn selected_key(msr: u32, segment: u32) -> u8 {
    let mask = if msr & MSR_PR != 0 {
        0x2000_0000
    } else {
        0x4000_0000
    };
    if segment & mask != 0 { 1 } else { 0 }
}

const fn page_index(effective: u32) -> u16 {
    ((effective >> 12) & PAGE_INDEX_MASK) as u16
}

fn validate_range(
    effective: u32,
    len: u64,
    access: AccessKind,
) -> Result<(), RangeTranslationFault> {
    if len == 0 || u64::from(effective) + len > 0x1_0000_0000 {
        return Err(RangeTranslationFault::InvalidRange {
            effective,
            physical: None,
            len,
            access,
        });
    }
    Ok(())
}

fn validate_physical_range(
    effective: u32,
    physical: u32,
    len: u64,
    access: AccessKind,
) -> Result<(), RangeTranslationFault> {
    if u64::from(physical) + len > 0x1_0000_0000 {
        return Err(RangeTranslationFault::InvalidRange {
            effective,
            physical: Some(physical),
            len,
            access,
        });
    }
    Ok(())
}

fn translation_span(mapping: Translation, remaining: u64) -> u64 {
    let boundary = match mapping.source {
        TranslationSource::Page(_) => 0x1000 - u64::from(mapping.effective & 0x0fff),
        TranslationSource::Bat { .. } => 0x2_0000 - u64::from(mapping.effective & 0x1_ffff),
        TranslationSource::Real => remaining,
    };
    remaining.min(boundary)
}

fn lookup_tlb(
    tlb: &[TlbSet; TLB_SET_COUNT],
    effective: u32,
    vsid: u32,
) -> Option<(TlbEntry, TlbLocation)> {
    let set_index = Mpc750Mmu::tlb_set_index(effective);
    let page_index = page_index(effective);
    let set = &tlb[set_index as usize];
    for way in 0..TLB_WAY_COUNT {
        let Some(entry) = set.entries[way] else {
            continue;
        };
        if entry.vsid == vsid & VSID_MASK && entry.page_index == page_index {
            return Some((
                entry,
                TlbLocation {
                    set: set_index,
                    way: way as u8,
                },
            ));
        }
    }
    None
}

fn lookup_tlb_mut(
    tlb: &mut [TlbSet; TLB_SET_COUNT],
    effective: u32,
    vsid: u32,
    touch: bool,
) -> Option<(TlbEntry, TlbLocation)> {
    let set_index = Mpc750Mmu::tlb_set_index(effective);
    let page_index = page_index(effective);
    let set = &mut tlb[set_index as usize];
    for way in 0..TLB_WAY_COUNT {
        let Some(entry) = set.entries[way] else {
            continue;
        };
        if entry.vsid == vsid & VSID_MASK && entry.page_index == page_index {
            if touch {
                set.lru = (way as u8) ^ 1;
            }
            return Some((
                entry,
                TlbLocation {
                    set: set_index,
                    way: way as u8,
                },
            ));
        }
    }
    None
}

fn fill_tlb(tlb: &mut [TlbSet; TLB_SET_COUNT], effective: u32, mut entry: TlbEntry) -> TlbLocation {
    let set_index = Mpc750Mmu::tlb_set_index(effective);
    let set = &mut tlb[set_index as usize];
    let way = set
        .entries
        .iter()
        .position(Option::is_none)
        .unwrap_or(set.lru as usize);
    entry.page_index = page_index(effective);
    entry.vsid &= VSID_MASK;
    set.entries[way] = Some(entry);
    set.lru = (way as u8) ^ 1;
    TlbLocation {
        set: set_index,
        way: way as u8,
    }
}

fn invalidate_set(set: &mut TlbSet) -> u8 {
    let count = set.entries.iter().filter(|entry| entry.is_some()).count() as u8;
    *set = TlbSet::default();
    count
}

fn read_be_u32<M: ByteMemory + ?Sized>(memory: &M, physical: u32) -> Option<u32> {
    if !memory.is_backed(physical, 4) {
        return None;
    }
    Some(u32::from_be_bytes([
        memory.read_byte(physical)?,
        memory.read_byte(physical + 1)?,
        memory.read_byte(physical + 2)?,
        memory.read_byte(physical + 3)?,
    ]))
}

fn write_be_u32<M: ByteMemory + ?Sized>(memory: &mut M, physical: u32, value: u32) {
    assert!(memory.is_backed(physical, 4));
    for (offset, byte) in value.to_be_bytes().into_iter().enumerate() {
        assert!(memory.write_byte(physical + offset as u32, byte));
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::ops::Range;

    use super::*;

    const OFFICIAL_EFFECTIVE: u32 = 0x00ff_a01b;
    const OFFICIAL_PRIMARY: u32 = 0x0f9f_f980;
    const OFFICIAL_PRIMARY_PTE0: u32 = 0xe538_0e03;
    const OFFICIAL_SDR1: u32 = 0x0f98_0007;
    const OFFICIAL_SECONDARY: u32 = 0x0f98_0640;
    const OFFICIAL_SECONDARY_PTE0: u32 = 0xe538_0e43;
    const OFFICIAL_SEGMENT: u32 = 0x20ca_701c;

    #[derive(Default)]
    struct SparseMemory {
        backed: Vec<Range<u32>>,
        bytes: BTreeMap<u32, u8>,
        writes: Vec<(u32, u8)>,
    }

    impl SparseMemory {
        fn back(&mut self, start: u32, len: u32) {
            self.backed.push(start..start + len);
        }

        fn read_u32(&self, physical: u32) -> u32 {
            read_be_u32(self, physical).unwrap()
        }

        fn write_u32(&mut self, physical: u32, value: u32) {
            if !self.is_backed(physical, 4) {
                self.back(physical, 4);
            }
            write_be_u32(self, physical, value);
            self.writes.clear();
        }
    }

    impl ByteMemory for SparseMemory {
        fn is_backed(&self, physical: u32, len: u32) -> bool {
            physical.checked_add(len).is_some_and(|end| {
                self.backed
                    .iter()
                    .any(|range| physical >= range.start && end <= range.end)
            })
        }

        fn read_byte(&self, physical: u32) -> Option<u8> {
            self.is_backed(physical, 1)
                .then(|| self.bytes.get(&physical).copied().unwrap_or(0))
        }

        fn write_byte(&mut self, physical: u32, value: u8) -> bool {
            if !self.is_backed(physical, 1) {
                return false;
            }
            self.bytes.insert(physical, value);
            self.writes.push((physical, value));
            true
        }
    }

    fn registers(msr: u32, effective: u32, segment: u32, sdr1: u32) -> TranslationRegisters {
        let mut registers = TranslationRegisters {
            msr,
            sdr1,
            ..TranslationRegisters::default()
        };
        registers.segments[(effective >> 28) as usize] = segment;
        registers
    }

    fn install_pte(
        memory: &mut SparseMemory,
        effective: u32,
        segment: u32,
        sdr1: u32,
        secondary: bool,
        slot: u8,
        pte1: u32,
    ) -> u32 {
        let vector = page_table_vector(effective, segment, sdr1);
        let (pteg, pte0) = if secondary {
            (vector.secondary_pteg, vector.secondary_pte0)
        } else {
            (vector.primary_pteg, vector.primary_pte0)
        };
        memory.back(pteg, 64);
        let pte = pteg + u32::from(slot) * 8;
        memory.write_u32(pte, pte0);
        memory.write_u32(pte + 4, pte1);
        pte
    }

    fn two_page_setup(
        second_pte1: Option<u32>,
        segment: u32,
    ) -> (SparseMemory, TranslationRegisters, u32, u32, Option<u32>) {
        let effective = 0x00ff_aff0;
        let mut memory = SparseMemory::default();
        let first = install_pte(
            &mut memory,
            effective,
            segment,
            OFFICIAL_SDR1,
            false,
            0,
            0x0012_3002,
        );
        let second = second_pte1.map(|pte1| {
            install_pte(
                &mut memory,
                effective + 0x10,
                segment,
                OFFICIAL_SDR1,
                false,
                0,
                pte1,
            )
        });
        if second.is_none() {
            let vector = page_table_vector(effective + 0x10, segment, OFFICIAL_SDR1);
            memory.back(vector.primary_pteg, 64);
            memory.back(vector.secondary_pteg, 64);
        }
        let regs = registers(MSR_DR | MSR_IR, effective, segment, OFFICIAL_SDR1);
        (memory, regs, effective, first, second)
    }

    #[test]
    fn official_hashed_page_vector_matches_browser_contract() {
        assert_eq!(
            page_table_vector(OFFICIAL_EFFECTIVE, OFFICIAL_SEGMENT, OFFICIAL_SDR1),
            PageTableVector {
                primary_pteg: OFFICIAL_PRIMARY,
                secondary_pteg: OFFICIAL_SECONDARY,
                primary_pte0: OFFICIAL_PRIMARY_PTE0,
                secondary_pte0: OFFICIAL_SECONDARY_PTE0,
            }
        );
    }

    #[test]
    fn real_mode_and_bats_honor_ir_dr_privilege_mask_and_protection() {
        let mut memory = SparseMemory::default();
        let mut mmu = Mpc750Mmu::new();
        let mut regs = TranslationRegisters::default();
        let effective = 0x9000_1234;
        assert_eq!(
            mmu.translate_data(
                &mut memory,
                &regs,
                effective,
                true,
                TranslationEffect::Architectural,
            )
            .unwrap()
            .physical,
            effective
        );
        assert_eq!(
            mmu.translate_instruction(
                &mut memory,
                &regs,
                effective,
                TranslationEffect::Architectural,
            )
            .unwrap()
            .physical,
            effective
        );

        regs.msr = MSR_DR | MSR_IR;
        regs.data_bats[0] = BatPair::new(0x9000_0002, 0x0002_0002);
        regs.instruction_bats[0] = regs.data_bats[0];
        assert_eq!(
            mmu.translate_data(
                &mut memory,
                &regs,
                effective,
                true,
                TranslationEffect::Probe,
            )
            .unwrap()
            .physical,
            0x0002_1234
        );
        assert_eq!(
            mmu.translate_instruction(&mut memory, &regs, effective, TranslationEffect::Probe,)
                .unwrap()
                .physical,
            0x0002_1234
        );

        regs.msr |= MSR_PR;
        assert!(matches!(
            Mpc750Mmu::resolve_data_bat(&regs, effective, false),
            BatResolution::Miss
        ));
        regs.data_bats[0].upper |= 1;
        regs.data_bats[0].lower = 1;
        assert!(matches!(
            Mpc750Mmu::resolve_data_bat(&regs, effective, false),
            BatResolution::Mapped(_)
        ));
        assert!(matches!(
            Mpc750Mmu::resolve_data_bat(&regs, effective, true),
            BatResolution::Protection(_)
        ));
        regs.data_bats[0].lower = 0;
        assert!(matches!(
            Mpc750Mmu::resolve_data_bat(&regs, effective, false),
            BatResolution::Protection(_)
        ));
    }

    #[test]
    fn ranges_reject_effective_and_translated_physical_wraparound() {
        let mut memory = SparseMemory::default();
        let mut mmu = Mpc750Mmu::new();
        let regs = TranslationRegisters::default();
        assert!(matches!(
            mmu.translate_data_range(
                &mut memory,
                &regs,
                0xffff_fff0,
                0x20,
                false,
                TranslationEffect::Probe,
            ),
            Err(RangeTranslationFault::InvalidRange { physical: None, .. })
        ));

        let mut regs = TranslationRegisters {
            msr: MSR_DR,
            ..TranslationRegisters::default()
        };
        regs.data_bats[0] = BatPair::new(0x9000_0002, 0xfffe_0002);
        assert!(matches!(
            mmu.translate_data_range(
                &mut memory,
                &regs,
                0x9001_fff0,
                0x20,
                false,
                TranslationEffect::Probe,
            ),
            Err(RangeTranslationFault::InvalidRange {
                physical: Some(0xffff_fff0),
                ..
            })
        ));
    }

    #[test]
    fn primary_secondary_and_exact_pte0_matching_follow_browser_vectors() {
        for secondary in [false, true] {
            let mut memory = SparseMemory::default();
            // A backed empty primary is required before a secondary lookup.
            memory.back(OFFICIAL_PRIMARY, 64);
            install_pte(
                &mut memory,
                OFFICIAL_EFFECTIVE,
                OFFICIAL_SEGMENT,
                OFFICIAL_SDR1,
                secondary,
                5,
                0x0012_3002,
            );
            let regs = registers(
                MSR_DR | MSR_IR,
                OFFICIAL_EFFECTIVE,
                OFFICIAL_SEGMENT,
                OFFICIAL_SDR1,
            );
            let mut mmu = Mpc750Mmu::new();
            let data = mmu
                .translate_data(
                    &mut memory,
                    &regs,
                    OFFICIAL_EFFECTIVE,
                    false,
                    TranslationEffect::Probe,
                )
                .unwrap();
            assert_eq!(data.physical, 0x0012_301b);
            let page = data.page().unwrap();
            assert_eq!((page.secondary, page.slot), (secondary, 5));
            let instruction = mmu
                .translate_instruction(
                    &mut memory,
                    &regs,
                    OFFICIAL_EFFECTIVE,
                    TranslationEffect::Probe,
                )
                .unwrap();
            assert_eq!(instruction.physical, 0x0012_301b);
        }

        let mut memory = SparseMemory::default();
        install_pte(
            &mut memory,
            OFFICIAL_EFFECTIVE,
            OFFICIAL_SEGMENT,
            OFFICIAL_SDR1,
            false,
            0,
            0x0012_3002,
        );
        install_pte(
            &mut memory,
            OFFICIAL_EFFECTIVE,
            OFFICIAL_SEGMENT,
            OFFICIAL_SDR1,
            true,
            0,
            0x0045_6002,
        );
        let regs = registers(MSR_DR, OFFICIAL_EFFECTIVE, OFFICIAL_SEGMENT, OFFICIAL_SDR1);
        let primary = Mpc750Mmu::new()
            .translate_data(
                &mut memory,
                &regs,
                OFFICIAL_EFFECTIVE,
                false,
                TranslationEffect::Probe,
            )
            .unwrap();
        assert_eq!(primary.physical, 0x0012_301b);
        assert!(!primary.page().unwrap().secondary);

        for mismatch in [
            OFFICIAL_PRIMARY_PTE0 & 0x7fff_ffff,
            OFFICIAL_PRIMARY_PTE0 ^ 0x80,
            OFFICIAL_PRIMARY_PTE0 ^ 0x40,
            OFFICIAL_PRIMARY_PTE0 ^ 1,
        ] {
            let mut memory = SparseMemory::default();
            memory.back(OFFICIAL_PRIMARY, 64);
            memory.back(OFFICIAL_SECONDARY, 64);
            memory.write_u32(OFFICIAL_PRIMARY, mismatch);
            memory.write_u32(OFFICIAL_PRIMARY + 4, 0x0012_3002);
            let regs = registers(MSR_DR, OFFICIAL_EFFECTIVE, OFFICIAL_SEGMENT, OFFICIAL_SDR1);
            let fault = Mpc750Mmu::new()
                .translate_data(
                    &mut memory,
                    &regs,
                    OFFICIAL_EFFECTIVE,
                    false,
                    TranslationEffect::Probe,
                )
                .unwrap_err();
            assert!(matches!(fault, TranslationFault::PageFault { .. }));
        }
    }

    #[test]
    fn matching_bat_protection_never_falls_through_to_a_valid_pte() {
        let effective = 0x9000_1234;
        let segment = 0x00ca_701c;
        let mut memory = SparseMemory::default();
        let pte = install_pte(
            &mut memory,
            effective,
            segment,
            OFFICIAL_SDR1,
            false,
            0,
            0x0012_3002,
        );
        let mut regs = registers(MSR_DR, effective, segment, OFFICIAL_SDR1);
        regs.data_bats[0] = BatPair::new(0x9000_0003, 0x0002_0001);
        memory.writes.clear();
        let fault = Mpc750Mmu::new()
            .translate_data(
                &mut memory,
                &regs,
                effective,
                true,
                TranslationEffect::Architectural,
            )
            .unwrap_err();
        assert!(matches!(
            fault,
            TranslationFault::Protection {
                mapping: Translation {
                    source: TranslationSource::Bat { index: 0, .. },
                    ..
                }
            }
        ));
        assert_eq!(memory.read_u32(pte + 4), 0x0012_3002);
        assert!(memory.writes.is_empty());
    }

    #[test]
    fn complete_data_key_and_pp_matrix_matches_browser_semantics() {
        let allowed = [
            // key 0: PP 0..3, read/write
            [[true, true], [true, true], [true, true], [true, false]],
            // key 1: PP 0..3, read/write
            [[false, false], [true, false], [true, true], [true, false]],
        ];
        for user in [false, true] {
            for key in 0..=1u32 {
                for protection in 0..4u32 {
                    for write in [false, true] {
                        let mut memory = SparseMemory::default();
                        let opposite = key ^ 1;
                        let key_bits = if user {
                            (opposite * 0x4000_0000) | (key * 0x2000_0000)
                        } else {
                            (key * 0x4000_0000) | (opposite * 0x2000_0000)
                        };
                        let segment = key_bits | 0x00ca_701c;
                        install_pte(
                            &mut memory,
                            OFFICIAL_EFFECTIVE,
                            segment,
                            OFFICIAL_SDR1,
                            false,
                            0,
                            0x0012_3000 | protection,
                        );
                        // An exact empty secondary makes a miss a page fault rather than backing fault.
                        memory.back(OFFICIAL_SECONDARY, 64);
                        let regs = registers(
                            MSR_DR | if user { MSR_PR } else { 0 },
                            OFFICIAL_EFFECTIVE,
                            segment,
                            OFFICIAL_SDR1,
                        );
                        let actual = Mpc750Mmu::new().translate_data(
                            &mut memory,
                            &regs,
                            OFFICIAL_EFFECTIVE,
                            write,
                            TranslationEffect::Probe,
                        );
                        assert_eq!(
                            actual.is_ok(),
                            allowed[key as usize][protection as usize][write as usize],
                            "PR={user} key={key} PP={protection} write={write}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn resident_identity_uses_vsid_page_while_key_and_sdr1_are_reevaluated() {
        let effective = 0x8001_2000;
        let segment = 0x2012_3456;
        let mut memory = SparseMemory::default();
        install_pte(&mut memory, effective, segment, 0, false, 0, 0x0008_0000);
        let mut mmu = Mpc750Mmu::new();
        let mut regs = registers(MSR_DR, effective, segment, 0);
        let supervisor = mmu
            .translate_data(
                &mut memory,
                &regs,
                effective,
                false,
                TranslationEffect::Architectural,
            )
            .unwrap();
        assert_eq!(supervisor.page().unwrap().key, 0);

        regs.msr |= MSR_PR;
        let user = mmu
            .translate_data(
                &mut memory,
                &regs,
                effective,
                false,
                TranslationEffect::Architectural,
            )
            .unwrap_err();
        let TranslationFault::Protection { mapping } = user else {
            panic!("Kp must be reevaluated on a resident entry");
        };
        assert!(mapping.page().unwrap().tlb_hit);
        assert_eq!(mapping.page().unwrap().key, 1);

        regs.msr &= !MSR_PR;
        regs.sdr1 = 0x0001_0000;
        let moved_table = mmu
            .translate_data(
                &mut memory,
                &regs,
                effective,
                false,
                TranslationEffect::Architectural,
            )
            .unwrap();
        assert!(moved_table.page().unwrap().tlb_hit);
        assert_eq!(moved_table.physical, 0x0008_0000);

        let changed_segment = segment + 1;
        install_pte(
            &mut memory,
            effective,
            changed_segment,
            0,
            false,
            0,
            0x0009_0002,
        );
        regs.segments[(effective >> 28) as usize] = changed_segment;
        regs.sdr1 = 0;
        let different_vsid = mmu
            .translate_data(
                &mut memory,
                &regs,
                effective,
                false,
                TranslationEffect::Architectural,
            )
            .unwrap();
        assert!(!different_vsid.page().unwrap().tlb_hit);
        assert_eq!(different_vsid.physical, 0x0009_0000);
    }

    #[test]
    fn segment_t_n_instruction_guard_and_key_faults_are_distinct() {
        for (segment, expected) in [
            (0x80ca_701c, NoExecuteReason::DirectStoreSegment),
            (0x10ca_701c, NoExecuteReason::SegmentNoExecute),
        ] {
            let mut memory = SparseMemory::default();
            let regs = registers(MSR_IR, OFFICIAL_EFFECTIVE, segment, OFFICIAL_SDR1);
            let fault = Mpc750Mmu::new()
                .translate_instruction(
                    &mut memory,
                    &regs,
                    OFFICIAL_EFFECTIVE,
                    TranslationEffect::Architectural,
                )
                .unwrap_err();
            assert_eq!(
                fault,
                TranslationFault::NoExecute {
                    effective: OFFICIAL_EFFECTIVE,
                    reason: expected,
                }
            );
            assert_eq!(fault.instruction_storage_cause(), Some(0x1000_0000));
        }

        let mut guarded_memory = SparseMemory::default();
        install_pte(
            &mut guarded_memory,
            OFFICIAL_EFFECTIVE,
            0x00ca_701c,
            OFFICIAL_SDR1,
            false,
            0,
            0x0012_300a,
        );
        let guarded_regs = registers(MSR_IR, OFFICIAL_EFFECTIVE, 0x00ca_701c, OFFICIAL_SDR1);
        let guarded = Mpc750Mmu::new()
            .translate_instruction(
                &mut guarded_memory,
                &guarded_regs,
                OFFICIAL_EFFECTIVE,
                TranslationEffect::Probe,
            )
            .unwrap_err();
        assert!(matches!(guarded, TranslationFault::Guarded { .. }));
        assert_eq!(guarded.instruction_storage_cause(), Some(0x1000_0000));

        for (segment, msr, permitted) in [
            (0x20ca_701c, MSR_IR, true),
            (0x20ca_701c, MSR_IR | MSR_PR, false),
            (0x40ca_701c, MSR_IR, false),
            (0x40ca_701c, MSR_IR | MSR_PR, true),
        ] {
            let mut memory = SparseMemory::default();
            install_pte(
                &mut memory,
                OFFICIAL_EFFECTIVE,
                segment,
                OFFICIAL_SDR1,
                false,
                0,
                0x0012_3000,
            );
            let regs = registers(msr, OFFICIAL_EFFECTIVE, segment, OFFICIAL_SDR1);
            assert_eq!(
                Mpc750Mmu::new()
                    .translate_instruction(
                        &mut memory,
                        &regs,
                        OFFICIAL_EFFECTIVE,
                        TranslationEffect::Probe,
                    )
                    .is_ok(),
                permitted
            );
        }

        for protection in 1..=3 {
            for msr in [MSR_IR, MSR_IR | MSR_PR] {
                let segment = 0x60ca_701c;
                let mut memory = SparseMemory::default();
                install_pte(
                    &mut memory,
                    OFFICIAL_EFFECTIVE,
                    segment,
                    OFFICIAL_SDR1,
                    false,
                    0,
                    0x0012_3000 | protection,
                );
                let regs = registers(msr, OFFICIAL_EFFECTIVE, segment, OFFICIAL_SDR1);
                assert!(
                    Mpc750Mmu::new()
                        .translate_instruction(
                            &mut memory,
                            &regs,
                            OFFICIAL_EFFECTIVE,
                            TranslationEffect::Probe,
                        )
                        .is_ok(),
                    "PP={protection} MSR={msr:#x}"
                );
            }
        }
    }

    #[test]
    fn probes_are_side_effect_free_while_loads_and_stores_commit_r_c() {
        for (write, expected_history) in [(false, PTE_REFERENCED), (true, 0x0180)] {
            let mut memory = SparseMemory::default();
            let segment = 0x00ca_701c;
            let pte = install_pte(
                &mut memory,
                OFFICIAL_EFFECTIVE,
                segment,
                OFFICIAL_SDR1,
                false,
                0,
                0x0012_3002,
            );
            let regs = registers(MSR_DR, OFFICIAL_EFFECTIVE, segment, OFFICIAL_SDR1);
            let mut mmu = Mpc750Mmu::new();
            memory.writes.clear();
            let probe = mmu
                .translate_data(
                    &mut memory,
                    &regs,
                    OFFICIAL_EFFECTIVE,
                    write,
                    TranslationEffect::Probe,
                )
                .unwrap();
            assert!(!probe.page().unwrap().tlb_hit);
            assert_eq!(memory.read_u32(pte + 4), 0x0012_3002);
            assert!(mmu.resident_data(OFFICIAL_EFFECTIVE, segment).is_none());
            assert!(memory.writes.is_empty());

            let actual = mmu
                .translate_data(
                    &mut memory,
                    &regs,
                    OFFICIAL_EFFECTIVE,
                    write,
                    TranslationEffect::Architectural,
                )
                .unwrap();
            assert_eq!(memory.read_u32(pte + 4), 0x0012_3002 | expected_history);
            assert_eq!(actual.page().unwrap().pte1 & 0x180, expected_history);
            assert!(mmu.resident_data(OFFICIAL_EFFECTIVE, segment).is_some());
        }
    }

    #[test]
    fn data_ranges_preflight_contiguity_and_commit_history_atomically() {
        let segment = 0x00ca_701c;
        let (mut memory, regs, effective, first, second) =
            two_page_setup(Some(0x0012_4002), segment);
        let second = second.unwrap();
        let mut mmu = Mpc750Mmu::new();
        let mapped = mmu
            .translate_data_range(
                &mut memory,
                &regs,
                effective,
                0x30,
                true,
                TranslationEffect::Architectural,
            )
            .unwrap();
        assert_eq!(mapped.physical, 0x0012_3ff0);
        assert_eq!(mapped.segments, 2);
        assert_eq!(mapped.first.page().unwrap().pte1 & 0x180, 0x180);
        assert_eq!(memory.read_u32(first + 4), 0x0012_3182);
        assert_eq!(memory.read_u32(second + 4), 0x0012_4182);

        let (mut memory, regs, effective, first, second) =
            two_page_setup(Some(0x0034_5002), segment);
        let second = second.unwrap();
        let fault = Mpc750Mmu::new()
            .translate_data_range(
                &mut memory,
                &regs,
                effective,
                0x30,
                true,
                TranslationEffect::Architectural,
            )
            .unwrap_err();
        assert!(matches!(
            fault,
            RangeTranslationFault::NonContiguous {
                fault_effective: 0x00ff_b000,
                fault_physical: 0x0034_5000,
                ..
            }
        ));
        assert_eq!(memory.read_u32(first + 4), 0x0012_3002);
        assert_eq!(memory.read_u32(second + 4), 0x0034_5002);
    }

    #[test]
    fn large_range_commits_retained_stale_mapping_without_tlb_replay() {
        const START: u32 = 0x8000_0000;
        const PAGES: u32 = 129;
        const PHYSICAL: u32 = 0x0010_0000;
        let segment = 1;
        let mut regs = registers(MSR_DR, START, segment, 0);
        regs.segments[8] = segment;
        let mut memory = vec![0u8; 0x0200_0000];
        let put_u32 = |memory: &mut [u8], address: u32, value: u32| {
            memory[address as usize..address as usize + 4].copy_from_slice(&value.to_be_bytes());
        };
        let mut final_pte = 0;
        for page in 0..PAGES {
            let effective = START + page * 0x1000;
            let vector = page_table_vector(effective, segment, 0);
            put_u32(&mut memory, vector.primary_pteg, vector.primary_pte0);
            put_u32(
                &mut memory,
                vector.primary_pteg + 4,
                PHYSICAL + page * 0x1000 | 2,
            );
            if page + 1 == PAGES {
                final_pte = vector.primary_pteg;
            }
        }

        let final_effective = START + (PAGES - 1) * 0x1000;
        let mut mmu = Mpc750Mmu::new();
        mmu.translate_data(
            &mut memory,
            &regs,
            final_effective,
            false,
            TranslationEffect::Architectural,
        )
        .unwrap();
        // Hide the final PTE after priming its stale DTLB entry.  Pages 0 and
        // 64 share its set and evict that way while the range is committed.
        put_u32(&mut memory, final_pte, 0);
        let mapped = mmu
            .translate_data_range(
                &mut memory,
                &regs,
                START,
                u64::from(PAGES) * 0x1000,
                false,
                TranslationEffect::Architectural,
            )
            .unwrap();
        assert_eq!((mapped.physical, mapped.segments), (PHYSICAL, PAGES));
        assert_eq!(
            mmu.resident_data(final_effective, segment).unwrap().pte1 & 0xffff_f000,
            PHYSICAL + (PAGES - 1) * 0x1000
        );
    }

    #[test]
    fn range_protection_references_only_denied_page_and_miss_references_none() {
        let protected_segment = 0x40ca_701c;
        let (mut memory, regs, effective, first, second) =
            two_page_setup(Some(0x0012_4001), protected_segment);
        let second = second.unwrap();
        let fault = Mpc750Mmu::new()
            .translate_data_range(
                &mut memory,
                &regs,
                effective,
                0x30,
                true,
                TranslationEffect::Architectural,
            )
            .unwrap_err();
        assert!(matches!(
            fault,
            RangeTranslationFault::Translation {
                fault_effective: 0x00ff_b000,
                fault: TranslationFault::Protection { .. },
                ..
            }
        ));
        assert_eq!(memory.read_u32(first + 4), 0x0012_3002);
        assert_eq!(memory.read_u32(second + 4), 0x0012_4101);

        let (mut memory, regs, effective, first, _) = two_page_setup(None, 0x00ca_701c);
        let fault = Mpc750Mmu::new()
            .translate_data_range(
                &mut memory,
                &regs,
                effective,
                0x30,
                true,
                TranslationEffect::Architectural,
            )
            .unwrap_err();
        assert!(matches!(
            fault,
            RangeTranslationFault::Translation {
                fault_effective: 0x00ff_b000,
                fault: TranslationFault::PageFault { .. },
                ..
            }
        ));
        assert_eq!(memory.read_u32(first + 4), 0x0012_3002);
    }

    #[test]
    fn instruction_ranges_split_pages_require_contiguity_and_probe_cleanly() {
        let segment = 0x00ca_701c;
        let (mut memory, regs, effective, first, second) =
            two_page_setup(Some(0x0034_5002), segment);
        let second = second.unwrap();
        let mut mmu = Mpc750Mmu::new();
        let one_page = mmu
            .translate_instruction_range(
                &mut memory,
                &regs,
                effective,
                0x10,
                TranslationEffect::Probe,
            )
            .unwrap();
        assert_eq!(one_page.physical, 0x0012_3ff0);
        assert!(matches!(
            mmu.translate_instruction_range(
                &mut memory,
                &regs,
                effective,
                0x30,
                TranslationEffect::Probe,
            ),
            Err(RangeTranslationFault::NonContiguous { .. })
        ));
        assert_eq!(memory.read_u32(first + 4) & 0x100, 0);
        assert_eq!(memory.read_u32(second + 4) & 0x100, 0);
        assert!(mmu.resident_instruction(effective, segment).is_none());

        memory.write_u32(second + 4, 0x0012_4002);
        let contiguous = mmu
            .translate_instruction_range(
                &mut memory,
                &regs,
                effective,
                0x30,
                TranslationEffect::Probe,
            )
            .unwrap();
        assert_eq!((contiguous.physical, contiguous.segments), (0x0012_3ff0, 2));
    }

    #[test]
    fn denied_data_access_sets_r_never_c_and_is_retained() {
        let mut memory = SparseMemory::default();
        let segment = 0x4012_3456;
        let pte = install_pte(&mut memory, 0x8001_2000, segment, 0, false, 0, 0x0008_0001);
        let regs = registers(MSR_DR, 0x8001_2000, segment, 0);
        let mut mmu = Mpc750Mmu::new();
        let fault = mmu
            .translate_data(
                &mut memory,
                &regs,
                0x8001_2000,
                true,
                TranslationEffect::Architectural,
            )
            .unwrap_err();
        let TranslationFault::Protection { mapping } = fault else {
            panic!("expected protection");
        };
        assert_eq!(mapping.page().unwrap().pte1 & 0x180, 0x100);
        assert_eq!(memory.read_u32(pte + 4) & 0x180, 0x100);
        assert_eq!(
            mmu.resident_data(0x8001_2000, segment).unwrap().pte1 & 0x180,
            0x100
        );
    }

    #[test]
    fn segment_n_does_not_block_data_and_protected_fetch_still_sets_r() {
        let mut data_memory = SparseMemory::default();
        let data_segment = 0x10ca_701c;
        let data_pte = install_pte(
            &mut data_memory,
            OFFICIAL_EFFECTIVE,
            data_segment,
            OFFICIAL_SDR1,
            false,
            0,
            0x0012_3002,
        );
        let data_regs = registers(MSR_DR, OFFICIAL_EFFECTIVE, data_segment, OFFICIAL_SDR1);
        let data = Mpc750Mmu::new()
            .translate_data(
                &mut data_memory,
                &data_regs,
                OFFICIAL_EFFECTIVE,
                false,
                TranslationEffect::Architectural,
            )
            .unwrap();
        assert_eq!(data.physical, 0x0012_301b);
        assert_eq!(data_memory.read_u32(data_pte + 4), 0x0012_3102);

        let mut instruction_memory = SparseMemory::default();
        let instruction_segment = 0x20ca_701c;
        let instruction_pte = install_pte(
            &mut instruction_memory,
            OFFICIAL_EFFECTIVE,
            instruction_segment,
            OFFICIAL_SDR1,
            false,
            0,
            0x0012_3000,
        );
        let instruction_regs = registers(
            MSR_IR | MSR_PR,
            OFFICIAL_EFFECTIVE,
            instruction_segment,
            OFFICIAL_SDR1,
        );
        let mut mmu = Mpc750Mmu::new();
        let protected = mmu
            .translate_instruction(
                &mut instruction_memory,
                &instruction_regs,
                OFFICIAL_EFFECTIVE,
                TranslationEffect::Architectural,
            )
            .unwrap_err();
        assert!(matches!(protected, TranslationFault::Protection { .. }));
        assert_eq!(
            instruction_memory.read_u32(instruction_pte + 4),
            0x0012_3100
        );
        assert!(
            mmu.resident_instruction(OFFICIAL_EFFECTIVE, instruction_segment)
                .is_some()
        );
    }

    #[test]
    fn instruction_probe_and_fetch_have_exact_r_and_itlb_side_effects() {
        let effective = 0x8001_2000;
        let segment = 0x0012_3456;
        let mut memory = SparseMemory::default();
        let pte = install_pte(&mut memory, effective, segment, 0, false, 0, 0x0008_0002);
        let regs = registers(MSR_IR, effective, segment, 0);
        let mut mmu = Mpc750Mmu::new();
        let probe = mmu
            .translate_instruction(&mut memory, &regs, effective, TranslationEffect::Probe)
            .unwrap();
        assert!(!probe.page().unwrap().tlb_hit);
        assert_eq!(memory.read_u32(pte + 4), 0x0008_0002);
        assert!(mmu.resident_instruction(effective, segment).is_none());

        let fetch = mmu
            .translate_instruction(
                &mut memory,
                &regs,
                effective,
                TranslationEffect::Architectural,
            )
            .unwrap();
        assert_eq!(fetch.page().unwrap().pte1 & 0x180, 0x100);
        assert_eq!(memory.read_u32(pte + 4) & 0x180, 0x100);
        assert_eq!(
            mmu.resident_instruction(effective, segment).unwrap().pte1 & 0x180,
            0x100
        );
        let hit = mmu
            .translate_instruction(
                &mut memory,
                &regs,
                effective,
                TranslationEffect::Architectural,
            )
            .unwrap();
        assert!(hit.page().unwrap().tlb_hit);
    }

    #[test]
    fn two_way_data_tlb_uses_invalid_ways_then_true_lru_and_full_tags() {
        let first = 0x8001_2000;
        let second = first + 0x4_0000;
        let third = second + 0x4_0000;
        let segment = 0x0012_3456;
        let mut memory = SparseMemory::default();
        for (effective, physical) in [
            (first, 0x0008_0002),
            (second, 0x0009_0002),
            (third, 0x000a_0002),
        ] {
            install_pte(&mut memory, effective, segment, 0, false, 0, physical);
        }
        let mut mmu = Mpc750Mmu::new();
        for effective in [first, second] {
            let regs = registers(MSR_DR, effective, segment, 0);
            mmu.translate_data(
                &mut memory,
                &regs,
                effective,
                false,
                TranslationEffect::Architectural,
            )
            .unwrap();
        }
        assert_eq!(mmu.resident_data(first, segment).unwrap().location.way, 0);
        assert_eq!(mmu.resident_data(second, segment).unwrap().location.way, 1);
        // Touch way zero; way one is now least recently used.
        let regs = registers(MSR_DR, first, segment, 0);
        mmu.translate_data(
            &mut memory,
            &regs,
            first,
            false,
            TranslationEffect::Architectural,
        )
        .unwrap();
        let regs = registers(MSR_DR, third, segment, 0);
        mmu.translate_data(
            &mut memory,
            &regs,
            third,
            false,
            TranslationEffect::Architectural,
        )
        .unwrap();
        assert!(mmu.resident_data(first, segment).is_some());
        assert!(mmu.resident_data(second, segment).is_none());
        assert!(mmu.resident_data(third, segment).is_some());
        assert!(mmu.resident_data(first, segment ^ 1).is_none());
        assert!(mmu.resident_data(first + 0x4_0000, segment).is_none());
    }

    #[test]
    fn resident_pte_image_stays_stale_until_tlbie() {
        let effective = 0x8001_2000;
        let segment = 0x0012_3456;
        let mut memory = SparseMemory::default();
        let pte = install_pte(&mut memory, effective, segment, 0, false, 0, 0x0008_0042);
        let regs = registers(MSR_DR, effective, segment, 0);
        let mut mmu = Mpc750Mmu::new();
        let initial = mmu
            .translate_data(
                &mut memory,
                &regs,
                effective,
                false,
                TranslationEffect::Architectural,
            )
            .unwrap();
        assert_eq!(initial.physical, 0x0008_0000);
        let vector = page_table_vector(effective, segment, 0);
        let valid_pte0 = vector.primary_pte0;
        memory.back(vector.secondary_pteg, 64);
        memory.write_u32(pte, valid_pte0 & 0x7fff_ffff);
        memory.write_u32(pte + 4, 0x0009_0073);
        let stale = mmu
            .translate_data(
                &mut memory,
                &regs,
                effective,
                false,
                TranslationEffect::Architectural,
            )
            .unwrap();
        assert_eq!(stale.physical, 0x0008_0000);
        assert_eq!(stale.page().unwrap().protection, 2);
        assert_eq!(stale.page().unwrap().wimg, 8);

        mmu.tlbie(effective);
        assert!(matches!(
            mmu.translate_data(
                &mut memory,
                &regs,
                effective,
                true,
                TranslationEffect::Architectural,
            ),
            Err(TranslationFault::PageFault { .. })
        ));
        memory.write_u32(pte, valid_pte0);
        let fresh = mmu.translate_data(
            &mut memory,
            &regs,
            effective,
            true,
            TranslationEffect::Architectural,
        );
        let TranslationFault::Protection { mapping } = fresh.unwrap_err() else {
            panic!("expected changed PP=3 protection");
        };
        assert_eq!(mapping.physical, 0x0009_0000);
        assert_eq!(mapping.page().unwrap().wimg, 14);
    }

    #[test]
    fn cached_history_preserves_external_pte_edits_and_suppresses_repair() {
        let effective = 0x8001_2000;
        let segment = 0x0012_3456;
        let mut memory = SparseMemory::default();
        let pte = install_pte(&mut memory, effective, segment, 0, false, 0, 0x0008_0002);
        let regs = registers(MSR_DR, effective, segment, 0);
        let mut mmu = Mpc750Mmu::new();
        mmu.translate_data(
            &mut memory,
            &regs,
            effective,
            false,
            TranslationEffect::Architectural,
        )
        .unwrap();
        memory.write_u32(pte + 4, 0x0009_0153);
        mmu.translate_data(
            &mut memory,
            &regs,
            effective,
            true,
            TranslationEffect::Architectural,
        )
        .unwrap();
        assert_eq!(memory.read_u32(pte + 4), 0x0009_01d3);
        assert_eq!(
            mmu.resident_data(effective, segment).unwrap().pte1,
            0x0008_0182
        );

        // Cached R/C now suppress a redundant backing-table write.
        memory.write_u32(pte + 4, 0x0008_0002);
        memory.writes.clear();
        mmu.translate_data(
            &mut memory,
            &regs,
            effective,
            true,
            TranslationEffect::Architectural,
        )
        .unwrap();
        assert_eq!(memory.read_u32(pte + 4), 0x0008_0002);
        assert!(memory.writes.is_empty());
    }

    #[test]
    fn tlbie_clears_both_ways_of_both_tlbs_but_only_one_set() {
        let first = 0x8001_2000;
        let second = first + 0x4_0000;
        let other = first + 0x1000;
        let segment = 0x0012_3456;
        let mut memory = SparseMemory::default();
        for effective in [first, second, other] {
            install_pte(
                &mut memory,
                effective,
                segment,
                0,
                false,
                0,
                0x0010_0002 + (effective & 0x1000),
            );
        }
        let mut mmu = Mpc750Mmu::new();
        for effective in [first, second, other] {
            let regs = registers(MSR_DR | MSR_IR, effective, segment, 0);
            mmu.translate_data(
                &mut memory,
                &regs,
                effective,
                false,
                TranslationEffect::Architectural,
            )
            .unwrap();
            mmu.translate_instruction(
                &mut memory,
                &regs,
                effective,
                TranslationEffect::Architectural,
            )
            .unwrap();
        }
        mmu.tlbsync();
        assert!(mmu.resident_data(first, segment).is_some());
        let invalidated = mmu.tlbie(first);
        assert_eq!(
            invalidated,
            TlbInvalidation {
                set: Mpc750Mmu::tlb_set_index(first),
                instruction_entries: 2,
                data_entries: 2,
            }
        );
        assert!(mmu.resident_data(first, segment).is_none());
        assert!(mmu.resident_data(second, segment).is_none());
        assert!(mmu.resident_instruction(first, segment).is_none());
        assert!(mmu.resident_instruction(second, segment).is_none());
        assert!(mmu.resident_data(other, segment).is_some());
        assert!(mmu.resident_instruction(other, segment).is_some());
    }

    #[test]
    fn page_fault_unbacked_and_storage_causes_remain_distinct() {
        let regs = registers(
            MSR_DR | MSR_IR,
            OFFICIAL_EFFECTIVE,
            OFFICIAL_SEGMENT,
            OFFICIAL_SDR1,
        );
        let mut memory = SparseMemory::default();
        let mut mmu = Mpc750Mmu::new();
        let unbacked = mmu
            .translate_instruction(
                &mut memory,
                &regs,
                OFFICIAL_EFFECTIVE,
                TranslationEffect::Probe,
            )
            .unwrap_err();
        assert!(matches!(
            unbacked,
            TranslationFault::PageTableUnbacked {
                pteg: OFFICIAL_PRIMARY,
                secondary: false,
                ..
            }
        ));
        assert_eq!(unbacked.instruction_storage_cause(), None);

        memory.back(OFFICIAL_PRIMARY, 64);
        memory.back(OFFICIAL_SECONDARY, 64);
        let page = mmu
            .translate_instruction(
                &mut memory,
                &regs,
                OFFICIAL_EFFECTIVE,
                TranslationEffect::Probe,
            )
            .unwrap_err();
        assert!(matches!(page, TranslationFault::PageFault { .. }));
        assert_eq!(page.instruction_storage_cause(), Some(0x4000_0000));

        let data_page = mmu
            .translate_data(
                &mut memory,
                &regs,
                OFFICIAL_EFFECTIVE,
                true,
                TranslationEffect::Probe,
            )
            .unwrap_err();
        assert_eq!(data_page.data_storage_cause(), Some(0x4200_0000));

        let direct_regs = registers(
            MSR_DR,
            OFFICIAL_EFFECTIVE,
            OFFICIAL_SEGMENT | 0x8000_0000,
            OFFICIAL_SDR1,
        );
        let direct = mmu
            .translate_data(
                &mut memory,
                &direct_regs,
                OFFICIAL_EFFECTIVE,
                false,
                TranslationEffect::Probe,
            )
            .unwrap_err();
        assert_eq!(direct.data_storage_cause(), Some(0x0400_0000));
    }
}
