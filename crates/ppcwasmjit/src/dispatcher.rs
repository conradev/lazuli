//! Persistent WebAssembly-side dispatch across dynamically installed basic blocks.
//!
//! This module deliberately owns the dispatch policy in Rust-authored WebAssembly. The browser
//! adapter may compile and instantiate exact Rust-issued bytes, but each module performs its own
//! authorized typed-table installation. Cache lookup, identity validation, budgeting, hook exits,
//! and execution accounting all remain in Wasm.

use std::collections::HashSet;
use std::fmt;
use std::mem::{offset_of, size_of};

use lazuli_abi::{DispatchCacheRecord, DispatchSlotIdentityRecord, memory as shared_memory};
use wasm_encoder::{
    BlockType, CodeSection, ConstExpr, DataSection, EntityType, ExportKind, ExportSection,
    Function, FunctionSection, HeapType, ImportSection, Instruction, MemArg, MemoryType, Module,
    RefType, TableSection, TableType, TypeSection, ValType,
};

use crate::{IMPORT_MODULE, MEMORY_IMPORT};

/// Exported long-running dispatcher entry point.
pub const DISPATCH_RUN_EXPORT: &str = "run";
/// Exported signature-restricted table into which lowered blocks install themselves.
pub const DISPATCH_TABLE_EXPORT: &str = "blocks";
/// Direct function import satisfied by the Rust-authored Lazuli core WebAssembly instance.
pub const DISPATCH_DEPENDENCY_VALIDATOR_IMPORT: &str = "validate_instruction_page_dependency";

/// Size and field offsets of one Rust-owned cache record in imported linear memory.
pub const DISPATCH_CACHE_WAYS: u32 = 4;
pub const DISPATCH_MAX_DEPENDENCIES: u32 = lazuli_abi::DISPATCH_MAX_DEPENDENCIES as u32;
pub const DISPATCH_ENTRY_SIZE: u32 = size_of::<DispatchCacheRecord>() as u32;
pub const DISPATCH_ENTRY_STATE_OFFSET: u32 = offset_of!(DispatchCacheRecord, state) as u32;
pub const DISPATCH_ENTRY_KIND_OFFSET: u32 = offset_of!(DispatchCacheRecord, kind) as u32;
pub const DISPATCH_ENTRY_PC_OFFSET: u32 = offset_of!(DispatchCacheRecord, pc) as u32;
pub const DISPATCH_ENTRY_GENERATION_LO_OFFSET: u32 =
    offset_of!(DispatchCacheRecord, address_space_generation_lo) as u32;
pub const DISPATCH_ENTRY_GENERATION_HI_OFFSET: u32 =
    offset_of!(DispatchCacheRecord, address_space_generation_hi) as u32;
pub const DISPATCH_ENTRY_TABLE_SLOT_OFFSET: u32 =
    offset_of!(DispatchCacheRecord, table_slot) as u32;
pub const DISPATCH_ENTRY_NONCE_LO_OFFSET: u32 =
    offset_of!(DispatchCacheRecord, slot_nonce_lo) as u32;
pub const DISPATCH_ENTRY_NONCE_HI_OFFSET: u32 =
    offset_of!(DispatchCacheRecord, slot_nonce_hi) as u32;
pub const DISPATCH_ENTRY_MAXIMUM_EXECUTED_OFFSET: u32 =
    offset_of!(DispatchCacheRecord, maximum_executed) as u32;
pub const DISPATCH_ENTRY_DEPENDENCY_COUNT_OFFSET: u32 =
    offset_of!(DispatchCacheRecord, dependency_count) as u32;
pub const DISPATCH_ENTRY_DEPENDENCY_0_EFFECTIVE_OFFSET: u32 =
    offset_of!(DispatchCacheRecord, dependencies) as u32
        + offset_of!(lazuli_abi::DispatchDependency, effective_page) as u32;
pub const DISPATCH_ENTRY_DEPENDENCY_0_PHYSICAL_OFFSET: u32 =
    offset_of!(DispatchCacheRecord, dependencies) as u32
        + offset_of!(lazuli_abi::DispatchDependency, physical_page) as u32;
pub const DISPATCH_ENTRY_DEPENDENCY_1_EFFECTIVE_OFFSET: u32 =
    DISPATCH_ENTRY_DEPENDENCY_0_EFFECTIVE_OFFSET
        + size_of::<lazuli_abi::DispatchDependency>() as u32;
pub const DISPATCH_ENTRY_DEPENDENCY_1_PHYSICAL_OFFSET: u32 =
    DISPATCH_ENTRY_DEPENDENCY_0_PHYSICAL_OFFSET
        + size_of::<lazuli_abi::DispatchDependency>() as u32;

const _: () = assert!(
    DISPATCH_ENTRY_SIZE as usize * shared_memory::DISPATCH_ENTRY_CAPACITY
        == shared_memory::DISPATCH_METADATA_BYTES
);

/// Size and field offsets of one Rust-owned table-slot identity record.
pub const DISPATCH_SLOT_IDENTITY_SIZE: u32 = size_of::<DispatchSlotIdentityRecord>() as u32;
pub const DISPATCH_SLOT_STATE_OFFSET: u32 = offset_of!(DispatchSlotIdentityRecord, state) as u32;
pub const DISPATCH_SLOT_PC_OFFSET: u32 = offset_of!(DispatchSlotIdentityRecord, pc) as u32;
pub const DISPATCH_SLOT_GENERATION_LO_OFFSET: u32 =
    offset_of!(DispatchSlotIdentityRecord, address_space_generation_lo) as u32;
pub const DISPATCH_SLOT_GENERATION_HI_OFFSET: u32 =
    offset_of!(DispatchSlotIdentityRecord, address_space_generation_hi) as u32;
pub const DISPATCH_SLOT_NONCE_LO_OFFSET: u32 =
    offset_of!(DispatchSlotIdentityRecord, slot_nonce_lo) as u32;
pub const DISPATCH_SLOT_NONCE_HI_OFFSET: u32 =
    offset_of!(DispatchSlotIdentityRecord, slot_nonce_hi) as u32;

const _: () = assert!(
    DISPATCH_SLOT_IDENTITY_SIZE as usize * shared_memory::DISPATCH_SLOT_CAPACITY
        == shared_memory::DISPATCH_SLOT_IDENTITY_BYTES
);

/// Publication marker written last by the Rust cache owner.
pub const DISPATCH_ENTRY_READY: u32 = lazuli_abi::DISPATCH_ENTRY_READY;
/// Publication marker written last by the Rust table-slot owner.
pub const DISPATCH_SLOT_READY: u32 = lazuli_abi::DISPATCH_SLOT_READY;
/// Raw kind used for `BasicBlock` entries.
pub const DISPATCH_BASIC_BLOCK_KIND: u32 = lazuli_abi::DISPATCH_BASIC_BLOCK_KIND;

/// Why the resident dispatcher returned to its Rust caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum DispatchReason {
    /// The maximum number of blocks was reached.
    BlockBudgetExhausted = 0,
    /// The next block cannot fit within the remaining cycle budget.
    CycleBudgetExhausted = 1,
    /// No published entry exists for the current PC.
    MetadataMiss         = 2,
    /// The current PC exists only under a different address-space generation.
    StaleGeneration      = 3,
    /// An instruction-page dependency count or mapping failed closed.
    DependencyMismatch   = 4,
    /// The table slot was out of range, null, or did not have the exact entry identity.
    TableSlotUnavailable = 5,
    /// A synchronous block hook requested an exit.
    HookExit             = 6,
    /// Rust-owned metadata or a compiled block's accounting violated the contract.
    InvalidState         = 7,
}

/// One retained hashed-page instruction mapping.
pub type DispatcherDependency = lazuli_abi::DispatchDependency;

/// One published compiled-block record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DispatcherEntry {
    pub pc: u32,
    pub address_space_generation: u64,
    pub table_slot: u32,
    pub slot_nonce: u64,
    /// Lower 16 bits are maximum instructions and upper 16 bits are maximum cycles.
    pub maximum_executed: u32,
    /// Number of retained records in `dependencies`, in original translation order.
    pub dependency_count: u32,
    pub dependencies: [DispatcherDependency; DISPATCH_MAX_DEPENDENCIES as usize],
}

impl DispatcherEntry {
    fn encode_into(self, output: &mut [u8]) {
        debug_assert_eq!(output.len(), DISPATCH_ENTRY_SIZE as usize);
        put_u32(
            output,
            DISPATCH_ENTRY_KIND_OFFSET,
            DISPATCH_BASIC_BLOCK_KIND,
        );
        put_u32(output, DISPATCH_ENTRY_PC_OFFSET, self.pc);
        put_u32(
            output,
            DISPATCH_ENTRY_GENERATION_LO_OFFSET,
            self.address_space_generation as u32,
        );
        put_u32(
            output,
            DISPATCH_ENTRY_GENERATION_HI_OFFSET,
            (self.address_space_generation >> 32) as u32,
        );
        put_u32(output, DISPATCH_ENTRY_TABLE_SLOT_OFFSET, self.table_slot);
        put_u32(
            output,
            DISPATCH_ENTRY_NONCE_LO_OFFSET,
            self.slot_nonce as u32,
        );
        put_u32(
            output,
            DISPATCH_ENTRY_NONCE_HI_OFFSET,
            (self.slot_nonce >> 32) as u32,
        );
        put_u32(
            output,
            DISPATCH_ENTRY_MAXIMUM_EXECUTED_OFFSET,
            self.maximum_executed,
        );
        put_u32(
            output,
            DISPATCH_ENTRY_DEPENDENCY_COUNT_OFFSET,
            self.dependency_count,
        );
        put_u32(
            output,
            DISPATCH_ENTRY_DEPENDENCY_0_EFFECTIVE_OFFSET,
            self.dependencies[0].effective_page,
        );
        put_u32(
            output,
            DISPATCH_ENTRY_DEPENDENCY_0_PHYSICAL_OFFSET,
            self.dependencies[0].physical_page,
        );
        put_u32(
            output,
            DISPATCH_ENTRY_DEPENDENCY_1_EFFECTIVE_OFFSET,
            self.dependencies[1].effective_page,
        );
        put_u32(
            output,
            DISPATCH_ENTRY_DEPENDENCY_1_PHYSICAL_OFFSET,
            self.dependencies[1].physical_page,
        );
        // Publish only after every identity and accounting field is present.
        put_u32(output, DISPATCH_ENTRY_STATE_OFFSET, DISPATCH_ENTRY_READY);
    }
}

/// Exact Rust-issued identity of the compiled unit currently occupying one table slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DispatcherSlotIdentity {
    pub table_slot: u32,
    pub pc: u32,
    pub address_space_generation: u64,
    pub slot_nonce: u64,
}

impl DispatcherSlotIdentity {
    fn encode_into(self, output: &mut [u8]) {
        debug_assert_eq!(output.len(), DISPATCH_SLOT_IDENTITY_SIZE as usize);
        put_u32(output, DISPATCH_SLOT_PC_OFFSET, self.pc);
        put_u32(
            output,
            DISPATCH_SLOT_GENERATION_LO_OFFSET,
            self.address_space_generation as u32,
        );
        put_u32(
            output,
            DISPATCH_SLOT_GENERATION_HI_OFFSET,
            (self.address_space_generation >> 32) as u32,
        );
        put_u32(
            output,
            DISPATCH_SLOT_NONCE_LO_OFFSET,
            self.slot_nonce as u32,
        );
        put_u32(
            output,
            DISPATCH_SLOT_NONCE_HI_OFFSET,
            (self.slot_nonce >> 32) as u32,
        );
        // Publish only after the full Rust-issued identity is present.
        put_u32(output, DISPATCH_SLOT_STATE_OFFSET, DISPATCH_SLOT_READY);
    }
}

/// Fixed memory/table placement for one persistent dispatcher module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatcherConfig {
    pub memory_minimum_pages: u64,
    pub memory_maximum_pages: Option<u64>,
    pub metadata_base: u32,
    pub metadata_capacity: u32,
    pub slot_identity_base: u32,
    pub slot_capacity: u32,
    pub table_minimum: u32,
    pub table_maximum: Option<u32>,
    /// Optional initial image authored by Rust. A future browser-machine can instead publish
    /// records into the same reserved ranges at runtime.
    pub initial_entries: Vec<DispatcherEntry>,
    pub initial_slot_identities: Vec<DispatcherSlotIdentity>,
}

impl DispatcherConfig {
    /// Uses the canonical browser-machine ranges reserved by `lazuli-abi`.
    ///
    /// The function table starts with slot zero available and remains growable to the complete
    /// Rust-owned slot directory. Initial cache/table ownership is empty; the Rust cold-compile
    /// coordinator publishes records after one-shot machine initialization.
    #[must_use]
    pub fn production() -> Self {
        Self {
            memory_minimum_pages: shared_memory::RESIDENT_MEMORY_INITIAL_PAGES as u64,
            memory_maximum_pages: Some(shared_memory::RESIDENT_MEMORY_MAXIMUM_PAGES as u64),
            metadata_base: shared_memory::DISPATCH_METADATA_OFFSET as u32,
            metadata_capacity: shared_memory::DISPATCH_ENTRY_CAPACITY as u32,
            slot_identity_base: shared_memory::DISPATCH_SLOT_IDENTITY_OFFSET as u32,
            slot_capacity: shared_memory::DISPATCH_SLOT_CAPACITY as u32,
            table_minimum: 1,
            table_maximum: Some(shared_memory::DISPATCH_SLOT_CAPACITY as u32),
            initial_entries: Vec::new(),
            initial_slot_identities: Vec::new(),
        }
    }
}

/// Invalid dispatcher layout or initial Rust-owned metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatcherError {
    EmptyMetadata,
    InvalidMetadataCapacity,
    EmptySlots,
    MetadataAtNull,
    MisalignedRegion(u32),
    RegionOverflow,
    RegionOverlap,
    RegionOutsideImportedMemory,
    MetadataOutsidePositiveAddressSpace,
    MemoryMinimumExceedsWasm32,
    MemoryMaximumBelowMinimum,
    MemoryMaximumExceedsWasm32,
    TooManyInitialEntries,
    TableMinimumExceedsSlotCapacity,
    TableIsNotGrowable,
    TableMaximumBelowMinimum,
    TableMaximumExceedsSlotCapacity,
    DuplicateEntry { generation: u64, pc: u32 },
    InitialSetOverflow { set: u32 },
    DuplicateSlotIdentity(u32),
    SlotOutsideCapacity(u32),
    EmptyMaximumExecution { pc: u32 },
    TooManyDependencies { pc: u32, count: u32 },
    MisalignedDependency { pc: u32, index: u32 },
}

impl fmt::Display for DispatcherError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyMetadata => formatter.write_str("dispatcher metadata capacity is zero"),
            Self::InvalidMetadataCapacity => formatter.write_str(
                "dispatcher metadata must contain four ways in a power-of-two number of sets",
            ),
            Self::EmptySlots => formatter.write_str("dispatcher slot capacity is zero"),
            Self::MetadataAtNull => {
                formatter.write_str("dispatcher metadata may not start at null")
            }
            Self::MisalignedRegion(address) => {
                write!(
                    formatter,
                    "dispatcher region 0x{address:08x} is not word aligned"
                )
            }
            Self::RegionOverflow => {
                formatter.write_str("dispatcher memory region overflows wasm32")
            }
            Self::RegionOverlap => {
                formatter.write_str("dispatcher metadata and slot regions overlap")
            }
            Self::RegionOutsideImportedMemory => {
                formatter.write_str("dispatcher region exceeds the imported memory minimum")
            }
            Self::MetadataOutsidePositiveAddressSpace => formatter.write_str(
                "dispatcher metadata conflicts with the lookup helper's negative sentinels",
            ),
            Self::MemoryMinimumExceedsWasm32 => {
                formatter.write_str("dispatcher imported memory minimum exceeds wasm32")
            }
            Self::MemoryMaximumBelowMinimum => {
                formatter.write_str("dispatcher imported memory maximum is below its minimum")
            }
            Self::MemoryMaximumExceedsWasm32 => {
                formatter.write_str("dispatcher imported memory maximum exceeds wasm32")
            }
            Self::TooManyInitialEntries => {
                formatter.write_str("initial entries exceed dispatcher metadata capacity")
            }
            Self::TableMinimumExceedsSlotCapacity => {
                formatter.write_str("table minimum exceeds Rust slot-identity capacity")
            }
            Self::TableIsNotGrowable => formatter.write_str("dispatcher table must be growable"),
            Self::TableMaximumBelowMinimum => {
                formatter.write_str("dispatcher table maximum is below its minimum")
            }
            Self::TableMaximumExceedsSlotCapacity => {
                formatter.write_str("table maximum exceeds Rust slot-identity capacity")
            }
            Self::DuplicateEntry { generation, pc } => write!(
                formatter,
                "duplicate dispatcher entry for generation {generation} PC 0x{pc:08x}"
            ),
            Self::InitialSetOverflow { set } => {
                write!(
                    formatter,
                    "too many initial dispatcher entries map to set {set}"
                )
            }
            Self::DuplicateSlotIdentity(slot) => {
                write!(
                    formatter,
                    "duplicate dispatcher identity for table slot {slot}"
                )
            }
            Self::SlotOutsideCapacity(slot) => {
                write!(
                    formatter,
                    "dispatcher table slot {slot} is outside capacity"
                )
            }
            Self::EmptyMaximumExecution { pc } => {
                write!(
                    formatter,
                    "dispatcher entry 0x{pc:08x} has empty execution bounds"
                )
            }
            Self::TooManyDependencies { pc, count } => write!(
                formatter,
                "dispatcher entry 0x{pc:08x} has unsupported dependency count {count}"
            ),
            Self::MisalignedDependency { pc, index } => write!(
                formatter,
                "dispatcher entry 0x{pc:08x} dependency {index} is not 4 KiB aligned"
            ),
        }
    }
}

impl std::error::Error for DispatcherError {}

fn put_u32(output: &mut [u8], offset: u32, value: u32) {
    output[offset as usize..offset as usize + 4].copy_from_slice(&value.to_le_bytes());
}

fn region_end(base: u32, count: u32, stride: u32) -> Result<u64, DispatcherError> {
    let size = u64::from(count)
        .checked_mul(u64::from(stride))
        .ok_or(DispatcherError::RegionOverflow)?;
    let end = u64::from(base)
        .checked_add(size)
        .ok_or(DispatcherError::RegionOverflow)?;
    if end > u64::from(u32::MAX) + 1 {
        return Err(DispatcherError::RegionOverflow);
    }
    Ok(end)
}

/// Returns the set selected by the same generation/PC hash as `lazuli::runtime::CodeCache`.
///
/// The helper returns `None` for a shape the resident dispatcher cannot consume.
#[must_use]
pub fn resident_dispatcher_set_index(
    metadata_capacity: u32,
    address_space_generation: u64,
    pc: u32,
) -> Option<u32> {
    if metadata_capacity == 0 || !metadata_capacity.is_multiple_of(DISPATCH_CACHE_WAYS) {
        return None;
    }
    let set_count = metadata_capacity / DISPATCH_CACHE_WAYS;
    if !set_count.is_power_of_two() {
        return None;
    }
    let folded_generation =
        address_space_generation as u32 ^ (address_space_generation >> 32) as u32;
    let mixed = (pc >> 2) ^ folded_generation.wrapping_mul(0x9e37_79b9);
    Some(mixed & (set_count - 1))
}

fn memarg(offset: u32) -> MemArg {
    MemArg {
        offset: u64::from(offset),
        align: 2,
        memory_index: 0,
    }
}

fn emit_i32_load(body: &mut Function, pointer_local: u32, offset: u32) {
    body.instruction(&Instruction::LocalGet(pointer_local));
    body.instruction(&Instruction::I32Load(memarg(offset)));
}

fn emit_return(
    body: &mut Function,
    instructions: u32,
    cycles: u32,
    blocks: u32,
    reason: DispatchReason,
) {
    body.instruction(&Instruction::LocalGet(instructions));
    body.instruction(&Instruction::LocalGet(cycles));
    body.instruction(&Instruction::LocalGet(blocks));
    body.instruction(&Instruction::I32Const(reason as i32));
    body.instruction(&Instruction::Return);
}

/// Generates a persistent imported-memory dispatcher and its exported growable function table.
///
/// `run` has the following signature:
///
/// ```text
/// run(ctx: i32, cpu: i32, fastmem: i32, pc_offset: i32, control: i32,
///     generation_lo: i32, generation_hi: i32, cycle_budget: i64, block_budget: i32)
///     -> (instructions: i64, cycles: i64, blocks: i32, reason: i32)
/// ```
///
/// The control record retains the existing three-word convention: total cycle prefix at +0,
/// hook-exit flag at +4, and current instruction's cycle offset at +8.
pub fn build_resident_dispatcher(config: &DispatcherConfig) -> Result<Vec<u8>, DispatcherError> {
    if config.memory_minimum_pages > 65_536 {
        return Err(DispatcherError::MemoryMinimumExceedsWasm32);
    }
    if config
        .memory_maximum_pages
        .is_some_and(|maximum| maximum < config.memory_minimum_pages)
    {
        return Err(DispatcherError::MemoryMaximumBelowMinimum);
    }
    if config
        .memory_maximum_pages
        .is_some_and(|maximum| maximum > 65_536)
    {
        return Err(DispatcherError::MemoryMaximumExceedsWasm32);
    }
    if config.metadata_capacity == 0 {
        return Err(DispatcherError::EmptyMetadata);
    }
    if resident_dispatcher_set_index(config.metadata_capacity, 0, 0).is_none() {
        return Err(DispatcherError::InvalidMetadataCapacity);
    }
    if config.slot_capacity == 0 {
        return Err(DispatcherError::EmptySlots);
    }
    if config.metadata_base == 0 || config.slot_identity_base == 0 {
        return Err(DispatcherError::MetadataAtNull);
    }
    for address in [config.metadata_base, config.slot_identity_base] {
        if address % 4 != 0 {
            return Err(DispatcherError::MisalignedRegion(address));
        }
    }
    if config.initial_entries.len() > config.metadata_capacity as usize {
        return Err(DispatcherError::TooManyInitialEntries);
    }
    if config.table_minimum > config.slot_capacity {
        return Err(DispatcherError::TableMinimumExceedsSlotCapacity);
    }
    if config.table_maximum == Some(config.table_minimum) {
        return Err(DispatcherError::TableIsNotGrowable);
    }
    if config
        .table_maximum
        .is_some_and(|maximum| maximum < config.table_minimum)
    {
        return Err(DispatcherError::TableMaximumBelowMinimum);
    }
    if config
        .table_maximum
        .is_some_and(|maximum| maximum > config.slot_capacity)
    {
        return Err(DispatcherError::TableMaximumExceedsSlotCapacity);
    }

    let metadata_end = region_end(
        config.metadata_base,
        config.metadata_capacity,
        DISPATCH_ENTRY_SIZE,
    )?;
    let slots_end = region_end(
        config.slot_identity_base,
        config.slot_capacity,
        DISPATCH_SLOT_IDENTITY_SIZE,
    )?;
    let metadata_start = u64::from(config.metadata_base);
    let slots_start = u64::from(config.slot_identity_base);
    // The lookup helper returns negative i32 values as fail-closed sentinels.
    if metadata_end > 0x8000_0000 {
        return Err(DispatcherError::MetadataOutsidePositiveAddressSpace);
    }
    if metadata_start < slots_end && slots_start < metadata_end {
        return Err(DispatcherError::RegionOverlap);
    }
    let imported_bytes = config
        .memory_minimum_pages
        .checked_mul(65_536)
        .ok_or(DispatcherError::RegionOverflow)?;
    if metadata_end > imported_bytes || slots_end > imported_bytes {
        return Err(DispatcherError::RegionOutsideImportedMemory);
    }

    let mut entry_keys = HashSet::with_capacity(config.initial_entries.len());
    let set_count = config.metadata_capacity / DISPATCH_CACHE_WAYS;
    let mut occupied_ways = vec![0u8; set_count as usize];
    let mut initial_entry_positions = Vec::with_capacity(config.initial_entries.len());
    for entry in &config.initial_entries {
        if !entry_keys.insert((entry.address_space_generation, entry.pc)) {
            return Err(DispatcherError::DuplicateEntry {
                generation: entry.address_space_generation,
                pc: entry.pc,
            });
        }
        if entry.table_slot >= config.slot_capacity {
            return Err(DispatcherError::SlotOutsideCapacity(entry.table_slot));
        }
        let instructions = entry.maximum_executed & 0xffff;
        let cycles = entry.maximum_executed >> 16;
        if instructions == 0 || cycles == 0 {
            return Err(DispatcherError::EmptyMaximumExecution { pc: entry.pc });
        }
        if entry.dependency_count > DISPATCH_MAX_DEPENDENCIES {
            return Err(DispatcherError::TooManyDependencies {
                pc: entry.pc,
                count: entry.dependency_count,
            });
        }
        for (index, dependency) in entry.dependencies[..entry.dependency_count as usize]
            .iter()
            .enumerate()
        {
            if !dependency.effective_page.is_multiple_of(4096)
                || !dependency.physical_page.is_multiple_of(4096)
            {
                return Err(DispatcherError::MisalignedDependency {
                    pc: entry.pc,
                    index: index as u32,
                });
            }
        }
        let set = resident_dispatcher_set_index(
            config.metadata_capacity,
            entry.address_space_generation,
            entry.pc,
        )
        .expect("metadata shape was checked above");
        let way = occupied_ways[set as usize];
        if u32::from(way) >= DISPATCH_CACHE_WAYS {
            return Err(DispatcherError::InitialSetOverflow { set });
        }
        occupied_ways[set as usize] += 1;
        initial_entry_positions.push((set * DISPATCH_CACHE_WAYS + u32::from(way), *entry));
    }
    let mut identity_slots = HashSet::with_capacity(config.initial_slot_identities.len());
    for identity in &config.initial_slot_identities {
        if identity.table_slot >= config.slot_capacity {
            return Err(DispatcherError::SlotOutsideCapacity(identity.table_slot));
        }
        if !identity_slots.insert(identity.table_slot) {
            return Err(DispatcherError::DuplicateSlotIdentity(identity.table_slot));
        }
    }

    let mut types = TypeSection::new();
    // Type 0: lowered PPC block: (ctx, cpu, fastmem) -> packed execution.
    types
        .ty()
        .function([ValType::I32, ValType::I32, ValType::I32], [ValType::I32]);
    // Type 1: direct Rust/Wasm MMU dependency validation.
    types
        .ty()
        .function([ValType::I32, ValType::I32], [ValType::I32]);
    // Type 2: metadata lookup helper.
    types
        .ty()
        .function([ValType::I32, ValType::I32, ValType::I32], [ValType::I32]);
    // Type 3: persistent dispatcher.
    types.ty().function(
        [
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I64,
            ValType::I32,
        ],
        [ValType::I64, ValType::I64, ValType::I32, ValType::I32],
    );

    let mut imports = ImportSection::new();
    imports.import(
        IMPORT_MODULE,
        MEMORY_IMPORT,
        EntityType::Memory(MemoryType {
            minimum: config.memory_minimum_pages,
            maximum: config.memory_maximum_pages,
            memory64: false,
            shared: false,
            page_size_log2: None,
        }),
    );
    imports.import(
        IMPORT_MODULE,
        DISPATCH_DEPENDENCY_VALIDATOR_IMPORT,
        EntityType::Function(1),
    );

    let mut functions = FunctionSection::new();
    functions.function(2);
    functions.function(3);

    let mut tables = TableSection::new();
    tables.table(TableType {
        // A mutable table cannot be imported at a broader element type by an adversarial module.
        // Only `(i32, i32, i32) -> i32` references can ever become occupants.
        element_type: RefType {
            nullable: true,
            heap_type: HeapType::Concrete(0),
        },
        table64: false,
        minimum: u64::from(config.table_minimum),
        maximum: config.table_maximum.map(u64::from),
        shared: false,
    });

    let mut exports = ExportSection::new();
    exports.export(DISPATCH_RUN_EXPORT, ExportKind::Func, 2);
    exports.export(DISPATCH_TABLE_EXPORT, ExportKind::Table, 0);

    // lookup(pc, generation_lo, generation_hi) -> entry pointer, or:
    // 0 = miss, -1 = stale generation, -3 = invalid metadata.
    const LOOKUP_INDEX: u32 = 3;
    const LOOKUP_ENTRY: u32 = 4;
    const LOOKUP_END: u32 = 5;
    let mut lookup = Function::new([(3, ValType::I32)]);

    // Match `lazuli::runtime::CodeCache::set_index`, then inspect exactly four ways on the hot
    // path. A full scan occurs only after a miss so callers can distinguish stale generations.
    lookup.instruction(&Instruction::LocalGet(0));
    lookup.instruction(&Instruction::I32Const(2));
    lookup.instruction(&Instruction::I32ShrU);
    lookup.instruction(&Instruction::LocalGet(1));
    lookup.instruction(&Instruction::LocalGet(2));
    lookup.instruction(&Instruction::I32Xor);
    lookup.instruction(&Instruction::I32Const(0x9e37_79b9u32 as i32));
    lookup.instruction(&Instruction::I32Mul);
    lookup.instruction(&Instruction::I32Xor);
    lookup.instruction(&Instruction::I32Const((set_count - 1) as i32));
    lookup.instruction(&Instruction::I32And);
    lookup.instruction(&Instruction::I32Const(DISPATCH_CACHE_WAYS as i32));
    lookup.instruction(&Instruction::I32Mul);
    lookup.instruction(&Instruction::LocalTee(LOOKUP_INDEX));
    lookup.instruction(&Instruction::I32Const(DISPATCH_CACHE_WAYS as i32));
    lookup.instruction(&Instruction::I32Add);
    lookup.instruction(&Instruction::LocalSet(LOOKUP_END));

    lookup.instruction(&Instruction::Block(BlockType::Empty));
    lookup.instruction(&Instruction::Loop(BlockType::Empty));
    lookup.instruction(&Instruction::LocalGet(LOOKUP_INDEX));
    lookup.instruction(&Instruction::LocalGet(LOOKUP_END));
    lookup.instruction(&Instruction::I32GeU);
    lookup.instruction(&Instruction::BrIf(1));

    lookup.instruction(&Instruction::I32Const(config.metadata_base as i32));
    lookup.instruction(&Instruction::LocalGet(LOOKUP_INDEX));
    lookup.instruction(&Instruction::I32Const(DISPATCH_ENTRY_SIZE as i32));
    lookup.instruction(&Instruction::I32Mul);
    lookup.instruction(&Instruction::I32Add);
    lookup.instruction(&Instruction::LocalSet(LOOKUP_ENTRY));

    emit_i32_load(&mut lookup, LOOKUP_ENTRY, DISPATCH_ENTRY_STATE_OFFSET);
    lookup.instruction(&Instruction::I32Const(DISPATCH_ENTRY_READY as i32));
    lookup.instruction(&Instruction::I32Eq);
    lookup.instruction(&Instruction::If(BlockType::Empty));
    emit_i32_load(&mut lookup, LOOKUP_ENTRY, DISPATCH_ENTRY_PC_OFFSET);
    lookup.instruction(&Instruction::LocalGet(0));
    lookup.instruction(&Instruction::I32Eq);
    lookup.instruction(&Instruction::If(BlockType::Empty));

    emit_i32_load(
        &mut lookup,
        LOOKUP_ENTRY,
        DISPATCH_ENTRY_GENERATION_LO_OFFSET,
    );
    lookup.instruction(&Instruction::LocalGet(1));
    lookup.instruction(&Instruction::I32Eq);
    emit_i32_load(
        &mut lookup,
        LOOKUP_ENTRY,
        DISPATCH_ENTRY_GENERATION_HI_OFFSET,
    );
    lookup.instruction(&Instruction::LocalGet(2));
    lookup.instruction(&Instruction::I32Eq);
    lookup.instruction(&Instruction::I32And);
    lookup.instruction(&Instruction::If(BlockType::Empty));

    emit_i32_load(&mut lookup, LOOKUP_ENTRY, DISPATCH_ENTRY_KIND_OFFSET);
    lookup.instruction(&Instruction::I32Const(DISPATCH_BASIC_BLOCK_KIND as i32));
    lookup.instruction(&Instruction::I32Ne);
    lookup.instruction(&Instruction::If(BlockType::Empty));
    lookup.instruction(&Instruction::I32Const(-3));
    lookup.instruction(&Instruction::Return);
    lookup.instruction(&Instruction::End);

    lookup.instruction(&Instruction::LocalGet(LOOKUP_ENTRY));
    lookup.instruction(&Instruction::Return);
    lookup.instruction(&Instruction::End);
    lookup.instruction(&Instruction::End);
    lookup.instruction(&Instruction::End);

    lookup.instruction(&Instruction::LocalGet(LOOKUP_INDEX));
    lookup.instruction(&Instruction::I32Const(1));
    lookup.instruction(&Instruction::I32Add);
    lookup.instruction(&Instruction::LocalSet(LOOKUP_INDEX));
    lookup.instruction(&Instruction::Br(0));
    lookup.instruction(&Instruction::End);
    lookup.instruction(&Instruction::End);

    // Cold miss path: diagnose a published entry for this PC under any other generation. This
    // scan never authorizes execution and therefore does not weaken the four-way exact lookup.
    lookup.instruction(&Instruction::I32Const(0));
    lookup.instruction(&Instruction::LocalSet(LOOKUP_INDEX));
    lookup.instruction(&Instruction::Loop(BlockType::Empty));
    lookup.instruction(&Instruction::LocalGet(LOOKUP_INDEX));
    lookup.instruction(&Instruction::I32Const(config.metadata_capacity as i32));
    lookup.instruction(&Instruction::I32GeU);
    lookup.instruction(&Instruction::If(BlockType::Empty));
    lookup.instruction(&Instruction::I32Const(0));
    lookup.instruction(&Instruction::Return);
    lookup.instruction(&Instruction::End);

    lookup.instruction(&Instruction::I32Const(config.metadata_base as i32));
    lookup.instruction(&Instruction::LocalGet(LOOKUP_INDEX));
    lookup.instruction(&Instruction::I32Const(DISPATCH_ENTRY_SIZE as i32));
    lookup.instruction(&Instruction::I32Mul);
    lookup.instruction(&Instruction::I32Add);
    lookup.instruction(&Instruction::LocalSet(LOOKUP_ENTRY));
    emit_i32_load(&mut lookup, LOOKUP_ENTRY, DISPATCH_ENTRY_STATE_OFFSET);
    lookup.instruction(&Instruction::I32Const(DISPATCH_ENTRY_READY as i32));
    lookup.instruction(&Instruction::I32Eq);
    emit_i32_load(&mut lookup, LOOKUP_ENTRY, DISPATCH_ENTRY_PC_OFFSET);
    lookup.instruction(&Instruction::LocalGet(0));
    lookup.instruction(&Instruction::I32Eq);
    lookup.instruction(&Instruction::I32And);
    lookup.instruction(&Instruction::If(BlockType::Empty));
    lookup.instruction(&Instruction::I32Const(-1));
    lookup.instruction(&Instruction::Return);
    lookup.instruction(&Instruction::End);
    lookup.instruction(&Instruction::LocalGet(LOOKUP_INDEX));
    lookup.instruction(&Instruction::I32Const(1));
    lookup.instruction(&Instruction::I32Add);
    lookup.instruction(&Instruction::LocalSet(LOOKUP_INDEX));
    lookup.instruction(&Instruction::Br(0));
    lookup.instruction(&Instruction::End);
    lookup.instruction(&Instruction::Unreachable);
    lookup.instruction(&Instruction::End);

    // Parameters 0..=8: ctx, cpu, fastmem, pc_offset, control, generation low/high,
    // cycle budget, block budget. Locals 9..=10 are i64 instruction/cycle totals and locals
    // 11..=20 are block count, PC, entry pointer, maximum packed execution, slot, slot identity
    // pointer, actual packed execution/cycles/instructions, and dependency count.
    const TOTAL_INSTRUCTIONS: u32 = 9;
    const TOTAL_CYCLES: u32 = 10;
    const BLOCKS: u32 = 11;
    const PC: u32 = 12;
    const ENTRY: u32 = 13;
    const MAXIMUM: u32 = 14;
    const SLOT: u32 = 15;
    const SLOT_IDENTITY: u32 = 16;
    const ACTUAL: u32 = 17;
    const ACTUAL_CYCLES: u32 = 18;
    const ACTUAL_INSTRUCTIONS: u32 = 19;
    const DEPENDENCY_COUNT: u32 = 20;
    let mut run = Function::new([(2, ValType::I64), (10, ValType::I32)]);
    run.instruction(&Instruction::Loop(BlockType::Empty));

    // Honor an exit requested before entry or by the immediately preceding block hook.
    run.instruction(&Instruction::LocalGet(4));
    run.instruction(&Instruction::I32Load(memarg(4)));
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::HookExit,
    );
    run.instruction(&Instruction::End);

    run.instruction(&Instruction::LocalGet(BLOCKS));
    run.instruction(&Instruction::LocalGet(8));
    run.instruction(&Instruction::I32GeU);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::BlockBudgetExhausted,
    );
    run.instruction(&Instruction::End);

    run.instruction(&Instruction::LocalGet(1));
    run.instruction(&Instruction::LocalGet(3));
    run.instruction(&Instruction::I32Add);
    run.instruction(&Instruction::I32Load(memarg(0)));
    run.instruction(&Instruction::LocalSet(PC));
    run.instruction(&Instruction::LocalGet(PC));
    run.instruction(&Instruction::LocalGet(5));
    run.instruction(&Instruction::LocalGet(6));
    run.instruction(&Instruction::Call(1));
    run.instruction(&Instruction::LocalSet(ENTRY));

    run.instruction(&Instruction::LocalGet(ENTRY));
    run.instruction(&Instruction::I32Eqz);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::MetadataMiss,
    );
    run.instruction(&Instruction::End);
    run.instruction(&Instruction::LocalGet(ENTRY));
    run.instruction(&Instruction::I32Const(-1));
    run.instruction(&Instruction::I32Eq);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::StaleGeneration,
    );
    run.instruction(&Instruction::End);
    run.instruction(&Instruction::LocalGet(ENTRY));
    run.instruction(&Instruction::I32Const(0));
    run.instruction(&Instruction::I32LtS);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::InvalidState,
    );
    run.instruction(&Instruction::End);

    // Retained hashed-page mappings are checked directly by the Rust-authored core Wasm export
    // before every compiled-block call. Counts outside the ABI and malformed page records fail
    // before invoking the validator. The two calls are deliberately emitted in retained order.
    emit_i32_load(&mut run, ENTRY, DISPATCH_ENTRY_DEPENDENCY_COUNT_OFFSET);
    run.instruction(&Instruction::LocalTee(DEPENDENCY_COUNT));
    run.instruction(&Instruction::I32Const(DISPATCH_MAX_DEPENDENCIES as i32));
    run.instruction(&Instruction::I32GtU);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::DependencyMismatch,
    );
    run.instruction(&Instruction::End);

    run.instruction(&Instruction::LocalGet(DEPENDENCY_COUNT));
    run.instruction(&Instruction::I32Const(1));
    run.instruction(&Instruction::I32GeU);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_i32_load(
        &mut run,
        ENTRY,
        DISPATCH_ENTRY_DEPENDENCY_0_EFFECTIVE_OFFSET,
    );
    run.instruction(&Instruction::I32Const(0xfff));
    run.instruction(&Instruction::I32And);
    emit_i32_load(&mut run, ENTRY, DISPATCH_ENTRY_DEPENDENCY_0_PHYSICAL_OFFSET);
    run.instruction(&Instruction::I32Const(0xfff));
    run.instruction(&Instruction::I32And);
    run.instruction(&Instruction::I32Or);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::DependencyMismatch,
    );
    run.instruction(&Instruction::End);
    emit_i32_load(
        &mut run,
        ENTRY,
        DISPATCH_ENTRY_DEPENDENCY_0_EFFECTIVE_OFFSET,
    );
    emit_i32_load(&mut run, ENTRY, DISPATCH_ENTRY_DEPENDENCY_0_PHYSICAL_OFFSET);
    run.instruction(&Instruction::Call(0));
    run.instruction(&Instruction::I32Eqz);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::DependencyMismatch,
    );
    run.instruction(&Instruction::End);
    run.instruction(&Instruction::End);

    run.instruction(&Instruction::LocalGet(DEPENDENCY_COUNT));
    run.instruction(&Instruction::I32Const(2));
    run.instruction(&Instruction::I32GeU);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_i32_load(
        &mut run,
        ENTRY,
        DISPATCH_ENTRY_DEPENDENCY_1_EFFECTIVE_OFFSET,
    );
    run.instruction(&Instruction::I32Const(0xfff));
    run.instruction(&Instruction::I32And);
    emit_i32_load(&mut run, ENTRY, DISPATCH_ENTRY_DEPENDENCY_1_PHYSICAL_OFFSET);
    run.instruction(&Instruction::I32Const(0xfff));
    run.instruction(&Instruction::I32And);
    run.instruction(&Instruction::I32Or);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::DependencyMismatch,
    );
    run.instruction(&Instruction::End);
    emit_i32_load(
        &mut run,
        ENTRY,
        DISPATCH_ENTRY_DEPENDENCY_1_EFFECTIVE_OFFSET,
    );
    emit_i32_load(&mut run, ENTRY, DISPATCH_ENTRY_DEPENDENCY_1_PHYSICAL_OFFSET);
    run.instruction(&Instruction::Call(0));
    run.instruction(&Instruction::I32Eqz);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::DependencyMismatch,
    );
    run.instruction(&Instruction::End);
    run.instruction(&Instruction::End);

    emit_i32_load(&mut run, ENTRY, DISPATCH_ENTRY_MAXIMUM_EXECUTED_OFFSET);
    run.instruction(&Instruction::LocalTee(MAXIMUM));
    run.instruction(&Instruction::I32Const(0xffff));
    run.instruction(&Instruction::I32And);
    run.instruction(&Instruction::I32Eqz);
    run.instruction(&Instruction::LocalGet(MAXIMUM));
    run.instruction(&Instruction::I32Const(16));
    run.instruction(&Instruction::I32ShrU);
    run.instruction(&Instruction::I32Eqz);
    run.instruction(&Instruction::I32Or);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::InvalidState,
    );
    run.instruction(&Instruction::End);

    // Preflight against the declared maximum cost so one block never overshoots the slice.
    run.instruction(&Instruction::LocalGet(TOTAL_CYCLES));
    run.instruction(&Instruction::LocalGet(7));
    run.instruction(&Instruction::I64GtU);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::InvalidState,
    );
    run.instruction(&Instruction::End);
    run.instruction(&Instruction::LocalGet(MAXIMUM));
    run.instruction(&Instruction::I32Const(16));
    run.instruction(&Instruction::I32ShrU);
    run.instruction(&Instruction::I64ExtendI32U);
    run.instruction(&Instruction::LocalGet(7));
    run.instruction(&Instruction::LocalGet(TOTAL_CYCLES));
    run.instruction(&Instruction::I64Sub);
    run.instruction(&Instruction::I64GtU);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::CycleBudgetExhausted,
    );
    run.instruction(&Instruction::End);

    emit_i32_load(&mut run, ENTRY, DISPATCH_ENTRY_TABLE_SLOT_OFFSET);
    run.instruction(&Instruction::LocalTee(SLOT));
    run.instruction(&Instruction::I32Const(config.slot_capacity as i32));
    run.instruction(&Instruction::I32GeU);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::TableSlotUnavailable,
    );
    run.instruction(&Instruction::End);

    run.instruction(&Instruction::I32Const(config.slot_identity_base as i32));
    run.instruction(&Instruction::LocalGet(SLOT));
    run.instruction(&Instruction::I32Const(DISPATCH_SLOT_IDENTITY_SIZE as i32));
    run.instruction(&Instruction::I32Mul);
    run.instruction(&Instruction::I32Add);
    run.instruction(&Instruction::LocalSet(SLOT_IDENTITY));

    // Every slot-directory field must exactly match the selected entry. This rejects a valid
    // function in the wrong slot just as firmly as an empty or out-of-range table element.
    emit_i32_load(&mut run, SLOT_IDENTITY, DISPATCH_SLOT_STATE_OFFSET);
    run.instruction(&Instruction::I32Const(DISPATCH_SLOT_READY as i32));
    run.instruction(&Instruction::I32Eq);
    emit_i32_load(&mut run, SLOT_IDENTITY, DISPATCH_SLOT_PC_OFFSET);
    run.instruction(&Instruction::LocalGet(PC));
    run.instruction(&Instruction::I32Eq);
    run.instruction(&Instruction::I32And);
    emit_i32_load(&mut run, SLOT_IDENTITY, DISPATCH_SLOT_GENERATION_LO_OFFSET);
    run.instruction(&Instruction::LocalGet(5));
    run.instruction(&Instruction::I32Eq);
    run.instruction(&Instruction::I32And);
    emit_i32_load(&mut run, SLOT_IDENTITY, DISPATCH_SLOT_GENERATION_HI_OFFSET);
    run.instruction(&Instruction::LocalGet(6));
    run.instruction(&Instruction::I32Eq);
    run.instruction(&Instruction::I32And);
    emit_i32_load(&mut run, SLOT_IDENTITY, DISPATCH_SLOT_NONCE_LO_OFFSET);
    emit_i32_load(&mut run, ENTRY, DISPATCH_ENTRY_NONCE_LO_OFFSET);
    run.instruction(&Instruction::I32Eq);
    run.instruction(&Instruction::I32And);
    emit_i32_load(&mut run, SLOT_IDENTITY, DISPATCH_SLOT_NONCE_HI_OFFSET);
    emit_i32_load(&mut run, ENTRY, DISPATCH_ENTRY_NONCE_HI_OFFSET);
    run.instruction(&Instruction::I32Eq);
    run.instruction(&Instruction::I32And);
    run.instruction(&Instruction::I32Eqz);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::TableSlotUnavailable,
    );
    run.instruction(&Instruction::End);

    run.instruction(&Instruction::LocalGet(SLOT));
    run.instruction(&Instruction::TableSize(0));
    run.instruction(&Instruction::I32GeU);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::TableSlotUnavailable,
    );
    run.instruction(&Instruction::End);
    run.instruction(&Instruction::LocalGet(SLOT));
    run.instruction(&Instruction::TableGet(0));
    run.instruction(&Instruction::RefIsNull);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::TableSlotUnavailable,
    );
    run.instruction(&Instruction::End);

    run.instruction(&Instruction::LocalGet(4));
    run.instruction(&Instruction::LocalGet(TOTAL_CYCLES));
    run.instruction(&Instruction::I32WrapI64);
    run.instruction(&Instruction::I32Store(memarg(0)));
    run.instruction(&Instruction::LocalGet(4));
    run.instruction(&Instruction::I32Const(0));
    run.instruction(&Instruction::I32Store(memarg(8)));

    run.instruction(&Instruction::LocalGet(0));
    run.instruction(&Instruction::LocalGet(1));
    run.instruction(&Instruction::LocalGet(2));
    run.instruction(&Instruction::LocalGet(SLOT));
    run.instruction(&Instruction::CallIndirect {
        type_index: 0,
        table_index: 0,
    });
    run.instruction(&Instruction::LocalTee(ACTUAL));
    run.instruction(&Instruction::I32Const(16));
    run.instruction(&Instruction::I32ShrU);
    run.instruction(&Instruction::LocalSet(ACTUAL_CYCLES));
    run.instruction(&Instruction::LocalGet(ACTUAL));
    run.instruction(&Instruction::I32Const(0xffff));
    run.instruction(&Instruction::I32And);
    run.instruction(&Instruction::LocalSet(ACTUAL_INSTRUCTIONS));

    // A module installed under the wrong metadata cannot silently claim more work than Rust
    // preflighted. Return invalid-state after the call; machine state remains Rust-owned.
    run.instruction(&Instruction::LocalGet(ACTUAL_CYCLES));
    run.instruction(&Instruction::LocalGet(MAXIMUM));
    run.instruction(&Instruction::I32Const(16));
    run.instruction(&Instruction::I32ShrU);
    run.instruction(&Instruction::I32GtU);
    run.instruction(&Instruction::LocalGet(ACTUAL_INSTRUCTIONS));
    run.instruction(&Instruction::LocalGet(MAXIMUM));
    run.instruction(&Instruction::I32Const(0xffff));
    run.instruction(&Instruction::I32And);
    run.instruction(&Instruction::I32GtU);
    run.instruction(&Instruction::I32Or);
    run.instruction(&Instruction::If(BlockType::Empty));
    emit_return(
        &mut run,
        TOTAL_INSTRUCTIONS,
        TOTAL_CYCLES,
        BLOCKS,
        DispatchReason::InvalidState,
    );
    run.instruction(&Instruction::End);

    run.instruction(&Instruction::LocalGet(TOTAL_INSTRUCTIONS));
    run.instruction(&Instruction::LocalGet(ACTUAL_INSTRUCTIONS));
    run.instruction(&Instruction::I64ExtendI32U);
    run.instruction(&Instruction::I64Add);
    run.instruction(&Instruction::LocalSet(TOTAL_INSTRUCTIONS));
    run.instruction(&Instruction::LocalGet(TOTAL_CYCLES));
    run.instruction(&Instruction::LocalGet(ACTUAL_CYCLES));
    run.instruction(&Instruction::I64ExtendI32U);
    run.instruction(&Instruction::I64Add);
    run.instruction(&Instruction::LocalSet(TOTAL_CYCLES));
    run.instruction(&Instruction::LocalGet(BLOCKS));
    run.instruction(&Instruction::I32Const(1));
    run.instruction(&Instruction::I32Add);
    run.instruction(&Instruction::LocalSet(BLOCKS));
    run.instruction(&Instruction::Br(0));
    run.instruction(&Instruction::End);
    run.instruction(&Instruction::Unreachable);
    run.instruction(&Instruction::End);

    let mut code = CodeSection::new();
    code.function(&lookup);
    code.function(&run);

    let mut metadata = vec![0; config.metadata_capacity as usize * DISPATCH_ENTRY_SIZE as usize];
    for (index, entry) in initial_entry_positions {
        let start = index as usize * DISPATCH_ENTRY_SIZE as usize;
        entry.encode_into(&mut metadata[start..start + DISPATCH_ENTRY_SIZE as usize]);
    }
    let mut identities =
        vec![0; config.slot_capacity as usize * DISPATCH_SLOT_IDENTITY_SIZE as usize];
    for identity in config.initial_slot_identities.iter().copied() {
        let start = identity.table_slot as usize * DISPATCH_SLOT_IDENTITY_SIZE as usize;
        identity.encode_into(&mut identities[start..start + DISPATCH_SLOT_IDENTITY_SIZE as usize]);
    }
    let mut data = DataSection::new();
    data.active(
        0,
        &ConstExpr::i32_const(config.metadata_base as i32),
        metadata,
    );
    data.active(
        0,
        &ConstExpr::i32_const(config.slot_identity_base as i32),
        identities,
    );

    let mut module = Module::new();
    module.section(&types);
    module.section(&imports);
    module.section(&functions);
    module.section(&tables);
    module.section(&exports);
    module.section(&code);
    module.section(&data);
    Ok(module.finish())
}
