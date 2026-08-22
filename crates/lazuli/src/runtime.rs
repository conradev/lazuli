//! Browser- and native-independent machine runtime policy.
//!
//! This module deliberately contains no browser bindings. A browser machine compiled to
//! WebAssembly and the native CPU adapter both use the same cache keys, validation records, and
//! replacement policy. Rust-authored block modules install their own typed function reference;
//! JavaScript may compile and instantiate exact bytes but never selects a table occupant.

use gekko::{Address, Cpu};
use lazuli_abi::{
    BlockInstall, BlockInstallStatus, CompileRequest, PhysicalRange, RecordHeader,
    ResidentBlockInstallIdentity, SharedSlice,
};

use crate::system::mmu::{BatPair, MSR_IR, MSR_PR, TranslationRegisters};

/// Number of hardware-shaped ways in one runtime code-cache set.
pub const CODE_CACHE_WAYS: usize = 4;

/// Largest basic block accepted by the portable PPC JIT contract.
pub const MAXIMUM_BLOCK_INSTRUCTIONS: u16 = 64;

/// Exact instruction-address-space namespaces retained for deterministic reuse.
///
/// GameCube exception entry clears IR/PR and `rfi` commonly restores the immediately preceding
/// translated state. Retaining a bounded set of complete signatures lets those recurring states
/// share already-compiled blocks without turning a signature fingerprint into executable
/// authority.
pub const INSTRUCTION_ADDRESS_SPACE_NAMESPACE_CAPACITY: usize = 64;

/// MPC750 hashed-page size used by retained instruction dependencies.
const INSTRUCTION_PAGE_BYTES: u32 = 4096;

/// Identifies one instruction-address-space configuration.
///
/// The generation changes when an instruction-visible MSR, BAT, segment-register, or SDR1 input
/// changes. Retaining the generation in the key prevents a block from a previous address space
/// from becoming executable after a PC-only collision.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
#[repr(transparent)]
pub struct AddressSpaceGeneration(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct InstructionAddressSpaceSignature {
    msr: u32,
    instruction_bats: [BatPair; 4],
    segments: [u32; 16],
    sdr1: u32,
}

impl InstructionAddressSpaceSignature {
    fn from_cpu(cpu: &Cpu) -> Self {
        let registers = TranslationRegisters::from_cpu(cpu);
        Self {
            msr: registers.msr & (MSR_IR | MSR_PR),
            instruction_bats: registers.instruction_bats,
            segments: registers.segments,
            sdr1: registers.sdr1,
        }
    }
}

/// Result of synchronizing the CPU's architected instruction-address-space inputs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressSpaceUpdate {
    /// No instruction-visible register changed.
    Unchanged(AddressSpaceGeneration),
    /// The current signature changed, either by reusing an exact retained namespace or by
    /// allocating a new never-reused generation.
    Changed {
        previous: Option<AddressSpaceGeneration>,
        current: AddressSpaceGeneration,
        /// Exact least-recently-used namespace displaced by a new signature, if any.
        retired: Option<AddressSpaceGeneration>,
    },
}

/// The 64-bit generation cannot advance without risking a retained-key alias.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AddressSpaceGenerationExhausted;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct InstructionAddressSpaceNamespace {
    signature: InstructionAddressSpaceSignature,
    generation: AddressSpaceGeneration,
}

/// Rust-owned identity for the complete instruction translation context.
///
/// The fixed MRU array compares every architected field directly, so no hash collision can grant
/// block authority. Generations are never reused while this tracker is live. When a new signature
/// displaces the exact LRU namespace, the `retired` field in [`AddressSpaceUpdate::Changed`] tells
/// the caller which generation must be synchronously removed from code and dispatcher metadata.
/// EE-only MSR writes and DBAT changes do not perturb instruction identity; IR, PR, IBAT, SR, and
/// SDR1 do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstructionAddressSpaceTracker {
    namespaces:
        [Option<InstructionAddressSpaceNamespace>; INSTRUCTION_ADDRESS_SPACE_NAMESPACE_CAPACITY],
    namespace_count: usize,
    next_generation: Option<u64>,
}

impl Default for InstructionAddressSpaceTracker {
    fn default() -> Self {
        Self {
            namespaces: [None; INSTRUCTION_ADDRESS_SPACE_NAMESPACE_CAPACITY],
            namespace_count: 0,
            next_generation: Some(1),
        }
    }
}

impl InstructionAddressSpaceTracker {
    pub fn current(&self) -> Option<AddressSpaceGeneration> {
        self.namespaces[0].map(|namespace| namespace.generation)
    }

    /// Observes the CPU registers and selects an exact retained identity when possible.
    ///
    /// A new signature receives a checked, never-reused generation and displaces the exact LRU
    /// namespace only after the fixed table is full. On exhaustion no namespace state changes;
    /// the caller must clear every code/table entry before using
    /// [`Self::reset_after_full_invalidation`].
    pub fn synchronize(
        &mut self,
        cpu: &Cpu,
    ) -> Result<AddressSpaceUpdate, AddressSpaceGenerationExhausted> {
        let next_signature = InstructionAddressSpaceSignature::from_cpu(cpu);
        if self.namespaces[0].is_some_and(|namespace| namespace.signature == next_signature) {
            return Ok(AddressSpaceUpdate::Unchanged(
                self.namespaces[0].unwrap().generation,
            ));
        }
        let previous = self.current();

        if let Some(index) = self.namespaces[..self.namespace_count]
            .iter()
            .position(|namespace| {
                namespace.is_some_and(|namespace| namespace.signature == next_signature)
            })
        {
            self.namespaces[..=index].rotate_right(1);
            let current = self.namespaces[0].unwrap().generation;
            return Ok(AddressSpaceUpdate::Changed {
                previous,
                current,
                retired: None,
            });
        }

        let generation = self
            .next_generation
            .ok_or(AddressSpaceGenerationExhausted)?;
        let retired =
            (self.namespace_count == INSTRUCTION_ADDRESS_SPACE_NAMESPACE_CAPACITY).then(|| {
                self.namespaces[INSTRUCTION_ADDRESS_SPACE_NAMESPACE_CAPACITY - 1]
                    .unwrap()
                    .generation
            });
        if self.namespace_count < INSTRUCTION_ADDRESS_SPACE_NAMESPACE_CAPACITY {
            self.namespace_count += 1;
        }
        self.namespaces[..self.namespace_count].rotate_right(1);
        let current = AddressSpaceGeneration(generation);
        self.namespaces[0] = Some(InstructionAddressSpaceNamespace {
            signature: next_signature,
            generation: current,
        });
        self.next_generation = generation.checked_add(1);
        Ok(AddressSpaceUpdate::Changed {
            previous,
            current,
            retired,
        })
    }

    /// Starts a fresh generation namespace after the caller has synchronously cleared all code
    /// metadata, function-table identities, and pending compile requests.
    pub fn reset_after_full_invalidation(&mut self, cpu: &Cpu) -> AddressSpaceGeneration {
        self.namespaces.fill(None);
        let generation = AddressSpaceGeneration(1);
        self.namespaces[0] = Some(InstructionAddressSpaceNamespace {
            signature: InstructionAddressSpaceSignature::from_cpu(cpu),
            generation,
        });
        self.namespace_count = 1;
        self.next_generation = Some(2);
        generation
    }
}

/// One hashed-page instruction mapping that must still resolve identically before a retained
/// block can execute.
///
/// A 64-instruction PPC block is at most 256 bytes and can therefore touch at most two 4 KiB
/// instruction pages. BAT and real-mode mappings require no dependency record because their
/// complete address-space inputs are represented by [`AddressSpaceGeneration`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[repr(C)]
pub struct InstructionPageDependency {
    pub effective: Address,
    pub physical: Address,
}

/// Execution metadata for one installed PPC block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(C)]
pub struct CachedBlock {
    pub generation: AddressSpaceGeneration,
    pub pc: Address,
    /// Index in the browser machine's shared WebAssembly function table.
    pub table_slot: u32,
    /// Rust-issued identity of the function currently occupying `table_slot`.
    ///
    /// A slot may be reused only with a different nonce. The resident dispatcher checks both
    /// values, so a delayed module or stale table function cannot satisfy a newer cache entry.
    pub slot_nonce: u64,
    pub effective_bytes: u16,
    pub maximum_cycles: u16,
    pub maximum_instructions: u16,
    physical_range_count: u8,
    dependency_count: u8,
    /// Stable numeric `ppcjit::block::Pattern` ABI. Kept opaque here so `lazuli` does not depend
    /// on a particular execution backend.
    pub pattern: u32,
    physical_ranges: [PhysicalRange; 2],
    dependencies: [InstructionPageDependency; 2],
}

impl CachedBlock {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        generation: AddressSpaceGeneration,
        pc: Address,
        table_slot: u32,
        effective_bytes: u16,
        maximum_cycles: u16,
        maximum_instructions: u16,
        pattern: u32,
        physical_ranges: &[PhysicalRange],
        dependencies: &[InstructionPageDependency],
    ) -> Option<Self> {
        let physical_bytes = physical_ranges
            .iter()
            .try_fold(0u32, |total, range| total.checked_add(range.len));
        if dependencies.len() > 2
            || physical_ranges.is_empty()
            || physical_ranges.len() > 2
            || !pc.value().is_multiple_of(4)
            || effective_bytes == 0
            || !effective_bytes.is_multiple_of(4)
            || maximum_cycles == 0
            || maximum_instructions == 0
            || maximum_instructions > MAXIMUM_BLOCK_INSTRUCTIONS
            || u32::from(maximum_instructions) * 4 != u32::from(effective_bytes)
            || physical_ranges.iter().any(|range| {
                range.len == 0
                    || range.len > u32::from(effective_bytes)
                    || !range.len.is_multiple_of(4)
                    || !range.start.is_multiple_of(4)
            })
            || dependencies.iter().any(|dependency| {
                !dependency
                    .effective
                    .value()
                    .is_multiple_of(INSTRUCTION_PAGE_BYTES)
                    || !dependency
                        .physical
                        .value()
                        .is_multiple_of(INSTRUCTION_PAGE_BYTES)
            })
            || physical_bytes != Some(u32::from(effective_bytes))
        {
            return None;
        }
        let mut retained_ranges = [PhysicalRange::default(); 2];
        retained_ranges[..physical_ranges.len()].copy_from_slice(physical_ranges);
        let mut retained = [InstructionPageDependency::default(); 2];
        retained[..dependencies.len()].copy_from_slice(dependencies);
        Some(Self {
            generation,
            pc,
            table_slot,
            slot_nonce: 0,
            effective_bytes,
            maximum_cycles,
            maximum_instructions,
            physical_range_count: physical_ranges.len() as u8,
            dependency_count: dependencies.len() as u8,
            pattern,
            physical_ranges: retained_ranges,
            dependencies: retained,
        })
    }

    pub fn physical_ranges(&self) -> &[PhysicalRange] {
        &self.physical_ranges[..usize::from(self.physical_range_count)]
    }

    /// Whether an effective byte belongs to this block, including a block that wraps the 32-bit
    /// address boundary.
    pub fn covers_effective(&self, address: Address) -> bool {
        address.value().wrapping_sub(self.pc.value()) < u32::from(self.effective_bytes)
    }

    /// Whether a physical byte aliases any instruction span retained by this block.
    pub fn covers_physical(&self, address: Address) -> bool {
        self.physical_ranges()
            .iter()
            .any(|range| range.contains(address.value()))
    }

    pub fn dependencies(&self) -> &[InstructionPageDependency] {
        &self.dependencies[..usize::from(self.dependency_count)]
    }

    fn assign_table_identity(mut self, table_slot: u32, slot_nonce: u64) -> Self {
        self.table_slot = table_slot;
        self.slot_nonce = slot_nonce;
        self
    }
}

#[derive(Debug, Clone, Default)]
struct CodeCacheSet {
    entries: [Option<CachedBlock>; CODE_CACHE_WAYS],
    next_replacement: u8,
}

/// Result of installing a compiled block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstalledBlock {
    /// Way containing the new block.
    pub way: u8,
    /// A valid block displaced from that way, if any.
    pub evicted: Option<CachedBlock>,
}

/// One cache entry together with its exact shared dispatcher-directory position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexedCachedBlock {
    pub block: CachedBlock,
    /// `set * CODE_CACHE_WAYS + way`, matching the persistent Wasm dispatcher's directory.
    pub directory_index: u32,
}

/// Rust-owned metadata cache used by a persistent browser Wasm dispatcher.
///
/// The WebAssembly table contains only opaque callable functions. This structure owns all
/// semantic keys and dependencies; table presence alone never authorizes execution.
#[derive(Debug, Clone)]
pub struct CodeCache {
    sets: Box<[CodeCacheSet]>,
    mask: usize,
    len: usize,
}

impl CodeCache {
    /// Creates a four-way cache. `set_count` must be a non-zero power of two.
    pub fn new(set_count: usize) -> Option<Self> {
        if !set_count.is_power_of_two() {
            return None;
        }
        Some(Self {
            sets: vec![CodeCacheSet::default(); set_count].into_boxed_slice(),
            mask: set_count - 1,
            len: 0,
        })
    }

    #[inline(always)]
    fn set_index(&self, generation: AddressSpaceGeneration, pc: Address) -> usize {
        let pc_word = pc.value() >> 2;
        let folded_generation = generation.0 as u32 ^ (generation.0 >> 32) as u32;
        let mixed = pc_word ^ folded_generation.wrapping_mul(0x9e37_79b9);
        mixed as usize & self.mask
    }

    fn directory_index(set_index: usize, way: usize) -> u32 {
        u32::try_from(set_index * CODE_CACHE_WAYS + way)
            .expect("a wasm32 code-cache directory index fits in u32")
    }

    fn matching_way(
        set: &CodeCacheSet,
        generation: AddressSpaceGeneration,
        pc: Address,
    ) -> Option<usize> {
        set.entries.iter().position(|entry| {
            entry.is_some_and(|entry| entry.generation == generation && entry.pc == pc)
        })
    }

    fn peek(&self, generation: AddressSpaceGeneration, pc: Address) -> Option<CachedBlock> {
        let set = &self.sets[self.set_index(generation, pc)];
        set.entries[Self::matching_way(set, generation, pc)?]
    }

    /// Installs or replaces a block and returns any displaced table metadata.
    pub fn install(&mut self, block: CachedBlock) -> InstalledBlock {
        let set_index = self.set_index(block.generation, block.pc);
        let set = &mut self.sets[set_index];
        let way = Self::matching_way(set, block.generation, block.pc)
            .or_else(|| set.entries.iter().position(Option::is_none))
            .unwrap_or_else(|| usize::from(set.next_replacement));
        let evicted = set.entries[way].replace(block);
        if evicted.is_none() {
            self.len += 1;
        }
        set.next_replacement = ((way + 1) % CODE_CACHE_WAYS) as u8;
        InstalledBlock {
            way: way as u8,
            evicted,
        }
    }

    fn install_indexed(&mut self, block: CachedBlock) -> (InstalledBlock, u32) {
        let set_index = self.set_index(block.generation, block.pc);
        let installed = self.install(block);
        let directory_index = Self::directory_index(set_index, usize::from(installed.way));
        (installed, directory_index)
    }

    /// Returns a block only when its current instruction mappings pass `validate`.
    ///
    /// A failed validation invalidates the entry before returning. This fail-closed operation is
    /// the only lookup intended for an execution dispatcher.
    pub fn lookup_validated(
        &mut self,
        generation: AddressSpaceGeneration,
        pc: Address,
        mut validate: impl FnMut(&[InstructionPageDependency]) -> bool,
    ) -> Option<CachedBlock> {
        let set_index = self.set_index(generation, pc);
        let set = &mut self.sets[set_index];
        let way = Self::matching_way(set, generation, pc)?;
        let block = set.entries[way]?;
        if validate(block.dependencies()) {
            // A hit makes the following way the next victim. This keeps replacement deterministic
            // without exposing browser timing to cache policy.
            set.next_replacement = ((way + 1) % CODE_CACHE_WAYS) as u8;
            Some(block)
        } else {
            set.entries[way] = None;
            self.len -= 1;
            None
        }
    }

    pub fn invalidate(
        &mut self,
        generation: AddressSpaceGeneration,
        pc: Address,
    ) -> Option<CachedBlock> {
        let set_index = self.set_index(generation, pc);
        let set = &mut self.sets[set_index];
        let way = Self::matching_way(set, generation, pc)?;
        let removed = set.entries[way].take();
        if removed.is_some() {
            self.len -= 1;
        }
        removed
    }

    fn invalidate_indexed(
        &mut self,
        generation: AddressSpaceGeneration,
        pc: Address,
    ) -> Option<IndexedCachedBlock> {
        let set_index = self.set_index(generation, pc);
        let set = &mut self.sets[set_index];
        let way = Self::matching_way(set, generation, pc)?;
        let block = set.entries[way].take()?;
        self.len -= 1;
        Some(IndexedCachedBlock {
            block,
            directory_index: Self::directory_index(set_index, way),
        })
    }

    /// Invalidates every block selected by the predicate and returns the removed metadata.
    pub fn invalidate_where(
        &mut self,
        mut predicate: impl FnMut(&CachedBlock) -> bool,
    ) -> Vec<CachedBlock> {
        let mut removed = Vec::new();
        for set in &mut self.sets {
            for entry in &mut set.entries {
                if entry.as_ref().is_some_and(&mut predicate) {
                    removed.push(entry.take().unwrap());
                }
            }
        }
        self.len -= removed.len();
        removed
    }

    fn invalidate_where_indexed(
        &mut self,
        mut predicate: impl FnMut(&CachedBlock) -> bool,
    ) -> Vec<IndexedCachedBlock> {
        let mut removed = Vec::new();
        for (set_index, set) in self.sets.iter_mut().enumerate() {
            for (way, entry) in set.entries.iter_mut().enumerate() {
                if entry.as_ref().is_some_and(&mut predicate) {
                    removed.push(IndexedCachedBlock {
                        block: entry.take().unwrap(),
                        directory_index: Self::directory_index(set_index, way),
                    });
                }
            }
        }
        self.len -= removed.len();
        removed
    }

    pub fn clear(&mut self) -> Vec<CachedBlock> {
        self.invalidate_where(|_| true)
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn capacity(&self) -> usize {
        self.sets.len() * CODE_CACHE_WAYS
    }
}

/// Validated block metadata before Rust assigns ownership of a WebAssembly table slot.
///
/// The cold compiler receives this value only inside the Rust machine. The browser receives a
/// [`CompileRequest`], which intentionally contains none of these guest-machine semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColdBlock {
    retained: CachedBlock,
}

impl ColdBlock {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        generation: AddressSpaceGeneration,
        pc: Address,
        effective_bytes: u16,
        maximum_cycles: u16,
        maximum_instructions: u16,
        pattern: u32,
        physical_ranges: &[PhysicalRange],
        dependencies: &[InstructionPageDependency],
    ) -> Option<Self> {
        CachedBlock::new(
            generation,
            pc,
            0,
            effective_bytes,
            maximum_cycles,
            maximum_instructions,
            pattern,
            physical_ranges,
            dependencies,
        )
        .map(|retained| Self { retained })
    }

    pub const fn generation(self) -> AddressSpaceGeneration {
        self.retained.generation
    }

    pub const fn pc(self) -> Address {
        self.retained.pc
    }

    /// Read-only validated metadata for scoped Rust hook invalidation.
    ///
    /// This does not expose table ownership: a cold block has no assigned table slot or nonce.
    pub fn retained(&self) -> &CachedBlock {
        &self.retained
    }

    pub fn covers_effective(&self, address: Address) -> bool {
        self.retained.covers_effective(address)
    }

    pub fn covers_physical(&self, address: Address) -> bool {
        self.retained.covers_physical(address)
    }

    fn install_at(self, table_slot: u32, slot_nonce: u64) -> CachedBlock {
        self.retained.assign_table_identity(table_slot, slot_nonce)
    }
}

/// Exact Rust-authored Wasm source made visible to the browser's cold compiler.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WasmModuleSource {
    module: SharedSlice,
    sha256: [u32; 8],
}

impl WasmModuleSource {
    pub fn new(module: SharedSlice, sha256: [u32; 8]) -> Option<Self> {
        if module.ptr.is_null() || module.len == 0 || module.checked_end().is_none() {
            return None;
        }
        Some(Self { module, sha256 })
    }
}

/// Exact slot identity whose shared publication must be retired.
///
/// The nonce lets Rust distinguish a stale retirement from a newer occupant. Rust clears the
/// matching slot-identity record synchronously before reuse. The typed table value may remain:
/// unpublished metadata makes it unreachable until an authorized module replaces it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TableSlotRetirement {
    pub table_slot: u32,
    pub slot_nonce: u64,
}

impl CachedBlock {
    pub const fn table_retirement(self) -> TableSlotRetirement {
        TableSlotRetirement {
            table_slot: self.table_slot,
            slot_nonce: self.slot_nonce,
        }
    }
}

/// One host-visible cold-compile request and any old slot ownership retired before it was issued.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileEmission {
    /// A copy of the request retained authoritatively inside [`ColdCompileCoordinator`].
    pub host_request: CompileRequest,
    /// Semantic cache records invalidated while reclaiming the selected slot.
    pub evicted: Vec<IndexedCachedBlock>,
    /// Slot publication to retire before installing this request.
    pub retired_slot: Option<TableSlotRetirement>,
}

/// Rust-reserved identity used to finalize one exact self-installing Wasm module.
///
/// The module bytes do not exist yet when this value is returned: the caller embeds
/// `install_identity` into the generated installer, hashes those final bytes, then calls
/// [`ColdCompileCoordinator::publish_prepared_compile`]. Old cache/table ownership is already
/// retired, so a delayed prior module cannot remain reachable while the new module is built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompilePreparation {
    pub install_identity: ResidentBlockInstallIdentity,
    pub evicted: Vec<IndexedCachedBlock>,
    pub retired_slot: Option<TableSlotRetirement>,
}

/// A request could not be emitted without violating cold-compile ownership.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompileIssueError {
    /// The machine is already suspended on a cold compilation.
    PendingRequest,
    /// Every possible 64-bit slot identity has been issued by this runtime instance.
    IdentityExhausted,
}

/// A finalized module did not match the exact Rust reservation it was built for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompilePublishError {
    NoPendingPreparation,
    IdentityMismatch,
    InvalidPhase,
}

/// A successful receipt installed one block and may have displaced another cache entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompletedCompile {
    pub block: CachedBlock,
    pub way: u8,
    /// Exact shared dispatcher-directory record to publish for `block`.
    pub directory_index: u32,
    /// Cache metadata displaced by set associativity, if any.
    pub evicted: Option<IndexedCachedBlock>,
    /// Exact slot publication to retire for `evicted`.
    pub retired_slot: Option<TableSlotRetirement>,
}

/// Why a resident module could not begin or commit its own table installation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelfInstallError {
    NoPendingRequest,
    IdentityMismatch,
    InvalidPhase,
    AddressSpaceChanged {
        requested: AddressSpaceGeneration,
        current: AddressSpaceGeneration,
        retired_slot: TableSlotRetirement,
    },
}

/// Why a host receipt was not allowed to publish executable metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompileInstallError {
    /// There is no outstanding Rust-issued request. This includes duplicate receipts.
    NoPendingRequest,
    /// The record header, reserved field, or another structural field is malformed. The valid
    /// pending request is retained so the adapter can submit a corrected receipt.
    InvalidRecord,
    /// At least one echoed identity differs from Rust's private request. The valid pending request
    /// is retained. This rejects stale receipts and paired mutations of the shared request copy.
    IdentityMismatch,
    /// The receipt was exact, but the instruction address space changed while compilation was in
    /// flight. The request is consumed and its slot publication must remain absent.
    AddressSpaceChanged {
        requested: AddressSpaceGeneration,
        current: AddressSpaceGeneration,
        retired_slot: TableSlotRetirement,
    },
    /// The host reported a known non-success status. The request is consumed exactly once.
    HostFailure {
        status: BlockInstallStatus,
        retired_slot: TableSlotRetirement,
    },
    /// The host supplied an unknown status discriminant. The exact request is still consumed so
    /// a malformed terminal response cannot later be replayed as success.
    InvalidStatus {
        status_raw: u32,
        retired_slot: TableSlotRetirement,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ColdSlotState {
    Vacant,
    Pending {
        request_id: u32,
        nonce: u64,
    },
    Installed {
        generation: AddressSpaceGeneration,
        pc: Address,
        nonce: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingCompile {
    private_request: CompileRequest,
    block: ColdBlock,
    slot_index: usize,
    phase: PendingCompilePhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingCompilePhase {
    Prepared,
    Issued,
    Installing,
}

/// Rust-owned cold compile, install, code-cache, and table-slot coordinator.
///
/// Only one request can be outstanding because a dispatch miss suspends the synchronous machine
/// until its exact block is available. Keeping the authoritative request here rather than in the
/// shared ABI record prevents the browser from mutating both a request and its receipt into a
/// self-consistent forgery. Request IDs may wrap, but the monotonically issued 64-bit slot nonce
/// never does; the runtime fails closed if that identity space is exhausted.
#[derive(Debug, Clone)]
pub struct ColdCompileCoordinator {
    cache: CodeCache,
    first_table_slot: u32,
    slots: Box<[ColdSlotState]>,
    next_slot: usize,
    next_request_id: u32,
    next_slot_nonce: Option<u64>,
    next_install_token: Option<u64>,
    pending: Option<PendingCompile>,
}

impl ColdCompileCoordinator {
    /// Creates a coordinator over a contiguous table range.
    ///
    /// `cache_set_count` must be a non-zero power of two, `table_slot_count` must be non-zero,
    /// and the inclusive table range must fit in `u32`.
    pub fn new(
        cache_set_count: usize,
        first_table_slot: u32,
        table_slot_count: u32,
    ) -> Option<Self> {
        let cache = CodeCache::new(cache_set_count)?;
        if table_slot_count == 0 || first_table_slot.checked_add(table_slot_count - 1).is_none() {
            return None;
        }
        let slot_count = usize::try_from(table_slot_count).ok()?;
        Some(Self {
            cache,
            first_table_slot,
            slots: vec![ColdSlotState::Vacant; slot_count].into_boxed_slice(),
            next_slot: 0,
            next_request_id: 1,
            next_slot_nonce: Some(1),
            next_install_token: Some(0x8f3d_9a71_c652_4be1),
            pending: None,
        })
    }

    pub fn cache_len(&self) -> usize {
        self.cache.len()
    }

    pub fn cache_capacity(&self) -> usize {
        self.cache.capacity()
    }

    pub fn has_pending_compile(&self) -> bool {
        self.pending.is_some()
    }

    /// Peeks at exact installed metadata without validating dependencies or changing cache LRU.
    ///
    /// Resident scheduling uses only the Rust-owned declared maximum cost from this snapshot to
    /// authorize one deadline-overshoot block. The dispatcher still validates every dependency,
    /// directory identity, and table occupant before executing the block.
    pub fn peek(&self, generation: AddressSpaceGeneration, pc: Address) -> Option<CachedBlock> {
        self.cache.peek(generation, pc)
    }

    fn table_slot(&self, slot_index: usize) -> u32 {
        self.first_table_slot + slot_index as u32
    }

    fn slot_index(&self, table_slot: u32) -> Option<usize> {
        let relative = table_slot.checked_sub(self.first_table_slot)?;
        let relative = usize::try_from(relative).ok()?;
        (relative < self.slots.len()).then_some(relative)
    }

    fn allocate_request_id(&mut self) -> u32 {
        let request_id = self.next_request_id;
        self.next_request_id = self.next_request_id.wrapping_add(1);
        if self.next_request_id == 0 {
            self.next_request_id = 1;
        }
        request_id
    }

    fn allocate_slot_nonce(&mut self) -> Result<u64, CompileIssueError> {
        let nonce = self
            .next_slot_nonce
            .ok_or(CompileIssueError::IdentityExhausted)?;
        self.next_slot_nonce = nonce.checked_add(1);
        Ok(nonce)
    }

    fn allocate_install_token(&mut self) -> Result<u64, CompileIssueError> {
        let token = self
            .next_install_token
            .ok_or(CompileIssueError::IdentityExhausted)?;
        self.next_install_token = token.checked_add(1);
        Ok(token)
    }

    fn choose_slot(&mut self) -> usize {
        let slot_count = self.slots.len();
        let chosen = (0..slot_count)
            .map(|offset| (self.next_slot + offset) % slot_count)
            .find(|&index| self.slots[index] == ColdSlotState::Vacant)
            .unwrap_or(self.next_slot);
        self.next_slot = (chosen + 1) % slot_count;
        chosen
    }

    /// Reserves the exact identity embedded into one self-installing resident block module.
    ///
    /// Any old slot/cache owner is retired before the identity is returned. The caller must
    /// finalize the module with `install_identity`, hash those exact bytes, and publish them with
    /// [`Self::publish_prepared_compile`].
    pub fn prepare_compile(
        &mut self,
        block: ColdBlock,
    ) -> Result<CompilePreparation, CompileIssueError> {
        if self.pending.is_some() {
            return Err(CompileIssueError::PendingRequest);
        }
        let slot_nonce = self.allocate_slot_nonce()?;
        let install_token = self.allocate_install_token()?;
        let request_id = self.allocate_request_id();
        let slot_index = self.choose_slot();
        let table_slot = self.table_slot(slot_index);

        let (retired_slot, evicted) = match self.slots[slot_index] {
            ColdSlotState::Vacant => (None, Vec::new()),
            ColdSlotState::Installed { nonce, .. } => {
                let evicted = self
                    .cache
                    .invalidate_where_indexed(|entry| entry.table_slot == table_slot);
                debug_assert_eq!(evicted.len(), 1);
                (
                    Some(TableSlotRetirement {
                        table_slot,
                        slot_nonce: nonce,
                    }),
                    evicted,
                )
            }
            ColdSlotState::Pending { .. } => {
                unreachable!("a second compile cannot select the only pending slot")
            }
        };

        let generation = block.generation().0;
        let private_request = CompileRequest {
            header: RecordHeader::for_record::<CompileRequest>(),
            request_id,
            table_slot,
            slot_nonce_lo: slot_nonce as u32,
            slot_nonce_hi: (slot_nonce >> 32) as u32,
            address_space_generation_lo: generation as u32,
            address_space_generation_hi: (generation >> 32) as u32,
            install_token_lo: install_token as u32,
            install_token_hi: (install_token >> 32) as u32,
            module: SharedSlice::EMPTY,
            module_sha256: [0; 8],
            reserved: 0,
        };
        self.slots[slot_index] = ColdSlotState::Pending {
            request_id,
            nonce: slot_nonce,
        };
        self.pending = Some(PendingCompile {
            private_request,
            block,
            slot_index,
            phase: PendingCompilePhase::Prepared,
        });
        Ok(CompilePreparation {
            install_identity: private_request.install_identity(),
            evicted,
            retired_slot,
        })
    }

    /// Publishes the final Rust-authored module bytes for the exact outstanding reservation.
    pub fn publish_prepared_compile(
        &mut self,
        identity: ResidentBlockInstallIdentity,
        source: WasmModuleSource,
    ) -> Result<CompileRequest, CompilePublishError> {
        let Some(pending) = self.pending.as_mut() else {
            return Err(CompilePublishError::NoPendingPreparation);
        };
        if !identity.matches_request(&pending.private_request) {
            return Err(CompilePublishError::IdentityMismatch);
        }
        if pending.phase != PendingCompilePhase::Prepared {
            return Err(CompilePublishError::InvalidPhase);
        }
        pending.private_request.module = source.module;
        pending.private_request.module_sha256 = source.sha256;
        pending.phase = PendingCompilePhase::Issued;
        debug_assert!(pending.private_request.has_valid_source());
        Ok(pending.private_request)
    }

    /// Compatibility helper for callers that do not yet embed the identity into module bytes.
    /// New browser-machine code must use the prepare/finalize pair above.
    pub fn issue_compile(
        &mut self,
        block: ColdBlock,
        source: WasmModuleSource,
    ) -> Result<CompileEmission, CompileIssueError> {
        let preparation = self.prepare_compile(block)?;
        let host_request = self
            .publish_prepared_compile(preparation.install_identity, source)
            .expect("the freshly prepared identity and validated source must publish");
        Ok(CompileEmission {
            host_request,
            evicted: preparation.evicted,
            retired_slot: preparation.retired_slot,
        })
    }

    fn consume_pending(&mut self) -> (PendingCompile, TableSlotRetirement) {
        let pending = self.pending.take().expect("pending request was checked");
        let request = pending.private_request;
        debug_assert_eq!(
            self.slots[pending.slot_index],
            ColdSlotState::Pending {
                request_id: request.request_id,
                nonce: request.slot_nonce(),
            }
        );
        self.slots[pending.slot_index] = ColdSlotState::Vacant;
        (
            pending,
            TableSlotRetirement {
                table_slot: request.table_slot,
                slot_nonce: request.slot_nonce(),
            },
        )
    }

    fn release_installed_slot(&mut self, block: CachedBlock) -> Option<TableSlotRetirement> {
        let slot_index = self.slot_index(block.table_slot)?;
        let expected = ColdSlotState::Installed {
            generation: block.generation,
            pc: block.pc,
            nonce: block.slot_nonce,
        };
        if self.slots[slot_index] != expected {
            debug_assert_eq!(self.slots[slot_index], expected);
            return None;
        }
        self.slots[slot_index] = ColdSlotState::Vacant;
        Some(block.table_retirement())
    }

    fn complete_pending_install(&mut self) -> CompletedCompile {
        let (pending, _) = self.consume_pending();
        let slot_nonce = pending.private_request.slot_nonce();
        let block = pending
            .block
            .install_at(pending.private_request.table_slot, slot_nonce);
        let (InstalledBlock { way, evicted }, directory_index) = self.cache.install_indexed(block);
        let indexed_evicted = evicted.map(|block| IndexedCachedBlock {
            block,
            directory_index,
        });
        let retired_slot = evicted.and_then(|evicted| self.release_installed_slot(evicted));
        self.slots[pending.slot_index] = ColdSlotState::Installed {
            generation: block.generation,
            pc: block.pc,
            nonce: block.slot_nonce,
        };
        CompletedCompile {
            block,
            way,
            directory_index,
            evicted: indexed_evicted,
            retired_slot,
        }
    }

    /// Authorizes the exact self-installing module immediately before its typed table write.
    pub fn begin_self_install(
        &mut self,
        identity: ResidentBlockInstallIdentity,
        current_generation: AddressSpaceGeneration,
    ) -> Result<(), SelfInstallError> {
        let Some(pending) = self.pending.as_ref() else {
            return Err(SelfInstallError::NoPendingRequest);
        };
        if !identity.matches_request(&pending.private_request) {
            return Err(SelfInstallError::IdentityMismatch);
        }
        if pending.phase != PendingCompilePhase::Issued {
            return Err(SelfInstallError::InvalidPhase);
        }
        let requested = pending.block.generation();
        if current_generation != requested {
            let (_, retired_slot) = self.consume_pending();
            return Err(SelfInstallError::AddressSpaceChanged {
                requested,
                current: current_generation,
                retired_slot,
            });
        }
        self.pending.as_mut().unwrap().phase = PendingCompilePhase::Installing;
        Ok(())
    }

    /// Commits the exact module that completed `table.set(ref.func run)` in the current turn.
    ///
    /// Shared slot/cache records remain unpublished until the caller receives this success and
    /// writes the returned [`CompletedCompile`] fields. A trap between begin and commit therefore
    /// leaves an unreachable table occupant and a cancellable pending request.
    pub fn commit_self_install(
        &mut self,
        identity: ResidentBlockInstallIdentity,
        current_generation: AddressSpaceGeneration,
    ) -> Result<CompletedCompile, SelfInstallError> {
        let Some(pending) = self.pending.as_ref() else {
            return Err(SelfInstallError::NoPendingRequest);
        };
        if !identity.matches_request(&pending.private_request) {
            return Err(SelfInstallError::IdentityMismatch);
        }
        if pending.phase != PendingCompilePhase::Installing {
            return Err(SelfInstallError::InvalidPhase);
        }
        let requested = pending.block.generation();
        if current_generation != requested {
            let (_, retired_slot) = self.consume_pending();
            return Err(SelfInstallError::AddressSpaceChanged {
                requested,
                current: current_generation,
                retired_slot,
            });
        }
        Ok(self.complete_pending_install())
    }

    /// Validates and consumes one install receipt against the private Rust-issued request.
    ///
    /// Structurally invalid and wrong-identity records leave the real request pending. Once an
    /// exact-identity terminal receipt is observed, success or failure consumes it exactly once.
    pub fn accept_install(
        &mut self,
        receipt: BlockInstall,
        current_generation: AddressSpaceGeneration,
    ) -> Result<CompletedCompile, CompileInstallError> {
        let Some(pending) = self.pending.as_ref() else {
            return Err(CompileInstallError::NoPendingRequest);
        };
        if !receipt.header.supports::<BlockInstall>() || receipt.reserved != 0 {
            return Err(CompileInstallError::InvalidRecord);
        }
        if !receipt.matches_request_identity(&pending.private_request) {
            return Err(CompileInstallError::IdentityMismatch);
        }
        if pending.phase != PendingCompilePhase::Issued {
            return Err(CompileInstallError::InvalidRecord);
        }

        let requested = pending.block.generation();
        if current_generation != requested {
            let (_, retired_slot) = self.consume_pending();
            return Err(CompileInstallError::AddressSpaceChanged {
                requested,
                current: current_generation,
                retired_slot,
            });
        }

        match receipt.status() {
            Ok(BlockInstallStatus::Installed) => {}
            Ok(status) => {
                let (_, retired_slot) = self.consume_pending();
                return Err(CompileInstallError::HostFailure {
                    status,
                    retired_slot,
                });
            }
            Err(_) => {
                let (_, retired_slot) = self.consume_pending();
                return Err(CompileInstallError::InvalidStatus {
                    status_raw: receipt.status_raw,
                    retired_slot,
                });
            }
        }

        Ok(self.complete_pending_install())
    }

    /// Cancels an outstanding request and returns the slot publication that must remain absent.
    /// A delayed module is rejected thereafter.
    pub fn cancel_pending(&mut self) -> Option<TableSlotRetirement> {
        self.pending.as_ref()?;
        Some(self.consume_pending().1)
    }

    /// Cancels the exact Rust-issued self-install request after host compilation,
    /// instantiation, or installation failed.
    ///
    /// The full one-use identity is required so a delayed failure notification cannot cancel a
    /// newer request that has reused the same table slot. Both the issued and installing phases
    /// are cancellable: a trap after the module's typed `table.set` still leaves no published
    /// dispatcher metadata, and consuming this identity makes that unreachable occupant stale.
    pub fn cancel_self_install(
        &mut self,
        identity: ResidentBlockInstallIdentity,
    ) -> Result<TableSlotRetirement, SelfInstallError> {
        let Some(pending) = self.pending.as_ref() else {
            return Err(SelfInstallError::NoPendingRequest);
        };
        if !identity.matches_request(&pending.private_request) {
            return Err(SelfInstallError::IdentityMismatch);
        }
        if !matches!(
            pending.phase,
            PendingCompilePhase::Issued | PendingCompilePhase::Installing
        ) {
            return Err(SelfInstallError::InvalidPhase);
        }
        Ok(self.consume_pending().1)
    }

    /// Cancels only when the outstanding block is selected by a scoped invalidation.
    pub fn cancel_pending_where(
        &mut self,
        predicate: impl FnOnce(&ColdBlock) -> bool,
    ) -> Option<TableSlotRetirement> {
        let pending = self.pending.as_ref()?;
        if !predicate(&pending.block) {
            return None;
        }
        Some(self.consume_pending().1)
    }

    /// Dispatcher lookup that also retires a slot when dependency validation fails closed.
    pub fn lookup_validated(
        &mut self,
        generation: AddressSpaceGeneration,
        pc: Address,
        validate: impl FnMut(&[InstructionPageDependency]) -> bool,
    ) -> (Option<CachedBlock>, Option<TableSlotRetirement>) {
        let before = self.cache.peek(generation, pc);
        let found = self.cache.lookup_validated(generation, pc, validate);
        let retired = if found.is_none() {
            before.and_then(|block| self.release_installed_slot(block))
        } else {
            None
        };
        (found, retired)
    }

    pub fn invalidate(
        &mut self,
        generation: AddressSpaceGeneration,
        pc: Address,
    ) -> Option<IndexedCachedBlock> {
        let removed = self.cache.invalidate_indexed(generation, pc)?;
        let retired = self.release_installed_slot(removed.block);
        debug_assert_eq!(retired, Some(removed.block.table_retirement()));
        Some(removed)
    }

    /// Invalidates matching cache entries. Each returned block's [`CachedBlock::table_retirement`]
    /// is safe to apply before any later call that can issue a request reusing its slot.
    pub fn invalidate_where(
        &mut self,
        predicate: impl FnMut(&CachedBlock) -> bool,
    ) -> Vec<IndexedCachedBlock> {
        let removed = self.cache.invalidate_where_indexed(predicate);
        for removed_block in removed.iter().copied() {
            let retired = self.release_installed_slot(removed_block.block);
            debug_assert_eq!(retired, Some(removed_block.block.table_retirement()));
        }
        removed
    }

    pub fn clear(&mut self) -> Vec<IndexedCachedBlock> {
        self.invalidate_where(|_| true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(generation: u64, pc: u32, slot: u32) -> CachedBlock {
        CachedBlock::new(
            AddressSpaceGeneration(generation),
            Address(pc),
            slot,
            12,
            7,
            3,
            0,
            &[PhysicalRange {
                start: pc & 0x01ff_ffff,
                len: 12,
            }],
            &[],
        )
        .unwrap()
    }

    #[test]
    fn instruction_address_space_identity_tracks_only_architected_fetch_inputs() {
        let mut cpu = Cpu::default();
        let mut tracker = InstructionAddressSpaceTracker::default();
        assert_eq!(tracker.current(), None);
        assert_eq!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Changed {
                previous: None,
                current: AddressSpaceGeneration(1),
                retired: None,
            })
        );
        assert_eq!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Unchanged(AddressSpaceGeneration(1)))
        );

        cpu.supervisor.config.msr.set_interrupts(true);
        cpu.supervisor.memory.dbat[0] = gekko::Bat::from_bits(0x8000_0002_0000_0002);
        assert_eq!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Unchanged(AddressSpaceGeneration(1)))
        );

        cpu.supervisor.config.msr.set_instr_addr_translation(true);
        assert_eq!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Changed {
                previous: Some(AddressSpaceGeneration(1)),
                current: AddressSpaceGeneration(2),
                retired: None,
            })
        );
        cpu.supervisor.config.msr.set_instr_addr_translation(false);
        assert_eq!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Changed {
                previous: Some(AddressSpaceGeneration(2)),
                current: AddressSpaceGeneration(1),
                retired: None,
            })
        );
        cpu.supervisor.config.msr.set_instr_addr_translation(true);
        assert_eq!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Changed {
                previous: Some(AddressSpaceGeneration(1)),
                current: AddressSpaceGeneration(2),
                retired: None,
            })
        );
        cpu.supervisor.config.msr.set_user_mode(true);
        assert_eq!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Changed {
                previous: Some(AddressSpaceGeneration(2)),
                current: AddressSpaceGeneration(3),
                retired: None,
            })
        );
        cpu.supervisor.memory.ibat[0] = gekko::Bat::from_bits(0x9000_0002_0000_0002);
        assert!(matches!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Changed {
                current: AddressSpaceGeneration(4),
                ..
            })
        ));
        cpu.supervisor.memory.sr[9] = 0x0012_3456;
        assert!(matches!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Changed {
                current: AddressSpaceGeneration(5),
                ..
            })
        ));
        cpu.supervisor.memory.sdr1 = 0x0001_0000;
        assert!(matches!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Changed {
                current: AddressSpaceGeneration(6),
                ..
            })
        ));

        assert_eq!(
            tracker.reset_after_full_invalidation(&cpu),
            AddressSpaceGeneration(1)
        );
        assert_eq!(tracker.current(), Some(AddressSpaceGeneration(1)));
        assert_eq!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Unchanged(AddressSpaceGeneration(1)))
        );

        cpu.supervisor.memory.sdr1 = 0;
        assert_eq!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Changed {
                previous: Some(AddressSpaceGeneration(1)),
                current: AddressSpaceGeneration(2),
                retired: None,
            })
        );
    }

    #[test]
    fn every_bat_and_segment_slot_participates_in_exact_namespace_identity() {
        for index in 0..4 {
            let mut cpu = Cpu::default();
            let mut tracker = InstructionAddressSpaceTracker::default();
            tracker.synchronize(&cpu).unwrap();
            cpu.supervisor.memory.ibat[index] =
                gekko::Bat::from_bits(0x8000_0002_0000_0002 | ((index as u64) << 17));
            assert!(matches!(
                tracker.synchronize(&cpu),
                Ok(AddressSpaceUpdate::Changed {
                    previous: Some(AddressSpaceGeneration(1)),
                    current: AddressSpaceGeneration(2),
                    retired: None,
                })
            ));
        }

        for index in 0..16 {
            let mut cpu = Cpu::default();
            let mut tracker = InstructionAddressSpaceTracker::default();
            tracker.synchronize(&cpu).unwrap();
            cpu.supervisor.memory.sr[index] = 0x0010_0000 | index as u32;
            assert!(matches!(
                tracker.synchronize(&cpu),
                Ok(AddressSpaceUpdate::Changed {
                    previous: Some(AddressSpaceGeneration(1)),
                    current: AddressSpaceGeneration(2),
                    retired: None,
                })
            ));
        }
    }

    #[test]
    fn instruction_address_space_exact_mru_retires_only_the_deterministic_lru() {
        let mut cpu = Cpu::default();
        let mut tracker = InstructionAddressSpaceTracker::default();
        assert!(matches!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Changed {
                current: AddressSpaceGeneration(1),
                retired: None,
                ..
            })
        ));

        for signature in 1..INSTRUCTION_ADDRESS_SPACE_NAMESPACE_CAPACITY as u32 {
            cpu.supervisor.memory.sr[0] = signature;
            assert!(matches!(
                tracker.synchronize(&cpu),
                Ok(AddressSpaceUpdate::Changed { retired: None, .. })
            ));
        }
        assert_eq!(
            tracker.namespace_count,
            INSTRUCTION_ADDRESS_SPACE_NAMESPACE_CAPACITY
        );

        // Refresh generation one so generation two becomes the exact LRU victim.
        cpu.supervisor.memory.sr[0] = 0;
        assert_eq!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Changed {
                previous: Some(AddressSpaceGeneration(64)),
                current: AddressSpaceGeneration(1),
                retired: None,
            })
        );
        cpu.supervisor.memory.sr[0] = INSTRUCTION_ADDRESS_SPACE_NAMESPACE_CAPACITY as u32;
        assert_eq!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Changed {
                previous: Some(AddressSpaceGeneration(1)),
                current: AddressSpaceGeneration(65),
                retired: Some(AddressSpaceGeneration(2)),
            })
        );

        cpu.supervisor.memory.sr[0] = 0;
        assert_eq!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Changed {
                previous: Some(AddressSpaceGeneration(65)),
                current: AddressSpaceGeneration(1),
                retired: None,
            })
        );
        assert_eq!(
            tracker.namespaces[..tracker.namespace_count]
                .iter()
                .filter_map(|namespace| namespace.map(|namespace| namespace.generation))
                .filter(|generation| *generation == AddressSpaceGeneration(1))
                .count(),
            1
        );
    }

    #[test]
    fn instruction_address_space_generation_never_wraps_into_retained_identity() {
        let mut cpu = Cpu::default();
        let mut tracker = InstructionAddressSpaceTracker::default();
        tracker.synchronize(&cpu).unwrap();
        tracker.next_generation = Some(u64::MAX);
        cpu.supervisor.memory.sr[0] = 1;
        assert!(matches!(
            tracker.synchronize(&cpu),
            Ok(AddressSpaceUpdate::Changed {
                current: AddressSpaceGeneration(u64::MAX),
                retired: None,
                ..
            })
        ));
        cpu.supervisor.memory.sr[0] = 2;
        let retained_namespaces = tracker.namespaces;
        let retained_count = tracker.namespace_count;
        assert_eq!(
            tracker.synchronize(&cpu),
            Err(AddressSpaceGenerationExhausted)
        );
        assert_eq!(tracker.namespaces, retained_namespaces);
        assert_eq!(tracker.namespace_count, retained_count);
        assert_eq!(tracker.current(), Some(AddressSpaceGeneration(u64::MAX)));
    }

    #[test]
    fn rejects_invalid_cache_and_block_shapes() {
        assert!(CodeCache::new(0).is_none());
        assert!(CodeCache::new(3).is_none());
        let range = [PhysicalRange { start: 0, len: 4 }];
        assert!(
            CachedBlock::new(Default::default(), Address(0), 0, 4, 0, 1, 0, &range, &[],).is_none()
        );
        assert!(
            CachedBlock::new(Default::default(), Address(0), 0, 4, 1, 0, 0, &range, &[],).is_none()
        );
        assert!(
            CachedBlock::new(
                Default::default(),
                Address(0),
                0,
                4,
                1,
                1,
                0,
                &range,
                &[InstructionPageDependency::default(); 3],
            )
            .is_none()
        );
        assert!(
            CachedBlock::new(
                Default::default(),
                Address(0),
                0,
                4,
                1,
                1,
                0,
                &[
                    PhysicalRange {
                        start: 0,
                        len: u32::MAX - 3,
                    },
                    PhysicalRange { start: 0, len: 8 },
                ],
                &[],
            )
            .is_none()
        );
        assert!(
            CachedBlock::new(Default::default(), Address(2), 0, 4, 1, 1, 0, &range, &[],).is_none()
        );
        assert!(
            CachedBlock::new(
                Default::default(),
                Address(0),
                0,
                65 * 4,
                65,
                65,
                0,
                &[PhysicalRange {
                    start: 0,
                    len: 65 * 4,
                }],
                &[],
            )
            .is_none()
        );
        assert!(
            CachedBlock::new(
                Default::default(),
                Address(0),
                0,
                4,
                1,
                1,
                0,
                &range,
                &[InstructionPageDependency {
                    effective: Address(4),
                    physical: Address(0),
                }],
            )
            .is_none()
        );
    }

    #[test]
    fn generations_and_pc_collisions_never_alias() {
        let mut cache = CodeCache::new(1).unwrap();
        for (index, retained) in [
            block(1, 0x8000_1000, 10),
            block(2, 0x8000_1000, 11),
            block(1, 0x8000_2000, 12),
            block(2, 0x8000_2000, 13),
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(cache.install(retained).way, index as u8);
        }
        assert_eq!(cache.len(), 4);
        assert_eq!(
            cache
                .lookup_validated(AddressSpaceGeneration(2), Address(0x8000_1000), |_| true)
                .unwrap()
                .table_slot,
            11
        );
        assert!(
            cache
                .lookup_validated(AddressSpaceGeneration(3), Address(0x8000_1000), |_| true)
                .is_none()
        );
    }

    #[test]
    fn validation_failure_removes_block_before_dispatch() {
        let dependencies = [InstructionPageDependency {
            effective: Address(0x8123_4000),
            physical: Address(0x0012_3000),
        }];
        let retained = CachedBlock::new(
            AddressSpaceGeneration(7),
            Address(0x8123_4100),
            42,
            16,
            9,
            4,
            3,
            &[PhysicalRange {
                start: 0x0012_3100,
                len: 16,
            }],
            &dependencies,
        )
        .unwrap();
        let mut cache = CodeCache::new(8).unwrap();
        cache.install(retained);

        assert!(
            cache
                .lookup_validated(retained.generation, retained.pc, |actual| {
                    assert_eq!(actual, dependencies);
                    false
                })
                .is_none()
        );
        assert!(cache.is_empty());
        assert!(
            cache
                .lookup_validated(retained.generation, retained.pc, |_| true)
                .is_none()
        );
    }

    #[test]
    fn replacement_and_invalidation_return_table_ownership() {
        let mut cache = CodeCache::new(1).unwrap();
        for slot in 0..4 {
            cache.install(block(1, 0x8000_0000 + slot * 4, slot));
        }
        let replacement = block(1, 0x8000_1000, 99);
        let installed = cache.install(replacement);
        assert_eq!(installed.way, 0);
        assert_eq!(installed.evicted.unwrap().table_slot, 0);
        assert_eq!(cache.len(), 4);

        assert_eq!(
            cache.invalidate(replacement.generation, replacement.pc),
            Some(replacement)
        );
        assert_eq!(cache.len(), 3);
        let removed = cache.invalidate_where(|entry| entry.generation.0 == 1);
        assert_eq!(removed.len(), 3);
        assert!(cache.is_empty());
    }

    #[test]
    fn execution_ranges_cover_virtual_and_physical_wraps() {
        let retained = CachedBlock::new(
            AddressSpaceGeneration(u64::MAX),
            Address(0xffff_fff8),
            7,
            16,
            5,
            4,
            0,
            &[
                PhysicalRange {
                    start: 0x017f_fff8,
                    len: 8,
                },
                PhysicalRange { start: 0, len: 8 },
            ],
            &[],
        )
        .unwrap();

        assert!(retained.covers_effective(Address(0xffff_fffc)));
        assert!(retained.covers_effective(Address(0)));
        assert!(!retained.covers_effective(Address(8)));
        assert!(retained.covers_physical(Address(0x017f_fffc)));
        assert!(retained.covers_physical(Address(4)));
        assert!(!retained.covers_physical(Address(8)));
    }

    fn cold_block(generation: u64, pc: u32) -> ColdBlock {
        ColdBlock::new(
            AddressSpaceGeneration(generation),
            Address(pc),
            12,
            7,
            3,
            0x55,
            &[PhysicalRange {
                start: pc & 0x01ff_ffff,
                len: 12,
            }],
            &[],
        )
        .unwrap()
    }

    fn module_source(ptr: u32) -> WasmModuleSource {
        WasmModuleSource::new(
            SharedSlice {
                ptr: lazuli_abi::SharedPtr(ptr),
                len: 128,
            },
            [ptr.rotate_left(7); 8],
        )
        .unwrap()
    }

    fn receipt(request: CompileRequest, status_raw: u32) -> BlockInstall {
        BlockInstall {
            header: RecordHeader::for_record::<BlockInstall>(),
            request_id: request.request_id,
            table_index: request.table_slot,
            slot_nonce_lo: request.slot_nonce_lo,
            slot_nonce_hi: request.slot_nonce_hi,
            address_space_generation_lo: request.address_space_generation_lo,
            address_space_generation_hi: request.address_space_generation_hi,
            install_token_lo: request.install_token_lo,
            install_token_hi: request.install_token_hi,
            status_raw,
            reserved: 0,
        }
    }

    fn install(
        coordinator: &mut ColdCompileCoordinator,
        generation: u64,
        pc: u32,
        source_ptr: u32,
    ) -> (CompileRequest, CompletedCompile) {
        let emission = coordinator
            .issue_compile(cold_block(generation, pc), module_source(source_ptr))
            .unwrap();
        assert!(emission.retired_slot.is_none());
        let request = emission.host_request;
        let completed = coordinator
            .accept_install(
                receipt(request, BlockInstallStatus::Installed as u32),
                AddressSpaceGeneration(generation),
            )
            .unwrap();
        (request, completed)
    }

    #[test]
    fn shared_request_mutation_cannot_forge_the_private_request() {
        let mut coordinator = ColdCompileCoordinator::new(1, 40, 2).unwrap();
        let emission = coordinator
            .issue_compile(
                cold_block(0x1122_3344_5566_7788, 0x8000_1000),
                module_source(0x2000),
            )
            .unwrap();
        let authentic = emission.host_request;

        // Model a hostile/buggy adapter mutating the shared request and then building a perfectly
        // self-consistent receipt from that forged copy. Acceptance must never consult that copy.
        let mut host_visible = authentic;
        host_visible.request_id ^= 0x100;
        host_visible.table_slot += 1;
        host_visible.slot_nonce_hi ^= 0x8000_0000;
        host_visible.address_space_generation_lo ^= 0x55aa_55aa;
        host_visible.module.ptr.0 += 64;
        host_visible.module_sha256[0] ^= u32::MAX;
        assert_eq!(
            coordinator.accept_install(
                receipt(host_visible, BlockInstallStatus::Installed as u32),
                AddressSpaceGeneration(authentic.address_space_generation()),
            ),
            Err(CompileInstallError::IdentityMismatch)
        );
        assert!(coordinator.has_pending_compile());

        let completed = coordinator
            .accept_install(
                receipt(authentic, BlockInstallStatus::Installed as u32),
                AddressSpaceGeneration(authentic.address_space_generation()),
            )
            .unwrap();
        assert_eq!(completed.block.pc, Address(0x8000_1000));
        assert_eq!(completed.block.pattern, 0x55);
        assert_eq!(completed.block.table_slot, authentic.table_slot);
        assert_eq!(completed.block.slot_nonce, authentic.slot_nonce());
        assert_eq!(coordinator.cache_len(), 1);
        assert_eq!(
            coordinator.accept_install(
                receipt(authentic, BlockInstallStatus::Installed as u32),
                AddressSpaceGeneration(authentic.address_space_generation()),
            ),
            Err(CompileInstallError::NoPendingRequest)
        );
    }

    #[test]
    fn malformed_and_wrong_identity_receipts_never_consume_the_request() {
        let mut coordinator = ColdCompileCoordinator::new(1, 9, 1).unwrap();
        let request = coordinator
            .issue_compile(cold_block(7, 0x8000_2000), module_source(0x3000))
            .unwrap()
            .host_request;

        let mut malformed = receipt(request, BlockInstallStatus::Installed as u32);
        malformed.header.byte_len = 0;
        assert_eq!(
            coordinator.accept_install(malformed, AddressSpaceGeneration(7)),
            Err(CompileInstallError::InvalidRecord)
        );
        let mut wrong_slot = receipt(request, BlockInstallStatus::Installed as u32);
        wrong_slot.table_index ^= 1;
        assert_eq!(
            coordinator.accept_install(wrong_slot, AddressSpaceGeneration(7)),
            Err(CompileInstallError::IdentityMismatch)
        );
        let mut wrong_generation = receipt(request, BlockInstallStatus::Installed as u32);
        wrong_generation.address_space_generation_hi ^= 1;
        assert_eq!(
            coordinator.accept_install(wrong_generation, AddressSpaceGeneration(7)),
            Err(CompileInstallError::IdentityMismatch)
        );
        let mut wrong_nonce = receipt(request, BlockInstallStatus::Installed as u32);
        wrong_nonce.slot_nonce_lo ^= 1;
        assert_eq!(
            coordinator.accept_install(wrong_nonce, AddressSpaceGeneration(7)),
            Err(CompileInstallError::IdentityMismatch)
        );
        assert!(coordinator.has_pending_compile());

        let expected_retirement = TableSlotRetirement {
            table_slot: request.table_slot,
            slot_nonce: request.slot_nonce(),
        };
        assert_eq!(
            coordinator.accept_install(
                receipt(request, BlockInstallStatus::Rejected as u32),
                AddressSpaceGeneration(7),
            ),
            Err(CompileInstallError::HostFailure {
                status: BlockInstallStatus::Rejected,
                retired_slot: expected_retirement,
            })
        );
        assert!(!coordinator.has_pending_compile());
        assert_eq!(coordinator.cache_len(), 0);
        assert_eq!(
            coordinator.accept_install(
                receipt(request, BlockInstallStatus::Installed as u32),
                AddressSpaceGeneration(7),
            ),
            Err(CompileInstallError::NoPendingRequest)
        );
    }

    #[test]
    fn generation_change_and_unknown_status_consume_once_and_retire_the_slot() {
        let mut coordinator = ColdCompileCoordinator::new(1, 70, 1).unwrap();
        let first = coordinator
            .issue_compile(cold_block(3, 0x8000_3000), module_source(0x4000))
            .unwrap()
            .host_request;
        assert_eq!(
            coordinator.accept_install(
                receipt(first, BlockInstallStatus::Installed as u32),
                AddressSpaceGeneration(4),
            ),
            Err(CompileInstallError::AddressSpaceChanged {
                requested: AddressSpaceGeneration(3),
                current: AddressSpaceGeneration(4),
                retired_slot: TableSlotRetirement {
                    table_slot: 70,
                    slot_nonce: first.slot_nonce(),
                },
            })
        );

        let second = coordinator
            .issue_compile(cold_block(4, 0x8000_3000), module_source(0x5000))
            .unwrap()
            .host_request;
        assert_ne!(first.slot_nonce(), second.slot_nonce());
        assert_eq!(
            coordinator.accept_install(receipt(second, 0xffff_fffe), AddressSpaceGeneration(4)),
            Err(CompileInstallError::InvalidStatus {
                status_raw: 0xffff_fffe,
                retired_slot: TableSlotRetirement {
                    table_slot: 70,
                    slot_nonce: second.slot_nonce(),
                },
            })
        );
        assert_eq!(
            coordinator.accept_install(
                receipt(second, BlockInstallStatus::Installed as u32),
                AddressSpaceGeneration(4),
            ),
            Err(CompileInstallError::NoPendingRequest)
        );
    }

    #[test]
    fn slot_rotation_retires_metadata_before_reuse_and_rejects_late_receipts() {
        let mut coordinator = ColdCompileCoordinator::new(1, 12, 1).unwrap();
        let (first_request, first) = install(&mut coordinator, 1, 0x8000_0000, 0x6000);
        let second_emission = coordinator
            .issue_compile(cold_block(1, 0x8000_0004), module_source(0x7000))
            .unwrap();
        assert_eq!(second_emission.evicted.len(), 1);
        assert_eq!(second_emission.evicted[0].block, first.block);
        assert_eq!(second_emission.evicted[0].directory_index, 0);
        assert_eq!(
            second_emission.retired_slot,
            Some(first.block.table_retirement())
        );
        assert_ne!(
            first_request.slot_nonce(),
            second_emission.host_request.slot_nonce()
        );
        assert_eq!(coordinator.cache_len(), 0);

        assert_eq!(
            coordinator.accept_install(
                receipt(first_request, BlockInstallStatus::Installed as u32),
                AddressSpaceGeneration(1),
            ),
            Err(CompileInstallError::IdentityMismatch)
        );
        let second = coordinator
            .accept_install(
                receipt(
                    second_emission.host_request,
                    BlockInstallStatus::Installed as u32,
                ),
                AddressSpaceGeneration(1),
            )
            .unwrap();
        assert_eq!(second.block.table_slot, 12);
        assert_eq!(coordinator.cache_len(), 1);

        let retired = coordinator.cancel_pending();
        assert!(retired.is_none());
        let removed = coordinator.clear();
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].block, second.block);
        assert_eq!(removed[0].directory_index, 0);
        assert!(coordinator.cache_len() == 0);
    }

    #[test]
    fn cache_replacement_exposes_the_displaced_table_slot() {
        let mut coordinator = ColdCompileCoordinator::new(1, 100, 5).unwrap();
        let mut installed = Vec::new();
        for index in 0..4 {
            installed.push(
                install(
                    &mut coordinator,
                    9,
                    0x8000_0000 + index * 4,
                    0x8000 + index * 0x100,
                )
                .1,
            );
        }
        let emission = coordinator
            .issue_compile(cold_block(9, 0x8000_1000), module_source(0x9000))
            .unwrap();
        assert!(emission.retired_slot.is_none());
        let replacement = coordinator
            .accept_install(
                receipt(emission.host_request, BlockInstallStatus::Installed as u32),
                AddressSpaceGeneration(9),
            )
            .unwrap();
        assert_eq!(replacement.evicted.unwrap().block, installed[0].block);
        assert_eq!(replacement.evicted.unwrap().directory_index, 0);
        assert_eq!(
            replacement.retired_slot,
            Some(installed[0].block.table_retirement())
        );
        assert_eq!(coordinator.cache_len(), 4);

        // The freed slot can be rotated into a new request, with a fresh identity.
        let next = coordinator
            .issue_compile(cold_block(9, 0x8000_2000), module_source(0xa000))
            .unwrap();
        assert_eq!(next.host_request.table_slot, installed[0].block.table_slot);
        assert_ne!(
            next.host_request.slot_nonce(),
            installed[0].block.slot_nonce
        );
        assert!(next.retired_slot.is_none());
    }

    #[test]
    fn invalid_sources_ranges_and_identity_exhaustion_fail_closed() {
        assert!(WasmModuleSource::new(SharedSlice::EMPTY, [0; 8]).is_none());
        assert!(ColdCompileCoordinator::new(0, 0, 1).is_none());
        assert!(ColdCompileCoordinator::new(1, u32::MAX, 2).is_none());
        assert!(ColdCompileCoordinator::new(1, 0, 0).is_none());

        let mut coordinator = ColdCompileCoordinator::new(1, 0, 1).unwrap();
        coordinator.next_slot_nonce = Some(u64::MAX);
        let request = coordinator
            .issue_compile(cold_block(1, 0), module_source(0xb000))
            .unwrap()
            .host_request;
        assert_eq!(request.slot_nonce(), u64::MAX);
        assert!(coordinator.cancel_pending().is_some());
        assert_eq!(
            coordinator.issue_compile(cold_block(1, 4), module_source(0xc000)),
            Err(CompileIssueError::IdentityExhausted)
        );
    }

    #[test]
    fn self_install_requires_exact_one_use_identity_and_publishes_directory_index() {
        let mut coordinator = ColdCompileCoordinator::new(2, 3, 1).unwrap();
        let prepared = coordinator
            .prepare_compile(cold_block(7, 0x8000_1000))
            .unwrap();
        let identity = prepared.install_identity;
        let request = coordinator
            .publish_prepared_compile(identity, module_source(0xd000))
            .unwrap();
        assert_eq!(request.install_identity(), identity);
        assert_ne!(request.install_token(), 0);

        let mut wrong = identity;
        wrong.install_token_hi ^= 1;
        assert_eq!(
            coordinator.begin_self_install(wrong, AddressSpaceGeneration(7)),
            Err(SelfInstallError::IdentityMismatch)
        );
        assert_eq!(coordinator.cache_len(), 0);

        coordinator
            .begin_self_install(identity, AddressSpaceGeneration(7))
            .unwrap();
        assert_eq!(
            coordinator.begin_self_install(identity, AddressSpaceGeneration(7)),
            Err(SelfInstallError::InvalidPhase)
        );
        let completed = coordinator
            .commit_self_install(identity, AddressSpaceGeneration(7))
            .unwrap();
        let expected_set = resident_set_index_for_test(2, 7, 0x8000_1000);
        assert_eq!(completed.directory_index, expected_set * 4);
        assert_eq!(completed.block.table_slot, 3);
        assert_eq!(completed.block.slot_nonce, identity.slot_nonce());
        assert_eq!(coordinator.cache_len(), 1);
        assert_eq!(
            coordinator.commit_self_install(identity, AddressSpaceGeneration(7)),
            Err(SelfInstallError::NoPendingRequest)
        );
    }

    #[test]
    fn delayed_module_cannot_overwrite_a_reused_slot_and_trap_stays_unpublished() {
        let mut coordinator = ColdCompileCoordinator::new(1, 20, 1).unwrap();

        let first = coordinator
            .prepare_compile(cold_block(1, 0x8000_0000))
            .unwrap();
        coordinator
            .publish_prepared_compile(first.install_identity, module_source(0xe000))
            .unwrap();
        assert_eq!(
            coordinator.cancel_pending(),
            Some(TableSlotRetirement {
                table_slot: 20,
                slot_nonce: first.install_identity.slot_nonce(),
            })
        );

        let second = coordinator
            .prepare_compile(cold_block(1, 0x8000_0004))
            .unwrap();
        coordinator
            .publish_prepared_compile(second.install_identity, module_source(0xe100))
            .unwrap();
        assert_eq!(
            coordinator.begin_self_install(first.install_identity, AddressSpaceGeneration(1)),
            Err(SelfInstallError::IdentityMismatch)
        );
        coordinator
            .begin_self_install(second.install_identity, AddressSpaceGeneration(1))
            .unwrap();

        // Model a trap after table.set and before commit: no executable cache record exists. A
        // delayed failure for the first module cannot cancel this newer request, while the exact
        // second identity consumes the stranded authorization once.
        assert_eq!(coordinator.cache_len(), 0);
        assert_eq!(
            coordinator.cancel_self_install(first.install_identity),
            Err(SelfInstallError::IdentityMismatch)
        );
        assert_eq!(
            coordinator.cancel_self_install(second.install_identity),
            Ok(TableSlotRetirement {
                table_slot: 20,
                slot_nonce: second.install_identity.slot_nonce(),
            })
        );
        assert_eq!(coordinator.cache_len(), 0);
        assert_eq!(
            coordinator.commit_self_install(second.install_identity, AddressSpaceGeneration(1)),
            Err(SelfInstallError::NoPendingRequest)
        );

        let third = coordinator
            .prepare_compile(cold_block(1, 0x8000_0008))
            .unwrap();
        assert_ne!(
            third.install_identity.slot_nonce(),
            first.install_identity.slot_nonce()
        );
        assert_ne!(
            third.install_identity.install_token(),
            first.install_identity.install_token()
        );
        coordinator
            .publish_prepared_compile(third.install_identity, module_source(0xe200))
            .unwrap();
        assert_eq!(
            coordinator.begin_self_install(first.install_identity, AddressSpaceGeneration(1)),
            Err(SelfInstallError::IdentityMismatch)
        );
    }

    fn resident_set_index_for_test(set_count: u32, generation: u64, pc: u32) -> u32 {
        let folded = generation as u32 ^ (generation >> 32) as u32;
        ((pc >> 2) ^ folded.wrapping_mul(0x9e37_79b9)) & (set_count - 1)
    }
}
