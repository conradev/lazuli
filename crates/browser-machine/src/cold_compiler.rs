//! Rust-owned instruction fetch and resident WebAssembly block preparation.
//!
//! This module is deliberately below every browser boundary. It asks the architected MPC750 MMU
//! for each instruction lazily while the shared PPC frontend consumes the iterator. Consequently
//! an unconditional branch never translates, references, or fills the page containing the next
//! instruction. The resulting physical spans and hashed-page dependencies are exact products of
//! those consumed fetches rather than host-provided compilation metadata.

use core::fmt;

use lazuli::Address;
use lazuli::gekko::disasm::{Extensions, Ins};
use lazuli::runtime::{
    AddressSpaceGeneration, ColdBlock, CompileIssueError, CompilePublishError, IndexedCachedBlock,
    InstructionPageDependency, MAXIMUM_BLOCK_INSTRUCTIONS, TableSlotRetirement, WasmModuleSource,
};
use lazuli::runtime_hooks::HookOutcome;
use lazuli::system::System;
use lazuli::system::mmu::{Translation, TranslationEffect, TranslationFault, TranslationSource};
use lazuli_abi::{
    CompileRequest, PhysicalRange, ResidentBlockInstallIdentity, SharedPtr, SharedSlice,
};
use ppcwasmjit::{BuildError, Exit, Jit, Pattern, PreparedBlock};
use sha2::{Digest, Sha256};

const INSTRUCTION_BYTES: u32 = 4;
const INSTRUCTION_PAGE_BYTES: u32 = 4096;

/// A failed architected instruction fetch, classified before it reaches a browser adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstructionFetchFault {
    /// A guest-visible instruction-storage exception with its exact SRR1 cause bits.
    InstructionStorage {
        effective: Address,
        cause: u32,
        fault: TranslationFault,
    },
    /// Translation infrastructure itself reached unbacked host storage (for example, a PTEG).
    TranslationBacking {
        effective: Address,
        fault: TranslationFault,
    },
    /// Translation succeeded, but the resulting physical instruction word is not executable
    /// RAM or locked-cache storage. This is not silently converted into a zero instruction.
    UnbackedInstruction {
        effective: Address,
        physical: Address,
    },
}

impl InstructionFetchFault {
    fn from_translation(effective: Address, fault: TranslationFault) -> Self {
        match fault.instruction_storage_cause() {
            Some(cause) => Self::InstructionStorage {
                effective,
                cause,
                fault,
            },
            None => Self::TranslationBacking { effective, fault },
        }
    }
}

/// A resident block could not be prepared without losing exact Rust-owned identity.
#[derive(Debug)]
pub enum ColdBlockPreparationError {
    UnalignedPc(Address),
    Fetch(InstructionFetchFault),
    Frontend(BuildError),
    /// The synchronous compiler observed a mapping shape outside the 64-instruction ABI.
    MappingShape,
    /// Frontend metadata did not describe exactly the architecturally fetched prefix.
    InvalidMetadata,
}

/// Rust-owned directory/table identities that must be made unreachable before a returned compile
/// request is installed, or after preparation fails.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ColdCompileRetirements {
    pub blocks: Vec<IndexedCachedBlock>,
    pub reclaimed_slot: Option<TableSlotRetirement>,
    /// Identity reserved for a module that failed before publication. It should already be
    /// unpublished, but returning it lets the caller enforce that invariant without guessing.
    pub cancelled_preparation: Option<TableSlotRetirement>,
}

/// Successful Rust-owned cold compilation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedCompileRequest {
    pub request: CompileRequest,
    pub retirements: ColdCompileRetirements,
}

/// The complete machine-level reason a current-PC request could not be prepared.
#[derive(Debug)]
pub enum PrepareCurrentPcError {
    PendingRequest,
    AddressSpaceSynchronization(HookOutcome),
    Block(ColdBlockPreparationError),
    Coordinator(CompileIssueError),
    SharedModuleUnavailable,
    Publish(CompilePublishError),
}

/// Failure plus every already-retired identity the outer runner must unpublish.
#[derive(Debug)]
pub struct PrepareCurrentPcFailure {
    pub error: PrepareCurrentPcError,
    pub retirements: ColdCompileRetirements,
}

impl fmt::Display for PrepareCurrentPcError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PendingRequest => formatter.write_str("a resident compile is already pending"),
            Self::AddressSpaceSynchronization(outcome) => {
                write!(
                    formatter,
                    "instruction address-space synchronization returned {outcome:?}"
                )
            }
            Self::Block(error) => error.fmt(formatter),
            Self::Coordinator(error) => {
                write!(formatter, "cold coordinator rejected request: {error:?}")
            }
            Self::SharedModuleUnavailable => {
                formatter.write_str("resident module has no valid shared-memory source")
            }
            Self::Publish(error) => {
                write!(formatter, "cold coordinator rejected module: {error:?}")
            }
        }
    }
}

impl std::error::Error for PrepareCurrentPcError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Block(error) => Some(error),
            Self::PendingRequest
            | Self::AddressSpaceSynchronization(_)
            | Self::Coordinator(_)
            | Self::SharedModuleUnavailable
            | Self::Publish(_) => None,
        }
    }
}

impl fmt::Display for ColdBlockPreparationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnalignedPc(pc) => write!(formatter, "unaligned PPC block PC {pc}"),
            Self::Fetch(fault) => write!(formatter, "instruction fetch failed: {fault:?}"),
            Self::Frontend(error) => error.fmt(formatter),
            Self::MappingShape => formatter.write_str("instruction mappings exceed block ABI"),
            Self::InvalidMetadata => {
                formatter.write_str("resident frontend returned inconsistent block metadata")
            }
        }
    }
}

impl std::error::Error for ColdBlockPreparationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Frontend(error) => Some(error),
            Self::UnalignedPc(_) | Self::Fetch(_) | Self::MappingShape | Self::InvalidMetadata => {
                None
            }
        }
    }
}

/// Exact semantic metadata retained alongside an as-yet unissued resident module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedBlockMetadata {
    pub generation: AddressSpaceGeneration,
    pub pc: Address,
    pub effective_bytes: u16,
    pub maximum_cycles: u16,
    pub maximum_instructions: u16,
    pub pattern: Pattern,
    pub exit: Exit,
    instructions: Vec<Ins>,
    physical_ranges: Vec<PhysicalRange>,
    dependencies: Vec<InstructionPageDependency>,
    /// A fault discovered only when the frontend requested the instruction after a nonempty
    /// fallthrough prefix. Executing this block leaves PC at that exact retry boundary.
    following_fetch_fault: Option<InstructionFetchFault>,
}

impl PreparedBlockMetadata {
    pub fn instructions(&self) -> &[Ins] {
        &self.instructions
    }

    pub fn physical_ranges(&self) -> &[PhysicalRange] {
        &self.physical_ranges
    }

    pub fn dependencies(&self) -> &[InstructionPageDependency] {
        &self.dependencies
    }

    pub const fn following_fetch_fault(&self) -> Option<InstructionFetchFault> {
        self.following_fetch_fault
    }
}

/// One Rust-fetched block plus target-independent CLIF.
///
/// Keeping this stage separate from emission is intentional. The typed installer first asks the
/// coordinator for an unforgeable request identity, then emits this exact retained CLIF once with
/// that identity before [`ResidentModule`] hashes it and exposes the bytes to the host.
#[derive(Debug)]
pub struct PreparedColdBlock {
    block: ColdBlock,
    frontend: PreparedBlock,
    metadata: PreparedBlockMetadata,
}

impl PreparedColdBlock {
    pub const fn block(&self) -> ColdBlock {
        self.block
    }

    pub fn metadata(&self) -> &PreparedBlockMetadata {
        &self.metadata
    }
}

/// Exact Rust-owned module storage retained while the browser performs cold compilation.
#[derive(Debug)]
pub struct ResidentModule {
    bytes: Box<[u8]>,
    sha256: [u32; 8],
}

/// Final self-installing module paired with the exact Rust semantic block it represents.
#[derive(Debug)]
pub struct InstallableColdBlock {
    block: ColdBlock,
    module: ResidentModule,
    metadata: PreparedBlockMetadata,
    identity: ResidentBlockInstallIdentity,
}

impl InstallableColdBlock {
    pub const fn block(&self) -> ColdBlock {
        self.block
    }

    pub fn module(&self) -> &ResidentModule {
        &self.module
    }

    pub fn metadata(&self) -> &PreparedBlockMetadata {
        &self.metadata
    }

    pub const fn identity(&self) -> ResidentBlockInstallIdentity {
        self.identity
    }

    pub fn into_parts(
        self,
    ) -> (
        ColdBlock,
        ResidentModule,
        PreparedBlockMetadata,
        ResidentBlockInstallIdentity,
    ) {
        (self.block, self.module, self.metadata, self.identity)
    }
}

impl ResidentModule {
    /// Freezes and hashes the final (including typed-installer decoration) module bytes.
    pub fn new(bytes: Vec<u8>) -> Option<Self> {
        if bytes.is_empty() || bytes.len() > u32::MAX as usize {
            return None;
        }
        let sha256 = sha256_words(&bytes);
        Some(Self {
            bytes: bytes.into_boxed_slice(),
            sha256,
        })
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub const fn sha256(&self) -> [u32; 8] {
        self.sha256
    }

    /// Describes the retained bytes in imported Wasm memory.
    ///
    /// The checked conversion intentionally has no native pointer truncation fallback. Native
    /// vectors use [`Self::source_at`] with an explicit modelled linear-memory offset.
    #[cfg(target_arch = "wasm32")]
    pub fn shared_source(&self) -> Option<WasmModuleSource> {
        self.source_at(SharedPtr(self.bytes.as_ptr() as usize as u32))
    }

    /// Builds a source record for an explicitly assigned linear-memory offset.
    ///
    /// This seam is also used by native contract vectors, where a process pointer is not a Wasm
    /// offset. Production callers use [`Self::shared_source`] instead.
    pub fn source_at(&self, ptr: SharedPtr) -> Option<WasmModuleSource> {
        let len = u32::try_from(self.bytes.len()).ok()?;
        WasmModuleSource::new(SharedSlice { ptr, len }, self.sha256)
    }
}

/// Reusable Rust resident-block frontend.
pub struct RustColdBlockCompiler {
    jit: Jit,
}

impl Default for RustColdBlockCompiler {
    fn default() -> Self {
        Self::new()
    }
}

impl RustColdBlockCompiler {
    pub fn new() -> Self {
        Self {
            jit: Jit::with_slow_memory_rust_resident_hook_cycles(),
        }
    }

    /// Fetches and prepares one target-independent basic block entirely within Rust.
    pub fn prepare(
        &mut self,
        system: &mut System,
        generation: AddressSpaceGeneration,
        pc: Address,
    ) -> Result<PreparedColdBlock, ColdBlockPreparationError> {
        if !pc.value().is_multiple_of(INSTRUCTION_BYTES) {
            return Err(ColdBlockPreparationError::UnalignedPc(pc));
        }

        let mut fetch = ArchitectedInstructionFetch::new(system, pc);
        let prepared = self.jit.prepare(&mut fetch).map_err(|error| {
            if matches!(&error, BuildError::EmptyBlock)
                && let Some(fault) = fetch.fault
            {
                return ColdBlockPreparationError::Fetch(fault);
            }
            ColdBlockPreparationError::Frontend(error)
        })?;

        let frontend = prepared.metadata();
        let maximum_instructions = u16::try_from(frontend.sequence.len())
            .map_err(|_| ColdBlockPreparationError::InvalidMetadata)?;
        let effective_bytes = maximum_instructions
            .checked_mul(INSTRUCTION_BYTES as u16)
            .ok_or(ColdBlockPreparationError::InvalidMetadata)?;
        if fetch.mapping_shape_failed {
            return Err(ColdBlockPreparationError::MappingShape);
        }
        if maximum_instructions == 0
            || maximum_instructions > MAXIMUM_BLOCK_INSTRUCTIONS
            || usize::from(maximum_instructions) != fetch.fetched
            || frontend.executed.instructions != maximum_instructions
        {
            return Err(ColdBlockPreparationError::InvalidMetadata);
        }

        let pattern = frontend.pattern;
        let exit = frontend.exit;
        let maximum_cycles = frontend.executed.cycles;
        let instructions = frontend.sequence.clone();
        let block = ColdBlock::new(
            generation,
            pc,
            effective_bytes,
            maximum_cycles,
            maximum_instructions,
            pattern as u8 as u32,
            &fetch.physical_ranges,
            &fetch.dependencies,
        )
        .ok_or(ColdBlockPreparationError::InvalidMetadata)?;

        let metadata = PreparedBlockMetadata {
            generation,
            pc,
            effective_bytes,
            maximum_cycles,
            maximum_instructions,
            pattern,
            exit,
            instructions,
            physical_ranges: fetch.physical_ranges,
            dependencies: fetch.dependencies,
            following_fetch_fault: fetch.fault,
        };
        Ok(PreparedColdBlock {
            block,
            frontend: prepared,
            metadata,
        })
    }

    /// Finalizes a prepared semantic block with the exact coordinator-issued install identity.
    ///
    /// Guest memory is not fetched again and target-independent translation is not repeated. The
    /// coordinator identity decorates and lowers the retained CLIF directly, so only the final
    /// self-installing Wasm module is ever emitted.
    pub fn finalize_installable(
        &self,
        prepared: PreparedColdBlock,
        identity: ResidentBlockInstallIdentity,
    ) -> Result<InstallableColdBlock, ColdBlockPreparationError> {
        let PreparedColdBlock {
            block,
            frontend,
            metadata,
        } = prepared;

        let built = frontend
            .into_resident_installable(identity)
            .map_err(ColdBlockPreparationError::Frontend)?;
        let rebuilt = built.metadata();
        if rebuilt.sequence != metadata.instructions
            || rebuilt.executed.instructions != metadata.maximum_instructions
            || rebuilt.executed.cycles != metadata.maximum_cycles
            || rebuilt.pattern != metadata.pattern
            || rebuilt.exit != metadata.exit
        {
            return Err(ColdBlockPreparationError::InvalidMetadata);
        }
        let module = ResidentModule::new(built.into_wasm())
            .ok_or(ColdBlockPreparationError::InvalidMetadata)?;
        Ok(InstallableColdBlock {
            block,
            module,
            metadata,
            identity,
        })
    }
}

struct ArchitectedInstructionFetch<'a> {
    system: &'a mut System,
    pc: Address,
    fetched: usize,
    physical_ranges: Vec<PhysicalRange>,
    dependencies: Vec<InstructionPageDependency>,
    fault: Option<InstructionFetchFault>,
    mapping_shape_failed: bool,
}

impl<'a> ArchitectedInstructionFetch<'a> {
    fn new(system: &'a mut System, pc: Address) -> Self {
        Self {
            system,
            pc,
            fetched: 0,
            physical_ranges: Vec::with_capacity(2),
            dependencies: Vec::with_capacity(2),
            fault: None,
            mapping_shape_failed: false,
        }
    }

    fn retain_mapping(&mut self, mapping: Translation) -> Result<(), ()> {
        let effective_page = Address(mapping.effective).align_down(INSTRUCTION_PAGE_BYTES);
        let physical_page = Address(mapping.physical).align_down(INSTRUCTION_PAGE_BYTES);
        if matches!(mapping.source, TranslationSource::Page(_)) {
            if let Some(previous) = self
                .dependencies
                .iter()
                .find(|dependency| dependency.effective == effective_page)
            {
                if previous.physical != physical_page {
                    return Err(());
                }
            } else {
                if self.dependencies.len() == 2 {
                    return Err(());
                }
                self.dependencies.push(InstructionPageDependency {
                    effective: effective_page,
                    physical: physical_page,
                });
            }
        }

        if let Some(last) = self.physical_ranges.last_mut()
            && last.start.checked_add(last.len) == Some(mapping.physical)
        {
            last.len = last.len.checked_add(INSTRUCTION_BYTES).ok_or(())?;
            return Ok(());
        }
        if self.physical_ranges.len() == 2 {
            return Err(());
        }
        self.physical_ranges.push(PhysicalRange {
            start: mapping.physical,
            len: INSTRUCTION_BYTES,
        });
        Ok(())
    }
}

impl Iterator for ArchitectedInstructionFetch<'_> {
    type Item = Ins;

    fn next(&mut self) -> Option<Self::Item> {
        if self.fault.is_some() || self.fetched >= usize::from(MAXIMUM_BLOCK_INSTRUCTIONS) {
            return None;
        }
        let effective = self.pc + (self.fetched as u32).wrapping_mul(INSTRUCTION_BYTES);
        let mapping = match self
            .system
            .translate_instruction_mmu(effective, TranslationEffect::Architectural)
        {
            Ok(mapping) => mapping,
            Err(fault) => {
                self.fault = Some(InstructionFetchFault::from_translation(effective, fault));
                return None;
            }
        };
        let physical = Address(mapping.physical);
        let Some(word) = self.system.read_instruction_phys::<u32>(physical) else {
            self.fault = Some(InstructionFetchFault::UnbackedInstruction {
                effective,
                physical,
            });
            return None;
        };
        if self.retain_mapping(mapping).is_err() {
            // This can only happen if the synchronous address space violates the two-page block
            // ABI. Treat it as an exhausted iterator; `prepare` rejects the inconsistent counts.
            self.mapping_shape_failed = true;
            return None;
        }
        self.fetched += 1;
        Some(Ins::new(word, Extensions::gekko_broadway()))
    }
}

fn sha256_words(bytes: &[u8]) -> [u32; 8] {
    let digest = Sha256::digest(bytes);
    core::array::from_fn(|index| {
        let offset = index * 4;
        u32::from_be_bytes(
            digest[offset..offset + 4]
                .try_into()
                .expect("fixed SHA-256 word"),
        )
    })
}

#[cfg(test)]
mod tests {
    use lazuli::modules::audio::NopAudioModule;
    use lazuli::modules::debug::NopDebugModule;
    use lazuli::modules::disk::NopDiskModule;
    use lazuli::modules::input::NopInputModule;
    use lazuli::modules::render::NopRenderModule;
    use lazuli::modules::vertex::NopVertexModule;
    use lazuli::runtime::{ColdCompileCoordinator, CompileIssueError};
    use lazuli::system::mmu::{Mpc750Mmu, TranslationSource, page_table_vector};
    use lazuli::system::{Config, Modules};
    use lazuli_abi::SharedPtr;
    use wasmparser::{Parser, Payload};

    use super::*;

    const ADDI_R3_R3_1: u32 = 0x3863_0001;
    const BRANCH_TO_SELF: u32 = 0x4800_0000;

    fn test_system() -> System {
        System::new(
            Modules {
                audio: Box::new(NopAudioModule),
                debug: Box::new(NopDebugModule),
                disk: Box::new(NopDiskModule),
                input: Box::new(NopInputModule),
                render: Box::new(NopRenderModule),
                vertex: Box::new(NopVertexModule),
            },
            Config {
                ipl_lle: true,
                ipl: Some(vec![0; lazuli_abi::memory::IPL_BYTES]),
                sideload: None,
                perform_efb_copies: false,
                uart_escape: false,
            },
        )
    }

    fn write_words(system: &mut System, physical: u32, words: &[u32]) {
        for (index, word) in words.iter().copied().enumerate() {
            system.write_phys_slow(Address(physical + index as u32 * 4), word);
        }
    }

    fn enable_hashed_mapping(
        system: &mut System,
        effective_page: u32,
        physical_page: u32,
    ) -> (u32, u32) {
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
        let slot = (0..8)
            .find(|slot| system.read_phys_slow::<u32>(Address(vector.primary_pteg + slot * 8)) == 0)
            .expect("test PTEG has a free slot");
        let pte = vector.primary_pteg + slot * 8;
        system.write_phys_slow(Address(pte), vector.primary_pte0);
        system.write_phys_slow(Address(pte + 4), physical_page | 2);
        (segment, pte + 4)
    }

    fn compile(system: &mut System, pc: u32) -> PreparedColdBlock {
        RustColdBlockCompiler::new()
            .prepare(system, AddressSpaceGeneration(7), Address(pc))
            .unwrap()
    }

    #[test]
    fn real_and_bat_fetches_retain_exact_physical_spans_without_page_dependencies() {
        let mut real = test_system();
        write_words(&mut real, 0x1000, &[ADDI_R3_R3_1, BRANCH_TO_SELF, 0]);
        let real_block = compile(&mut real, 0x1000);
        assert_eq!(real_block.metadata().maximum_instructions, 2);
        assert_eq!(real_block.metadata().effective_bytes, 8);
        assert_eq!(
            real_block.metadata().exit,
            Exit::Branch {
                relative: true,
                indirect: false,
                call: false,
            }
        );
        assert_eq!(
            real_block.metadata().physical_ranges(),
            &[PhysicalRange {
                start: 0x1000,
                len: 8,
            }]
        );
        assert!(real_block.metadata().dependencies().is_empty());

        let mut bat = test_system();
        bat.cpu.supervisor.memory.setup_default_bats();
        bat.cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(true);
        write_words(&mut bat, 0x1000, &[ADDI_R3_R3_1, BRANCH_TO_SELF, 0]);
        assert!(matches!(
            bat.translate_instruction_mmu(Address(0x8000_1000), TranslationEffect::Probe)
                .unwrap()
                .source,
            TranslationSource::Bat { .. }
        ));
        let bat_block = compile(&mut bat, 0x8000_1000);
        assert_eq!(
            bat_block.metadata().physical_ranges(),
            real_block.metadata().physical_ranges()
        );
        assert!(bat_block.metadata().dependencies().is_empty());
    }

    #[test]
    fn hashed_cross_page_fetch_retains_two_ranges_dependencies_and_architectural_history() {
        let mut system = test_system();
        let first_effective = 0x8000_0000;
        let second_effective = 0x8000_1000;
        let first_physical = 0x0001_0000;
        let second_physical = 0x0002_0000;
        let (segment, first_pte1) =
            enable_hashed_mapping(&mut system, first_effective, first_physical);
        let (_, second_pte1) =
            enable_hashed_mapping(&mut system, second_effective, second_physical);
        write_words(&mut system, first_physical + 0xffc, &[ADDI_R3_R3_1]);
        write_words(&mut system, second_physical, &[BRANCH_TO_SELF, 0]);

        let block = compile(&mut system, first_effective + 0xffc);
        assert_eq!(block.metadata().maximum_instructions, 2);
        assert_eq!(
            block.metadata().physical_ranges(),
            &[
                PhysicalRange {
                    start: first_physical + 0xffc,
                    len: 4,
                },
                PhysicalRange {
                    start: second_physical,
                    len: 4,
                },
            ]
        );
        assert_eq!(
            block.metadata().dependencies(),
            &[
                InstructionPageDependency {
                    effective: Address(first_effective),
                    physical: Address(first_physical),
                },
                InstructionPageDependency {
                    effective: Address(second_effective),
                    physical: Address(second_physical),
                },
            ]
        );
        assert_ne!(system.read_phys_slow::<u32>(Address(first_pte1)) & 0x100, 0);
        assert_ne!(
            system.read_phys_slow::<u32>(Address(second_pte1)) & 0x100,
            0
        );
        let first_resident = system
            .mmu
            .resident_instruction(first_effective, segment)
            .unwrap();
        let second_resident = system
            .mmu
            .resident_instruction(second_effective, segment)
            .unwrap();
        assert_eq!(first_resident.location.way, 0);
        assert_eq!(second_resident.location.way, 0);
        assert_eq!(
            system
                .mmu
                .instruction_replacement_way(Mpc750Mmu::tlb_set_index(first_effective)),
            1
        );
        assert_eq!(
            system
                .mmu
                .instruction_replacement_way(Mpc750Mmu::tlb_set_index(second_effective)),
            1
        );
    }

    #[test]
    fn terminal_branch_does_not_translate_or_reference_the_following_page() {
        let mut system = test_system();
        let first_effective = 0x8000_0000;
        let second_effective = 0x8000_1000;
        let first_physical = 0x0001_0000;
        let second_physical = 0x0002_0000;
        let (_, first_pte1) = enable_hashed_mapping(&mut system, first_effective, first_physical);
        let (segment, second_pte1) =
            enable_hashed_mapping(&mut system, second_effective, second_physical);
        write_words(&mut system, first_physical + 0xffc, &[BRANCH_TO_SELF]);
        write_words(&mut system, second_physical, &[ADDI_R3_R3_1]);

        let block = compile(&mut system, first_effective + 0xffc);
        assert_eq!(block.metadata().maximum_instructions, 1);
        assert_eq!(block.metadata().dependencies().len(), 1);
        assert_ne!(system.read_phys_slow::<u32>(Address(first_pte1)) & 0x100, 0);
        assert_eq!(
            system.read_phys_slow::<u32>(Address(second_pte1)) & 0x100,
            0
        );
        assert!(
            system
                .mmu
                .resident_instruction(second_effective, segment)
                .is_none()
        );
    }

    #[test]
    fn instruction_storage_and_unbacked_faults_remain_distinct() {
        let mut isi = test_system();
        isi.cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(true);
        isi.cpu.supervisor.memory.sr[8] = 0x42;
        let error = RustColdBlockCompiler::new()
            .prepare(&mut isi, AddressSpaceGeneration(1), Address(0x8000_0000))
            .unwrap_err();
        assert!(matches!(
            error,
            ColdBlockPreparationError::Fetch(InstructionFetchFault::InstructionStorage {
                effective: Address(0x8000_0000),
                cause: 0x4000_0000,
                fault: TranslationFault::PageFault { .. },
            })
        ));

        let mut unbacked = test_system();
        enable_hashed_mapping(&mut unbacked, 0x8000_0000, 0x1000_0000);
        let error = RustColdBlockCompiler::new()
            .prepare(
                &mut unbacked,
                AddressSpaceGeneration(1),
                Address(0x8000_0000),
            )
            .unwrap_err();
        assert_eq!(
            error_fetch(error),
            InstructionFetchFault::UnbackedInstruction {
                effective: Address(0x8000_0000),
                physical: Address(0x1000_0000),
            }
        );

        let mut boundary = test_system();
        write_words(
            &mut boundary,
            lazuli_abi::memory::MAIN_RAM_BYTES as u32 - 4,
            &[ADDI_R3_R3_1],
        );
        let prefix = compile(&mut boundary, lazuli_abi::memory::MAIN_RAM_BYTES as u32 - 4);
        assert_eq!(prefix.metadata().maximum_instructions, 1);
        assert_eq!(
            prefix.metadata().following_fetch_fault(),
            Some(InstructionFetchFault::UnbackedInstruction {
                effective: Address(lazuli_abi::memory::MAIN_RAM_BYTES as u32),
                physical: Address(lazuli_abi::memory::MAIN_RAM_BYTES as u32),
            })
        );
    }

    fn error_fetch(error: ColdBlockPreparationError) -> InstructionFetchFault {
        match error {
            ColdBlockPreparationError::Fetch(fault) => fault,
            other => panic!("expected fetch fault, got {other:?}"),
        }
    }

    #[test]
    fn final_module_is_rust_hashed_retained_and_coordinator_pending() {
        assert_eq!(
            sha256_words(b"abc"),
            [
                0xba78_16bf,
                0x8f01_cfea,
                0x4141_40de,
                0x5dae_2223,
                0xb003_61a3,
                0x9617_7a9c,
                0xb410_ff61,
                0xf200_15ad,
            ]
        );
        let mut system = test_system();
        write_words(&mut system, 0x1000, &[BRANCH_TO_SELF]);
        let mut compiler = RustColdBlockCompiler::new();
        let prepared = compiler
            .prepare(&mut system, AddressSpaceGeneration(7), Address(0x1000))
            .unwrap();
        let mut coordinator = ColdCompileCoordinator::new(1, 7, 1).unwrap();
        let reservation = coordinator.prepare_compile(prepared.block()).unwrap();
        let finalized = compiler
            .finalize_installable(prepared, reservation.install_identity)
            .unwrap();

        let imports = Parser::new(0)
            .parse_all(finalized.module().bytes())
            .filter_map(|payload| match payload.unwrap() {
                Payload::ImportSection(section) => Some(
                    section
                        .into_imports()
                        .map(|import| import.unwrap().module.to_owned())
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            })
            .flatten()
            .collect::<Vec<_>>();
        assert!(!imports.is_empty());
        assert!(imports.iter().all(|module| module == "lazuli"));
        let exports = Parser::new(0)
            .parse_all(finalized.module().bytes())
            .filter_map(|payload| match payload.unwrap() {
                Payload::ExportSection(section) => Some(
                    section
                        .into_iter()
                        .map(|export| export.unwrap().name.to_owned())
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            })
            .flatten()
            .collect::<Vec<_>>();
        assert!(exports.iter().any(|export| export == "run"));
        assert!(exports.iter().any(|export| export == "install"));

        let expected_digest = Sha256::digest(finalized.module().bytes());
        let expected_words = core::array::from_fn(|index| {
            u32::from_be_bytes(
                expected_digest[index * 4..index * 4 + 4]
                    .try_into()
                    .unwrap(),
            )
        });
        // Do not accept a host-supplied digest: the exact retained Vec is hashed here in Rust.
        assert_eq!(finalized.module().sha256(), expected_words);
        assert_eq!(finalized.identity(), reservation.install_identity);

        let source = finalized
            .module()
            .source_at(SharedPtr(0x0020_0000))
            .unwrap();
        let request = coordinator
            .publish_prepared_compile(finalized.identity(), source)
            .unwrap();
        assert!(coordinator.has_pending_compile());
        assert_eq!(request.install_identity(), reservation.install_identity);
        assert_eq!(request.module.ptr, SharedPtr(0x0020_0000));
        assert_eq!(
            request.module.len as usize,
            finalized.module().bytes().len()
        );
        assert_eq!(request.module_sha256, finalized.module().sha256());

        let second = compile(&mut system, 0x1000);
        assert_eq!(
            coordinator.prepare_compile(second.block()),
            Err(CompileIssueError::PendingRequest)
        );
        // `finalized` retains the exact Vec for the whole pending request.
        assert_eq!(
            sha256_words(finalized.module().bytes()),
            request.module_sha256
        );
    }
}
