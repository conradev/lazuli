//! A PowerPC dynamic recompiler that lowers Cranelift IR into WebAssembly modules.
//!
//! The compiler uses `ppcjit`'s target-independent frontend to translate decoded
//! [`gekko::disasm::Ins`] values into CLIF. Each translated block is stackified into a small
//! WebAssembly module that imports the emulator's linear memory and exports a `run` function with
//! the following signature:
//!
//! ```text
//! run(ctx: i32, cpu: i32, fastmem: i32) -> i32
//! ```
//!
//! `cpu` is the offset of a [`gekko::Cpu`] in the imported memory. The return value packs the number
//! of executed instructions in its lower 16 bits and cycles in its upper 16 bits. `fastmem` points
//! to a WebAssembly-resident LUT of little-endian `i32` page offsets; guest bytes reached through
//! those offsets remain big-endian.

#[cfg(target_arch = "wasm32")]
mod browser_abi;
mod dispatcher;
mod gx_fifo;
mod region;
#[cfg(test)]
mod self_install_tests;

use std::fmt;

pub use clifwasm::LowerError;
use clifwasm::{FunctionSelfInstall, ModuleConfig};
use cranelift_codegen::ir;
use cranelift_codegen::isa::CallConv;
pub use dispatcher::{
    DISPATCH_BASIC_BLOCK_KIND, DISPATCH_CACHE_WAYS, DISPATCH_DEPENDENCY_VALIDATOR_IMPORT,
    DISPATCH_ENTRY_DEPENDENCY_0_EFFECTIVE_OFFSET, DISPATCH_ENTRY_DEPENDENCY_0_PHYSICAL_OFFSET,
    DISPATCH_ENTRY_DEPENDENCY_1_EFFECTIVE_OFFSET, DISPATCH_ENTRY_DEPENDENCY_1_PHYSICAL_OFFSET,
    DISPATCH_ENTRY_DEPENDENCY_COUNT_OFFSET, DISPATCH_ENTRY_GENERATION_HI_OFFSET,
    DISPATCH_ENTRY_GENERATION_LO_OFFSET, DISPATCH_ENTRY_KIND_OFFSET,
    DISPATCH_ENTRY_MAXIMUM_EXECUTED_OFFSET, DISPATCH_ENTRY_NONCE_HI_OFFSET,
    DISPATCH_ENTRY_NONCE_LO_OFFSET, DISPATCH_ENTRY_PC_OFFSET, DISPATCH_ENTRY_READY,
    DISPATCH_ENTRY_SIZE, DISPATCH_ENTRY_STATE_OFFSET, DISPATCH_ENTRY_TABLE_SLOT_OFFSET,
    DISPATCH_MAX_DEPENDENCIES, DISPATCH_RUN_EXPORT, DISPATCH_SLOT_GENERATION_HI_OFFSET,
    DISPATCH_SLOT_GENERATION_LO_OFFSET, DISPATCH_SLOT_IDENTITY_SIZE, DISPATCH_SLOT_NONCE_HI_OFFSET,
    DISPATCH_SLOT_NONCE_LO_OFFSET, DISPATCH_SLOT_PC_OFFSET, DISPATCH_SLOT_READY,
    DISPATCH_SLOT_STATE_OFFSET, DISPATCH_TABLE_EXPORT, DispatchReason, DispatcherConfig,
    DispatcherDependency, DispatcherEntry, DispatcherError, DispatcherSlotIdentity,
    build_resident_dispatcher, resident_dispatcher_set_index,
};
use gekko::disasm::Ins;
pub use gx_fifo::hook_runtime as gx_fifo_hook_runtime;
use lazuli_abi::memory::{
    DISPATCH_SLOT_CAPACITY, RESIDENT_MEMORY_INITIAL_PAGES, RESIDENT_MEMORY_MAXIMUM_PAGES,
};
use lazuli_abi::{ResidentBlockInstallIdentity, ResidentControl, ResidentInstallStatus};
pub use ppcjit::block::Pattern;
use ppcjit::{
    BuildError as PpcBuildError, CodegenSettings, ExitMode, SecondaryFastmemConfig,
    TranslationConfig, TranslationExit, Translator,
};
pub use region::{BLOCK_IMPORT_MODULE, REGION_RUN_EXPORT, RegionBlock, RegionError, link_region};

/// Import module used by generated blocks.
pub const IMPORT_MODULE: &str = "lazuli";
/// Imported linear memory used for CPU and, eventually, guest-memory access.
pub const MEMORY_IMPORT: &str = "memory";
/// Import module used by generated blocks for portable runtime hooks.
///
/// This is the temporary JavaScript-oracle namespace. New resident blocks use
/// [`RESIDENT_HOOK_IMPORT_MODULE`] so every synchronous semantic call resolves directly to the
/// Rust browser machine.
pub const HOOK_IMPORT_MODULE: &str = "lazuli_hooks";
/// Import module used by resident blocks for Rust/Wasm machine hooks.
pub const RESIDENT_HOOK_IMPORT_MODULE: &str = IMPORT_MODULE;
/// Offset at which resident blocks publish the current instruction's start cycle.
pub const RESIDENT_HOOK_CYCLE_OFFSET: i32 =
    core::mem::offset_of!(ResidentControl, instruction_cycle_offset) as i32;
const _: () = assert!(RESIDENT_HOOK_CYCLE_OFFSET == 8);
/// Exported block entry point.
pub const RUN_EXPORT: &str = "run";
/// Export invoked by the browser after compiling and instantiating an exact Rust-issued module.
pub const RESIDENT_INSTALL_EXPORT: &str = "install";
/// Rust/Wasm begin authorization imported by every self-installing resident block.
pub const RESIDENT_INSTALL_BEGIN_IMPORT: &str = "begin_resident_block_install";
/// Rust/Wasm commit authorization imported after the module stores its own `run` reference.
pub const RESIDENT_INSTALL_COMMIT_IMPORT: &str = "commit_resident_block_install";

/// Tagged 4 KiB sidecar layout, relative to the primary fast-memory LUT pointer.
pub const SECONDARY_FASTMEM_PAGE_SHIFT: u8 = 12;
pub const SECONDARY_FASTMEM_SET_COUNT: u32 = 64;
pub const SECONDARY_FASTMEM_ENTRY_COUNT: u32 = SECONDARY_FASTMEM_SET_COUNT * 2;
pub const SECONDARY_FASTMEM_CONTROL_OFFSET: i32 = (ppcjit::FASTMEM_LUT_COUNT * 4) as i32;
pub const SECONDARY_FASTMEM_READ_HITS_OFFSET: i32 = SECONDARY_FASTMEM_CONTROL_OFFSET + 4;
pub const SECONDARY_FASTMEM_WRITE_HITS_OFFSET: i32 = SECONDARY_FASTMEM_CONTROL_OFFSET + 8;
pub const SECONDARY_FASTMEM_MISSES_OFFSET: i32 = SECONDARY_FASTMEM_CONTROL_OFFSET + 12;
pub const SECONDARY_FASTMEM_LRU_OFFSET: i32 = SECONDARY_FASTMEM_CONTROL_OFFSET + 16;
pub const SECONDARY_FASTMEM_TAG_OFFSET: i32 =
    SECONDARY_FASTMEM_LRU_OFFSET + SECONDARY_FASTMEM_SET_COUNT as i32 * 4;
pub const SECONDARY_FASTMEM_READ_POINTER_OFFSET: i32 =
    SECONDARY_FASTMEM_TAG_OFFSET + SECONDARY_FASTMEM_ENTRY_COUNT as i32 * 4;
pub const SECONDARY_FASTMEM_WRITE_POINTER_OFFSET: i32 =
    SECONDARY_FASTMEM_READ_POINTER_OFFSET + SECONDARY_FASTMEM_ENTRY_COUNT as i32 * 4;
pub const SECONDARY_FASTMEM_END_OFFSET: i32 =
    SECONDARY_FASTMEM_WRITE_POINTER_OFFSET + SECONDARY_FASTMEM_ENTRY_COUNT as i32 * 4;

fn browser_secondary_fastmem_config() -> SecondaryFastmemConfig {
    SecondaryFastmemConfig {
        page_shift: SECONDARY_FASTMEM_PAGE_SHIFT,
        set_count: SECONDARY_FASTMEM_SET_COUNT,
        control_offset: SECONDARY_FASTMEM_CONTROL_OFFSET,
        lru_offset: SECONDARY_FASTMEM_LRU_OFFSET,
        tag_offset: SECONDARY_FASTMEM_TAG_OFFSET,
        read_pointer_offset: SECONDARY_FASTMEM_READ_POINTER_OFFSET,
        write_pointer_offset: SECONDARY_FASTMEM_WRITE_POINTER_OFFSET,
        read_hit_count_offset: SECONDARY_FASTMEM_READ_HITS_OFFSET,
        write_hit_count_offset: SECONDARY_FASTMEM_WRITE_HITS_OFFSET,
        miss_count_offset: SECONDARY_FASTMEM_MISSES_OFFSET,
    }
}

fn lower_clif_with_hook_module(
    function: &ir::Function,
    hook_import_module: &str,
    install: Option<(ResidentBlockInstallIdentity, bool)>,
) -> Result<Vec<u8>, LowerError> {
    let config = ModuleConfig::new(IMPORT_MODULE, MEMORY_IMPORT, RUN_EXPORT)
        .with_function_import_module(hook_import_module)
        .with_stack_scratch(0, 0x800, 0x800);
    let mut config = if hook_import_module == RESIDENT_HOOK_IMPORT_MODULE {
        config.with_memory_limits(
            RESIDENT_MEMORY_INITIAL_PAGES as u64,
            Some(RESIDENT_MEMORY_MAXIMUM_PAGES as u64),
        )
    } else {
        config
    };
    if let Some((identity, trap_after_table_set)) = install {
        let identity_words = [
            identity.request_id,
            identity.table_slot,
            identity.slot_nonce_lo,
            identity.slot_nonce_hi,
            identity.address_space_generation_lo,
            identity.address_space_generation_hi,
            identity.install_token_lo,
            identity.install_token_hi,
        ];
        config = config.with_self_install(FunctionSelfInstall {
            table_import_module: IMPORT_MODULE,
            table_import_name: DISPATCH_TABLE_EXPORT,
            begin_import_module: IMPORT_MODULE,
            begin_import_name: RESIDENT_INSTALL_BEGIN_IMPORT,
            commit_import_module: IMPORT_MODULE,
            commit_import_name: RESIDENT_INSTALL_COMMIT_IMPORT,
            install_export_name: RESIDENT_INSTALL_EXPORT,
            identity_words,
            authorized_value: ResidentInstallStatus::Authorized as u32,
            table_unavailable_value: ResidentInstallStatus::TableUnavailable as u32,
            table_minimum: 1,
            table_maximum: Some(DISPATCH_SLOT_CAPACITY as u64),
            trap_after_table_set,
        });
    }
    clifwasm::function(function, &config)
}

/// Lowers portable CLIF with the temporary JavaScript hook-oracle ABI.
///
/// Production migration code should use [`lower_clif_resident`]. This entry point remains while
/// the JavaScript machine is used as a differential correctness oracle.
pub fn lower_clif(function: &ir::Function) -> Result<Vec<u8>, LowerError> {
    lower_clif_with_hook_module(function, HOOK_IMPORT_MODULE, None)
}

/// Lowers portable CLIF with memory and all synchronous hooks in the Rust `lazuli` Wasm module.
///
/// The imported field names and signatures are intentionally unchanged from the shared PPC
/// frontend (`user_0_<HookKind>` and `user_1_0`). Only module ownership changes, which lets the
/// same translated function be compared against the temporary oracle without a semantic fork.
pub fn lower_clif_resident(function: &ir::Function) -> Result<Vec<u8>, LowerError> {
    lower_clif_with_hook_module(function, RESIDENT_HOOK_IMPORT_MODULE, None)
}

/// Lowers an exact Rust-issued block with a typed-table self-installer.
pub fn lower_clif_resident_installable(
    function: &ir::Function,
    identity: ResidentBlockInstallIdentity,
) -> Result<Vec<u8>, LowerError> {
    lower_clif_with_hook_module(
        function,
        RESIDENT_HOOK_IMPORT_MODULE,
        Some((identity, false)),
    )
}

/// Information about the instructions executed by a block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Executed {
    /// Number of guest instructions executed.
    pub instructions: u16,
    /// Estimated guest cycles executed.
    pub cycles: u16,
}

impl Executed {
    /// Packs this value into the ABI returned by [`RUN_EXPORT`].
    pub const fn pack(self) -> u32 {
        (self.cycles as u32) << 16 | self.instructions as u32
    }

    /// Unpacks the ABI value returned by [`RUN_EXPORT`].
    pub const fn unpack(value: u32) -> Self {
        Self {
            instructions: value as u16,
            cycles: (value >> 16) as u16,
        }
    }
}

/// How a compiled block exits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    /// Execution reached the end of the supplied instruction iterator.
    Fallthrough,
    /// A non-branch instruction requested a synchronous runtime exit.
    Synchronous,
    /// Execution ended at an unconditional branch.
    Branch {
        /// Whether the target is relative to the address of the branch.
        relative: bool,
        /// Whether the target came from a register rather than the instruction encoding.
        indirect: bool,
        /// Whether the branch writes the link register.
        call: bool,
    },
}

/// Metadata retained alongside a translated or generated block.
#[derive(Debug, Clone)]
pub struct Metadata {
    /// PowerPC instructions contained in the block.
    pub sequence: Vec<Ins>,
    /// Maximum execution cost for the block.
    pub executed: Executed,
    /// How the block exits.
    pub exit: Exit,
    /// Semantic block pattern detected by the shared PowerPC frontend.
    pub pattern: Pattern,
}

/// A compiled PowerPC basic block represented as a WebAssembly module.
#[derive(Debug, Clone)]
pub struct Block {
    wasm: Vec<u8>,
    metadata: Metadata,
}

impl Block {
    /// Encoded WebAssembly module bytes.
    pub fn wasm(&self) -> &[u8] {
        &self.wasm
    }

    /// Metadata about the compiled PowerPC block.
    pub fn metadata(&self) -> &Metadata {
        &self.metadata
    }

    /// Consumes the block and returns its encoded WebAssembly module.
    pub fn into_wasm(self) -> Vec<u8> {
        self.wasm
    }
}

/// A target-independent PowerPC block retained as Cranelift IR.
///
/// Preparing a block consumes the instruction iterator exactly once but does not emit a
/// WebAssembly module. This lets the Rust browser machine perform architected lazy instruction
/// fetch before it has a coordinator-issued install identity, then lower this exact CLIF once the
/// typed-table identity is available.
#[derive(Debug)]
pub struct PreparedBlock {
    function: ir::Function,
    metadata: Metadata,
}

impl PreparedBlock {
    /// Semantic metadata produced by the same frontend pass as the retained CLIF.
    pub fn metadata(&self) -> &Metadata {
        &self.metadata
    }

    /// The retained target-independent Cranelift function.
    pub fn clif(&self) -> &ir::Function {
        &self.function
    }

    /// Emits this exact prepared block with a typed-table self-installer.
    pub fn into_resident_installable(
        self,
        identity: ResidentBlockInstallIdentity,
    ) -> Result<Block, BuildError> {
        self.lower_with_hook_module(RESIDENT_HOOK_IMPORT_MODULE, Some((identity, false)))
    }

    fn lower_with_hook_module(
        self,
        hook_import_module: &str,
        install: Option<(ResidentBlockInstallIdentity, bool)>,
    ) -> Result<Block, BuildError> {
        let wasm = lower_clif_with_hook_module(&self.function, hook_import_module, install)
            .map_err(BuildError::Lower)?;
        Ok(Block {
            wasm,
            metadata: self.metadata,
        })
    }
}

/// An error produced while compiling a block.
#[derive(Debug)]
pub enum BuildError {
    /// No instructions were supplied.
    EmptyBlock,
    /// The block exceeded the metadata ABI's instruction or cycle capacity.
    BlockTooLong,
    /// The shared PowerPC frontend could not construct CLIF.
    Translation(PpcBuildError),
    /// The generated CLIF uses an operation outside the current WebAssembly subset.
    Lower(LowerError),
}

impl fmt::Display for BuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyBlock => f.write_str("block contains no instructions"),
            Self::BlockTooLong => f.write_str("block exceeds the WebAssembly block ABI limits"),
            Self::Translation(error) => error.fmt(f),
            Self::Lower(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for BuildError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Translation(error) => Some(error),
            Self::Lower(error) => Some(error),
            Self::EmptyBlock | Self::BlockTooLong => None,
        }
    }
}

/// PowerPC to WebAssembly compiler.
pub struct Jit {
    translator: Translator,
    hook_import_module: &'static str,
}

impl Default for Jit {
    fn default() -> Self {
        Self::new()
    }
}

impl Jit {
    /// Creates a new compiler.
    pub fn new() -> Self {
        Self::with_exit_mode(ExitMode::ReturnExecuted)
    }

    /// Creates a compiler whose synchronous hooks bind to the Rust/Wasm browser machine.
    pub fn new_resident() -> Self {
        Self::with_exit_mode_and_hook_cycle_offset(
            ExitMode::ReturnExecuted,
            Some(RESIDENT_HOOK_CYCLE_OFFSET),
            None,
            RESIDENT_HOOK_IMPORT_MODULE,
        )
    }

    /// Creates a compiler whose generated blocks call runtime hooks for unmapped memory pages.
    pub fn with_slow_memory() -> Self {
        Self::with_exit_mode(ExitMode::ReturnExecutedWithSlowMemory)
    }

    /// Creates a resident compiler whose checked memory paths call Rust/Wasm machine hooks.
    pub fn with_slow_memory_resident() -> Self {
        Self::with_slow_memory_resident_hook_cycles()
    }

    /// Creates a resident compiler that publishes exact instruction-start cycles to its
    /// machine-owned [`ResidentControl`] before every semantic hook.
    pub fn with_slow_memory_resident_hook_cycles() -> Self {
        Self::with_exit_mode_and_hook_cycle_offset(
            ExitMode::ReturnExecutedWithSlowMemory,
            Some(RESIDENT_HOOK_CYCLE_OFFSET),
            Some(browser_secondary_fastmem_config()),
            RESIDENT_HOOK_IMPORT_MODULE,
        )
    }

    /// Creates the browser compiler with instruction-start hook-cycle publication enabled.
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn with_slow_memory_hook_cycle_offset(hook_cycle_offset: i32) -> Self {
        Self::with_exit_mode_and_hook_cycle_offset(
            ExitMode::ReturnExecutedWithSlowMemory,
            Some(hook_cycle_offset),
            Some(browser_secondary_fastmem_config()),
            HOOK_IMPORT_MODULE,
        )
    }

    #[cfg(test)]
    fn with_browser_secondary_fastmem() -> Self {
        Self::with_exit_mode_and_hook_cycle_offset(
            ExitMode::ReturnExecutedWithSlowMemory,
            None,
            Some(browser_secondary_fastmem_config()),
            HOOK_IMPORT_MODULE,
        )
    }

    fn with_exit_mode(exit_mode: ExitMode) -> Self {
        Self::with_exit_mode_and_hook_cycle_offset(exit_mode, None, None, HOOK_IMPORT_MODULE)
    }

    fn with_exit_mode_and_hook_cycle_offset(
        exit_mode: ExitMode,
        hook_cycle_offset: Option<i32>,
        secondary_fastmem: Option<SecondaryFastmemConfig>,
        hook_import_module: &'static str,
    ) -> Self {
        let mut config = TranslationConfig::new(
            CodegenSettings::default(),
            ir::types::I32,
            CallConv::Fast,
            exit_mode,
        );
        config.hook_cycle_offset = hook_cycle_offset;
        config.secondary_fastmem = secondary_fastmem;
        Self {
            translator: Translator::new(config),
            hook_import_module,
        }
    }

    /// Compiles one PowerPC basic block.
    ///
    /// Compilation stops after an unconditional branch, matching the native JIT's block boundary.
    pub fn build(
        &mut self,
        instructions: impl IntoIterator<Item = Ins>,
    ) -> Result<Block, BuildError> {
        let hook_import_module = self.hook_import_module;
        self.prepare(instructions)?
            .lower_with_hook_module(hook_import_module, None)
    }

    /// Translates one PowerPC basic block into retained target-independent CLIF.
    ///
    /// This stage performs no WebAssembly emission. Compilation stops after an unconditional
    /// branch, so lazy architectural instruction iterators observe the same exact prefix as
    /// [`Self::build`].
    pub fn prepare(
        &mut self,
        instructions: impl IntoIterator<Item = Ins>,
    ) -> Result<PreparedBlock, BuildError> {
        let translated = match self.translator.translate(instructions.into_iter()) {
            Ok(translated) => translated,
            Err(PpcBuildError::EmptyBlock) => return Err(BuildError::EmptyBlock),
            Err(error) => return Err(BuildError::Translation(error)),
        };

        let pattern = translated.sequence.detect_pattern();
        let instruction_count = translated
            .sequence
            .len()
            .try_into()
            .map_err(|_| BuildError::BlockTooLong)?;
        let executed = Executed {
            instructions: instruction_count,
            cycles: translated.cycles,
        };
        let exit = match translated.exit {
            TranslationExit::Fallthrough => Exit::Fallthrough,
            TranslationExit::Synchronous => Exit::Synchronous,
            TranslationExit::Branch(meta) => Exit::Branch {
                relative: meta.relative(),
                indirect: meta.indirect(),
                call: meta.call(),
            },
        };

        Ok(PreparedBlock {
            function: translated.function,
            metadata: Metadata {
                sequence: translated.sequence.0,
                executed,
                exit,
                pattern,
            },
        })
    }

    /// Compiles one resident block whose module installs its own typed `run` reference.
    pub fn build_resident_installable(
        &mut self,
        instructions: impl IntoIterator<Item = Ins>,
        identity: ResidentBlockInstallIdentity,
    ) -> Result<Block, BuildError> {
        self.prepare(instructions)?
            .into_resident_installable(identity)
    }

    #[cfg(test)]
    fn build_resident_installable_with_trap(
        &mut self,
        instructions: impl IntoIterator<Item = Ins>,
        identity: ResidentBlockInstallIdentity,
    ) -> Result<Block, BuildError> {
        self.prepare(instructions)?
            .lower_with_hook_module(RESIDENT_HOOK_IMPORT_MODULE, Some((identity, true)))
    }
}

#[cfg(test)]
mod tests {
    use std::alloc::Layout;
    use std::mem::size_of;
    use std::process::Command;
    use std::ptr::NonNull;

    use cranelift_codegen::ir::{self, InstBuilder, InstructionData, Opcode};
    use cranelift_codegen::isa::CallConv;
    use gekko::disasm::{Extensions, Ins};
    use gekko::{Address, CondReg, Cpu, FPR, FloatControlReg, FloatPair, GPR, QuantReg, Reg, SPR};
    use ppcjit::block::{BlockFn, Executed as NativeExecuted, ExitReason as NativeExitReason};
    use ppcjit::hooks::{
        Context as NativeContext, ExitData, Hooks, LOAD_RESERVE_FAULT, LOAD_RESERVE_LOADED,
        STORE_CONDITIONAL_FAULT, STORE_CONDITIONAL_NOT_STORED, STORE_CONDITIONAL_STORED,
    };
    use ppcjit::{CodegenSettings, ExitMode, FastmemLut, TranslationConfig, Translator};
    use wasmparser::Validator;

    use super::{
        Block, BuildError, Executed, Exit, Jit, LowerError, Pattern, RegionBlock,
        SECONDARY_FASTMEM_CONTROL_OFFSET, SECONDARY_FASTMEM_LRU_OFFSET,
        SECONDARY_FASTMEM_MISSES_OFFSET, SECONDARY_FASTMEM_PAGE_SHIFT,
        SECONDARY_FASTMEM_READ_HITS_OFFSET, SECONDARY_FASTMEM_READ_POINTER_OFFSET,
        SECONDARY_FASTMEM_SET_COUNT, SECONDARY_FASTMEM_TAG_OFFSET,
        SECONDARY_FASTMEM_WRITE_HITS_OFFSET, SECONDARY_FASTMEM_WRITE_POINTER_OFFSET, link_region,
        lower_clif,
    };

    fn d_form(opcode: u32, rt_or_rs: u8, ra: u8, immediate: u16) -> Ins {
        let code = opcode << 26 | (rt_or_rs as u32) << 21 | (ra as u32) << 16 | immediate as u32;
        Ins::new(code, Extensions::gekko_broadway())
    }

    fn addi(rd: u8, ra: u8, immediate: i16) -> Ins {
        d_form(14, rd, ra, immediate as u16)
    }

    fn addis(rd: u8, ra: u8, immediate: i16) -> Ins {
        d_form(15, rd, ra, immediate as u16)
    }

    fn ori(ra: u8, rs: u8, immediate: u16) -> Ins {
        d_form(24, rs, ra, immediate)
    }

    fn oris(ra: u8, rs: u8, immediate: u16) -> Ins {
        d_form(25, rs, ra, immediate)
    }

    fn xori(ra: u8, rs: u8, immediate: u16) -> Ins {
        d_form(26, rs, ra, immediate)
    }

    fn xoris(ra: u8, rs: u8, immediate: u16) -> Ins {
        d_form(27, rs, ra, immediate)
    }

    fn lwz(rd: u8, ra: u8, displacement: i16) -> Ins {
        d_form(32, rd, ra, displacement as u16)
    }

    fn lbz(rd: u8, ra: u8, displacement: i16) -> Ins {
        d_form(34, rd, ra, displacement as u16)
    }

    fn lhz(rd: u8, ra: u8, displacement: i16) -> Ins {
        d_form(40, rd, ra, displacement as u16)
    }

    fn stw(rs: u8, ra: u8, displacement: i16) -> Ins {
        d_form(36, rs, ra, displacement as u16)
    }

    fn lwarx(rd: u8, ra: u8, rb: u8) -> Ins {
        let code =
            31 << 26 | u32::from(rd) << 21 | u32::from(ra) << 16 | u32::from(rb) << 11 | 20 << 1;
        Ins::new(code, Extensions::gekko_broadway())
    }

    fn stwcx(rs: u8, ra: u8, rb: u8) -> Ins {
        let code = 31 << 26
            | u32::from(rs) << 21
            | u32::from(ra) << 16
            | u32::from(rb) << 11
            | 150 << 1
            | 1;
        Ins::new(code, Extensions::gekko_broadway())
    }

    fn stb(rs: u8, ra: u8, displacement: i16) -> Ins {
        d_form(38, rs, ra, displacement as u16)
    }

    fn sth(rs: u8, ra: u8, displacement: i16) -> Ins {
        d_form(44, rs, ra, displacement as u16)
    }

    fn psq(opcode: u32, fr: u8, ra: u8, displacement: i16, w: bool, gqr: u8) -> Ins {
        let code = opcode << 26
            | u32::from(fr) << 21
            | u32::from(ra) << 16
            | u32::from(w) << 15
            | u32::from(gqr & 7) << 12
            | u32::from(displacement as u16 & 0x0fff);
        Ins::new(code, Extensions::gekko_broadway())
    }

    fn psq_l(fr: u8, ra: u8, displacement: i16, w: bool, gqr: u8) -> Ins {
        psq(56, fr, ra, displacement, w, gqr)
    }

    fn psq_st(fr: u8, ra: u8, displacement: i16, w: bool, gqr: u8) -> Ins {
        psq(60, fr, ra, displacement, w, gqr)
    }

    fn mtspr(rs: u8, spr: u16) -> Ins {
        let encoded_spr = (u32::from(spr) & 0x1f) << 16 | (u32::from(spr) >> 5) << 11;
        let code = 31 << 26 | u32::from(rs) << 21 | encoded_spr | 467 << 1;
        Ins::new(code, Extensions::gekko_broadway())
    }

    fn mcrfs(crfd: u8, crfs: u8) -> Ins {
        let code = 63 << 26 | u32::from(crfd) << 23 | u32::from(crfs) << 18 | 64 << 1;
        Ins::new(code, Extensions::gekko_broadway())
    }

    fn creqv(crbd: u8, crba: u8, crbb: u8) -> Ins {
        let code = 19 << 26
            | u32::from(crbd) << 21
            | u32::from(crba) << 16
            | u32::from(crbb) << 11
            | 289 << 1;
        Ins::new(code, Extensions::gekko_broadway())
    }

    fn fnabs(frt: u8, frb: u8, record: bool) -> Ins {
        let code =
            63 << 26 | u32::from(frt) << 21 | u32::from(frb) << 11 | 136 << 1 | u32::from(record);
        Ins::new(code, Extensions::gekko_broadway())
    }

    fn ps_arithmetic(fd: u8, fa: u8, fc: u8, fb: u8, subopcode: u8) -> Ins {
        let code = 4 << 26
            | u32::from(fd) << 21
            | u32::from(fa) << 16
            | u32::from(fb) << 11
            | u32::from(fc) << 6
            | u32::from(subopcode) << 1;
        Ins::new(code, Extensions::gekko_broadway())
    }

    fn ps_add(fd: u8, fa: u8, fb: u8) -> Ins {
        ps_arithmetic(fd, fa, 0, fb, 21)
    }

    fn ps_div(fd: u8, fa: u8, fb: u8) -> Ins {
        ps_arithmetic(fd, fa, 0, fb, 18)
    }

    fn ps_mul(fd: u8, fa: u8, fc: u8) -> Ins {
        ps_arithmetic(fd, fa, fc, 0, 25)
    }

    fn ps_madd(fd: u8, fa: u8, fc: u8, fb: u8) -> Ins {
        ps_arithmetic(fd, fa, fc, fb, 29)
    }

    fn ps_madds0(fd: u8, fa: u8, fc: u8, fb: u8) -> Ins {
        ps_arithmetic(fd, fa, fc, fb, 14)
    }

    fn ps_madds1(fd: u8, fa: u8, fc: u8, fb: u8) -> Ins {
        ps_arithmetic(fd, fa, fc, fb, 15)
    }

    fn ps_msub(fd: u8, fa: u8, fc: u8, fb: u8) -> Ins {
        ps_arithmetic(fd, fa, fc, fb, 28)
    }

    fn ps_muls0(fd: u8, fa: u8, fc: u8) -> Ins {
        ps_arithmetic(fd, fa, fc, 0, 12)
    }

    fn ps_muls1(fd: u8, fa: u8, fc: u8) -> Ins {
        ps_arithmetic(fd, fa, fc, 0, 13)
    }

    fn ps_nmadd(fd: u8, fa: u8, fc: u8, fb: u8) -> Ins {
        ps_arithmetic(fd, fa, fc, fb, 31)
    }

    fn ps_nmsub(fd: u8, fa: u8, fc: u8, fb: u8) -> Ins {
        ps_arithmetic(fd, fa, fc, fb, 30)
    }

    fn ps_sum0(fd: u8, fa: u8, fc: u8, fb: u8) -> Ins {
        ps_arithmetic(fd, fa, fc, fb, 10)
    }

    fn conditional_branch(bo: u8, bi: u8, displacement: i16) -> Ins {
        let code = 16 << 26
            | u32::from(bo) << 21
            | u32::from(bi) << 16
            | (u32::from(displacement as u16) & 0xfffc);
        Ins::new(code, Extensions::gekko_broadway())
    }

    fn branch(displacement: i32, absolute: bool, link: bool) -> Ins {
        let code =
            18 << 26 | (displacement as u32 & 0x03ff_fffc) | (absolute as u32) << 1 | link as u32;
        Ins::new(code, Extensions::gekko_broadway())
    }

    fn unconditional_bc(displacement: i16) -> Ins {
        let code = 16 << 26 | 20 << 21 | (displacement as u32 & 0xfffc);
        Ins::new(code, Extensions::gekko_broadway())
    }

    fn branch_to_link_register() -> Ins {
        Ins::new(0x4e80_0020, Extensions::gekko_broadway())
    }

    struct NativeState {
        cpu: Cpu,
        fastmem: Box<FastmemLut>,
        guest_page: Box<[u8]>,
        exit_reason: Option<NativeExitReason>,
        executed: Option<NativeExecuted>,
    }

    impl NativeState {
        const GUEST_BASE: u32 = 0x8000_0000;

        fn new() -> Self {
            let fastmem = vec![None; ppcjit::FASTMEM_LUT_COUNT].into_boxed_slice();
            let mut fastmem: Box<FastmemLut> = match fastmem.try_into() {
                Ok(fastmem) => fastmem,
                Err(_) => unreachable!("fastmem LUT length is constant"),
            };
            let mut guest_page = vec![0; 1 << 17].into_boxed_slice();
            fastmem[(0x8000_0000u32 >> 17) as usize] = NonNull::new(guest_page.as_mut_ptr());

            Self {
                cpu: Cpu::default(),
                fastmem,
                guest_page,
                exit_reason: None,
                executed: None,
            }
        }

        fn guest_offset(address: Address, size: usize) -> Option<usize> {
            let offset = address.value().checked_sub(Self::GUEST_BASE)? as usize;
            offset
                .checked_add(size)
                .filter(|&end| end <= 1 << 17)
                .map(|_| offset)
        }

        fn read_guest_word(&self, address: Address) -> u32 {
            let offset = Self::guest_offset(address, size_of::<u32>()).unwrap();
            u32::from_be_bytes(
                self.guest_page[offset..offset + size_of::<u32>()]
                    .try_into()
                    .unwrap(),
            )
        }

        fn write_guest_word(&mut self, address: Address, value: u32) {
            let offset = Self::guest_offset(address, size_of::<u32>()).unwrap();
            self.guest_page[offset..offset + size_of::<u32>()]
                .copy_from_slice(&value.to_be_bytes());
        }
    }

    extern "C-unwind" fn get_registers(ctx: *mut NativeContext) -> *mut Cpu {
        let state = unsafe { &mut *ctx.cast::<NativeState>() };
        &raw mut state.cpu
    }

    extern "C-unwind" fn get_fastmem(ctx: *mut NativeContext) -> *mut FastmemLut {
        let state = unsafe { &mut *ctx.cast::<NativeState>() };
        state.fastmem.as_mut()
    }

    extern "C-unwind" fn exit(
        ctx: *const NativeContext,
        _data: *mut ExitData,
        reason: NativeExitReason,
        executed: NativeExecuted,
    ) -> Option<BlockFn> {
        let state = unsafe { &mut *(ctx as *mut NativeState) };
        state.exit_reason = Some(reason);
        state.executed = Some(executed);
        None
    }

    extern "C-unwind" fn unexpected_read<T>(
        _ctx: *mut NativeContext,
        _addr: Address,
        _value: *mut T,
    ) -> u8 {
        panic!("unexpected native JIT read hook")
    }

    extern "C-unwind" fn unexpected_write<T>(
        _ctx: *mut NativeContext,
        _addr: Address,
        _value: T,
    ) -> bool {
        panic!("unexpected native JIT write hook")
    }

    extern "C-unwind" fn load_reserve(
        ctx: *mut NativeContext,
        address: Address,
        value: *mut i32,
    ) -> u8 {
        let state = unsafe { &mut *ctx.cast::<NativeState>() };
        let Some(offset) = NativeState::guest_offset(address, size_of::<i32>()) else {
            return LOAD_RESERVE_FAULT;
        };
        let bytes = state.guest_page[offset..offset + size_of::<i32>()]
            .try_into()
            .unwrap();
        unsafe { value.write(i32::from_be_bytes(bytes)) };
        state.cpu.reservation.reserve(Address(offset as u32));
        LOAD_RESERVE_LOADED
    }

    extern "C-unwind" fn store_conditional(
        ctx: *mut NativeContext,
        address: Address,
        value: i32,
    ) -> u8 {
        let state = unsafe { &mut *ctx.cast::<NativeState>() };
        let Some(offset) = NativeState::guest_offset(address, size_of::<i32>()) else {
            return STORE_CONDITIONAL_FAULT;
        };
        if !state.cpu.reservation.clear() {
            return STORE_CONDITIONAL_NOT_STORED;
        }

        state.guest_page[offset..offset + size_of::<i32>()].copy_from_slice(&value.to_be_bytes());
        STORE_CONDITIONAL_STORED
    }

    extern "C-unwind" fn unexpected_read_quantized(
        _ctx: *mut NativeContext,
        _addr: Address,
        _gqr: QuantReg,
        _value: *mut f64,
    ) -> u8 {
        panic!("unexpected native JIT quantized read hook")
    }

    extern "C-unwind" fn unexpected_write_quantized(
        _ctx: *mut NativeContext,
        _addr: Address,
        _gqr: QuantReg,
        _value: f64,
    ) -> u8 {
        panic!("unexpected native JIT quantized write hook")
    }

    extern "C-unwind" fn unexpected_invalidate(_ctx: *mut NativeContext, _addr: Address) {
        panic!("unexpected native JIT invalidate hook")
    }

    extern "C-unwind" fn unexpected_generic(_ctx: *mut NativeContext) {
        panic!("unexpected native JIT generic hook")
    }

    fn native_hooks() -> Hooks {
        Hooks {
            get_registers,
            get_fastmem,
            exit,
            read_i8: unexpected_read::<i8>,
            write_i8: unexpected_write::<i8>,
            read_i16: unexpected_read::<i16>,
            write_i16: unexpected_write::<i16>,
            read_i32: unexpected_read::<i32>,
            write_i32: unexpected_write::<i32>,
            read_i64: unexpected_read::<i64>,
            write_i64: unexpected_write::<i64>,
            load_reserve,
            store_conditional,
            read_quantized: unexpected_read_quantized,
            write_quantized: unexpected_write_quantized,
            invalidate_icache: unexpected_invalidate,
            tlbie: unexpected_invalidate,
            tlbsync: unexpected_generic,
            clear_icache: unexpected_generic,
            dcache_dma: unexpected_generic,
            msr_changed: unexpected_generic,
            sr_changed: unexpected_generic,
            sdr1_changed: unexpected_generic,
            ibat_changed: unexpected_generic,
            dbat_changed: unexpected_generic,
            tb_read: unexpected_generic,
            tb_changed: unexpected_generic,
            dec_read: unexpected_generic,
            dec_changed: unexpected_generic,
        }
    }

    fn execute_with_native_jit_initialized(
        sequence: &[Ins],
        pc: u32,
        r3: u32,
        initialize: impl FnOnce(&mut NativeState),
    ) -> NativeState {
        let mut jit = ppcjit::Jit::new(
            ppcjit::Settings {
                codegen: ppcjit::CodegenSettings::default(),
                exit_data_layout: Layout::new::<usize>(),
                cache_path: None,
            },
            native_hooks(),
        );
        let block = jit.build(sequence.iter().copied()).unwrap();

        let mut state = NativeState::new();
        state.cpu.pc = Address(pc);
        state.cpu.user.gpr[3] = r3;
        initialize(&mut state);
        let context: *mut NativeContext = (&raw mut state).cast();
        unsafe { jit.call(context, block.as_ptr()) };

        state
    }

    fn execute_with_native_jit(sequence: &[Ins], pc: u32, r3: u32) -> NativeState {
        execute_with_native_jit_initialized(sequence, pc, r3, |_| {})
    }

    fn assert_wasm_execution(
        wasm: &[u8],
        initial_pc: u32,
        initial_r3: u32,
        expected_executed: u32,
        expected_pc: u32,
        expected_r4: u32,
        expected_lr: u32,
    ) {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
            return;
        }

        let hex = wasm
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let script = r#"
const [hex, pcOffset, r3Offset, r4Offset, lrOffset, initialPc, initialR3, expectedExecuted, expectedPc, expectedR4, expectedLr] = process.argv.slice(1);
const bytes = Buffer.from(hex, "hex");
const memory = new WebAssembly.Memory({ initial: 1 });
const { instance } = await WebAssembly.instantiate(bytes, { lazuli: { memory } });
const cpu = 64;
const view = new DataView(memory.buffer);
view.setUint32(cpu + Number(pcOffset), Number(initialPc), true);
view.setUint32(cpu + Number(r3Offset), Number(initialR3), true);
view.setUint32(cpu + Number(r4Offset), 0xdeadbeef, true);
const executed = instance.exports.run(0, cpu, 0) >>> 0;
if (executed !== (Number(expectedExecuted) >>> 0)) throw new Error(`bad execution metadata: 0x${executed.toString(16)}`);
const pc = view.getUint32(cpu + Number(pcOffset), true);
if (pc !== (Number(expectedPc) >>> 0)) throw new Error(`bad pc: 0x${pc.toString(16)}`);
const r4 = view.getUint32(cpu + Number(r4Offset), true);
if (r4 !== (Number(expectedR4) >>> 0)) throw new Error(`bad r4: 0x${r4.toString(16)}`);
const lr = view.getUint32(cpu + Number(lrOffset), true);
if (lr !== (Number(expectedLr) >>> 0)) throw new Error(`bad lr: 0x${lr.toString(16)}`);
"#;

        let output = Command::new("node")
            .args([
                "--input-type=module",
                "--eval",
                script,
                &hex,
                &Reg::PC.offset().to_string(),
                &GPR::R3.offset().to_string(),
                &GPR::R4.offset().to_string(),
                &SPR::LR.offset().to_string(),
                &initial_pc.to_string(),
                &initial_r3.to_string(),
                &expected_executed.to_string(),
                &expected_pc.to_string(),
                &expected_r4.to_string(),
                &expected_lr.to_string(),
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

    type PairedBits = (u8, [u64; 2]);

    fn assert_paired_float_execution(
        sequence: &[Ins],
        inputs: &[PairedBits],
        expected: &[PairedBits],
    ) {
        let block = Jit::new().build(sequence.iter().copied()).unwrap();
        Validator::new().validate_all(block.wasm()).unwrap();

        let native = execute_with_native_jit_initialized(sequence, 0x8000_1000, 0, |state| {
            state.cpu.supervisor.config.msr = state
                .cpu
                .supervisor
                .config
                .msr
                .clone()
                .with_float_available(true);
            for &(register, bits) in inputs {
                state.cpu.user.fpr[usize::from(register)] =
                    FloatPair([f64::from_bits(bits[0]), f64::from_bits(bits[1])]);
            }
        });
        for &(register, expected_bits) in expected {
            assert_eq!(
                [
                    native.cpu.user.fpr[usize::from(register)][0].to_bits(),
                    native.cpu.user.fpr[usize::from(register)][1].to_bits(),
                ],
                expected_bits,
                "unexpected paired-single bits in f{register}",
            );
        }

        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
            return;
        }

        let wasm = block
            .wasm()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let encode_records = |records: &[PairedBits]| {
            records
                .iter()
                .map(|(register, bits)| format!("{register},{},{}", bits[0], bits[1]))
                .collect::<Vec<_>>()
                .join(";")
        };
        let input_records = encode_records(inputs);
        let expected_records = encode_records(expected);
        let script = r#"
const [wasmHex, pcOffset, msrOffset, fprBaseOffset, initialMsr, expectedExecuted, expectedPc, inputRecords, expectedRecords] = process.argv.slice(1);
const memory = new WebAssembly.Memory({ initial: 1 });
const view = new DataView(memory.buffer);
const cpu = 64;
const records = value => value.split(";").filter(Boolean).map(record => record.split(","));
view.setUint32(cpu + Number(pcOffset), 0x80001000, true);
view.setUint32(cpu + Number(msrOffset), Number(initialMsr), true);
for (const [register, bits0, bits1] of records(inputRecords)) {
  const offset = Number(fprBaseOffset) + Number(register) * 16;
  view.setBigUint64(cpu + offset, BigInt(bits0), true);
  view.setBigUint64(cpu + offset + 8, BigInt(bits1), true);
}
const { instance } = await WebAssembly.instantiate(Buffer.from(wasmHex, "hex"), {
  lazuli: { memory },
  lazuli_hooks: { user_1_0() { throw new Error("unexpected floating-point exception"); } },
});
const executed = instance.exports.run(0, cpu, 0) >>> 0;
if (executed !== (Number(expectedExecuted) >>> 0)) throw new Error(`bad execution metadata: 0x${executed.toString(16)}`);
const pc = view.getUint32(cpu + Number(pcOffset), true);
if (pc !== (Number(expectedPc) >>> 0)) throw new Error(`bad pc: 0x${pc.toString(16)}`);
for (const [register, bits0, bits1] of records(expectedRecords)) {
  const offset = Number(fprBaseOffset) + Number(register) * 16;
  const actual0 = view.getBigUint64(cpu + offset, true);
  const actual1 = view.getBigUint64(cpu + offset + 8, true);
  const expected0 = BigInt(bits0);
  const expected1 = BigInt(bits1);
  if (actual0 !== expected0 || actual1 !== expected1) {
    throw new Error(`bad paired-single bits in f${register}: [0x${actual0.toString(16)}, 0x${actual1.toString(16)}]`);
  }
}
"#;
        let output = Command::new("node")
            .args([
                "--input-type=module",
                "--eval",
                script,
                &wasm,
                &Reg::PC.offset().to_string(),
                &Reg::MSR.offset().to_string(),
                &FPR::R0.offset().to_string(),
                &native.cpu.supervisor.config.msr.to_bits().to_string(),
                &block.metadata().executed.pack().to_string(),
                &native.cpu.pc.value().to_string(),
                &input_records,
                &expected_records,
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
    fn emits_valid_wasm_for_integer_block() {
        let block = Jit::new()
            .build([addi(4, 3, -2), oris(4, 4, 0xabcd)])
            .unwrap();

        Validator::new().validate_all(block.wasm()).unwrap();
        assert_eq!(
            block.metadata().executed,
            Executed {
                instructions: 2,
                cycles: 3,
            }
        );
        assert_eq!(block.metadata().exit, Exit::Fallthrough);
    }

    #[test]
    fn stops_at_unconditional_branch() {
        let block = Jit::new()
            .build([addi(3, 3, 1), branch(8, false, true), addi(3, 3, 1)])
            .unwrap();

        Validator::new().validate_all(block.wasm()).unwrap();
        assert_eq!(block.metadata().sequence.len(), 2);
        assert_eq!(
            block.metadata().executed,
            Executed {
                instructions: 2,
                cycles: 4,
            }
        );
        assert_eq!(
            block.metadata().exit,
            Exit::Branch {
                relative: true,
                indirect: false,
                call: true,
            }
        );
    }

    #[test]
    fn preserves_semantic_idle_pattern() {
        let block = Jit::new().build([branch(0, false, false)]).unwrap();

        assert_eq!(block.metadata().pattern, Pattern::IdleBasic);
    }

    #[test]
    fn validates_256_block_linked_region() {
        let blocks = (0..256)
            .map(|index| RegionBlock {
                pc: 0x8000_1000 + index * 4,
                maximum_cycles: 4,
            })
            .collect::<Vec<_>>();
        let region = link_region(&blocks).unwrap();

        Validator::new().validate_all(&region).unwrap();
    }

    #[test]
    fn executes_balanced_linked_region_with_unsorted_blocks() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
            return;
        }

        let block = Jit::new().build([branch(0x1000, false, false)]).unwrap();
        let maximum_cycles = block.metadata().executed.cycles;
        let expected_instructions = u32::from(block.metadata().executed.instructions) * 3;
        let expected_cycles = u32::from(maximum_cycles) * 3;
        let region = link_region(&[
            RegionBlock {
                pc: 0x8000_3000,
                maximum_cycles,
            },
            RegionBlock {
                pc: 0x8000_1000,
                maximum_cycles,
            },
            RegionBlock {
                pc: 0x8000_2000,
                maximum_cycles,
            },
        ])
        .unwrap();
        Validator::new().validate_all(&region).unwrap();

        let block_wasm = block
            .wasm()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let region_wasm = region
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let script = r#"
const [blockHex, regionHex, pcOffsetText, maximumCyclesText, expectedInstructionsText, expectedCyclesText] = process.argv.slice(1);
const memory = new WebAssembly.Memory({ initial: 8 });
const view = new DataView(memory.buffer);
const cpu = 64;
const control = 0x2000;
const blockContext = 0x2100;
const pcOffset = Number(pcOffsetText);
const maximumCycles = Number(maximumCyclesText);
const expectedInstructions = Number(expectedInstructionsText);
const expectedCycles = Number(expectedCyclesText);
const blockBytes = Buffer.from(blockHex, "hex");
const { instance: blockInstance } = await WebAssembly.instantiate(blockBytes, {
  lazuli: { memory },
});
const blockCyclePrefixes = [];
function observedBlock(ctx, registers, fastmem) {
  if (ctx !== blockContext) throw new Error(`region forwarded wrong block context: ${ctx}`);
  const hookCycleOffset = view.getUint32(control + 8, true);
  if (hookCycleOffset !== 0) {
    throw new Error(`region did not reset hook-cycle offset: ${hookCycleOffset}`);
  }
  blockCyclePrefixes.push(view.getUint32(control, true));
  view.setUint32(control + 8, 0xfeedbeef, true);
  return blockInstance.exports.run(ctx, registers, fastmem);
}
const { instance: regionInstance } = await WebAssembly.instantiate(
  Buffer.from(regionHex, "hex"),
  {
    lazuli: { memory },
    lazuli_blocks: {
      b0: observedBlock,
      b1: observedBlock,
      b2: observedBlock,
    },
  },
);
const run = regionInstance.exports.run;

function reset(pc) {
  view.setUint32(cpu + pcOffset, pc, true);
  view.setUint32(control, 0, true);
  view.setUint32(control + 4, 0, true);
  view.setUint32(control + 8, 0xfeedbeef, true);
  blockCyclePrefixes.length = 0;
}
function expectResult(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: got ${actual.join(",")}, expected ${expected.join(",")}`);
  }
}

reset(0x80001000);
expectResult(
  run(blockContext, cpu, 0, pcOffset, control, expectedCycles, 10),
  [expectedInstructions, expectedCycles, 3],
  "full region",
);
if (view.getUint32(cpu + pcOffset, true) !== 0x80004000) {
  throw new Error("full region ended at the wrong PC");
}
expectResult(
  blockCyclePrefixes,
  [0, maximumCycles, maximumCycles * 2],
  "full-region cycle prefixes",
);

reset(0x80001000);
expectResult(
  run(blockContext, cpu, 0, pcOffset, control, expectedCycles, 2),
  [expectedInstructions / 3 * 2, expectedCycles / 3 * 2, 2],
  "block budget",
);
if (view.getUint32(cpu + pcOffset, true) !== 0x80003000) {
  throw new Error("block-budget run ended at the wrong PC");
}
expectResult(blockCyclePrefixes, [0, maximumCycles], "block-budget cycle prefixes");

reset(0x80001000);
expectResult(
  run(blockContext, cpu, 0, pcOffset, control, maximumCycles - 1, 10),
  [0, 0, 0],
  "cycle budget",
);
if (view.getUint32(cpu + pcOffset, true) !== 0x80001000) {
  throw new Error("cycle-budget run changed the PC");
}

reset(0x80001500);
expectResult(
  run(blockContext, cpu, 0, pcOffset, control, expectedCycles, 10),
  [0, 0, 0],
  "missing PC",
);
if (view.getUint32(cpu + pcOffset, true) !== 0x80001500) {
  throw new Error("missing-PC run changed the PC");
}
"#;
        let output = Command::new("node")
            .args([
                "--input-type=module",
                "--eval",
                script,
                &block_wasm,
                &region_wasm,
                &Reg::PC.offset().to_string(),
                &maximum_cycles.to_string(),
                &expected_instructions.to_string(),
                &expected_cycles.to_string(),
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
    fn rejects_an_empty_block() {
        assert!(matches!(Jit::new().build([]), Err(BuildError::EmptyBlock)));
    }

    #[test]
    fn executes_with_the_browser_webassembly_api() {
        let sequence = [
            addi(4, 3, -2),
            addis(4, 4, 0x1234),
            ori(4, 4, 0x00f0),
            oris(4, 4, 0xabcd),
            xori(4, 4, 0x0f0f),
            xoris(4, 4, 0x1357),
        ];
        let block = Jit::new().build(sequence).unwrap();
        let native = execute_with_native_jit(&sequence, 0x8000_1000, 7);
        let native_executed = native.executed.expect("native JIT did not exit");
        let expected_executed = Executed {
            instructions: native_executed.instructions,
            cycles: native_executed.cycles,
        }
        .pack();
        assert_wasm_execution(
            block.wasm(),
            0x8000_1000,
            7,
            expected_executed,
            native.cpu.pc.value(),
            native.cpu.user.gpr[4],
            native.cpu.user.lr,
        );
    }

    #[test]
    fn native_jit_load_reserve_and_store_conditional_round_trip() {
        let address = Address(NativeState::GUEST_BASE + 0x20);
        let initial = 0x1122_3344;
        let replacement = 0xaabb_ccdd;
        let sequence = [lwarx(5, 0, 3), stwcx(4, 0, 3)];

        let state =
            execute_with_native_jit_initialized(&sequence, 0x8000_1000, address.value(), |state| {
                state.cpu.user.gpr[4] = replacement;
                state.cpu.user.xer.set_overflow_fuse(true);
                state.write_guest_word(address, initial);
            });

        assert_eq!(state.cpu.user.gpr[5], initial);
        assert_eq!(state.read_guest_word(address), replacement);
        assert!(!state.cpu.reservation.is_valid());
        let cr0 = state.cpu.user.cr.fields()[7];
        assert!(!cr0.lt());
        assert!(!cr0.gt());
        assert!(cr0.eq());
        assert!(cr0.ov());
    }

    #[test]
    fn native_jit_store_conditional_uses_any_live_mpc750_reservation() {
        let reserved_address = Address(NativeState::GUEST_BASE + 0x20);
        let target_address = Address(NativeState::GUEST_BASE + 0x40);
        let replacement = 0x5566_7788;
        let sequence = [lwarx(5, 0, 3), stwcx(4, 3, 6)];

        let state = execute_with_native_jit_initialized(
            &sequence,
            0x8000_1000,
            reserved_address.value(),
            |state| {
                state.cpu.user.gpr[4] = replacement;
                state.cpu.user.gpr[6] = target_address.value() - reserved_address.value();
                state.write_guest_word(reserved_address, 0x1020_3040);
                state.write_guest_word(target_address, 0);
            },
        );

        assert_eq!(state.read_guest_word(reserved_address), 0x1020_3040);
        assert_eq!(state.read_guest_word(target_address), replacement);
        assert!(state.cpu.user.cr.fields()[7].eq());
        assert!(!state.cpu.reservation.is_valid());
    }

    #[test]
    fn native_jit_failed_store_conditional_does_not_write() {
        let address = Address(NativeState::GUEST_BASE + 0x20);
        let initial = 0x1234_5678;
        let sequence = [stwcx(4, 0, 3)];

        let state =
            execute_with_native_jit_initialized(&sequence, 0x8000_1000, address.value(), |state| {
                state.cpu.user.gpr[4] = 0x8765_4321;
                state.cpu.user.xer.set_overflow_fuse(true);
                state.write_guest_word(address, initial);
            });

        assert_eq!(state.read_guest_word(address), initial);
        assert!(!state.cpu.reservation.is_valid());
        let cr0 = state.cpu.user.cr.fields()[7];
        assert!(!cr0.lt());
        assert!(!cr0.gt());
        assert!(!cr0.eq());
        assert!(cr0.ov());
    }

    #[test]
    fn native_jit_reservation_faults_preserve_existing_state() {
        let reserved = Address(0x0000_0040);
        let unmapped = 0x9000_0000;
        let faulting_store = execute_with_native_jit_initialized(
            &[stwcx(4, 0, 3)],
            0x8000_1000,
            unmapped,
            |state| {
                state.cpu.reservation.reserve(reserved);
                state.cpu.user.gpr[4] = 0xfeed_beef;
            },
        );
        assert_eq!(
            faulting_store.cpu.reservation.physical_granule(),
            Some(reserved)
        );

        let misaligned = NativeState::GUEST_BASE + 0x21;
        let faulting_load = execute_with_native_jit_initialized(
            &[lwarx(5, 0, 3)],
            0x8000_2000,
            misaligned,
            |state| {
                state.cpu.reservation.reserve(reserved);
                state.cpu.user.gpr[5] = 0x1357_9bdf;
            },
        );
        assert_eq!(
            faulting_load.cpu.reservation.physical_granule(),
            Some(reserved)
        );
        assert_eq!(faulting_load.cpu.user.gpr[5], 0x1357_9bdf);
    }

    #[test]
    fn mcrfs_moves_fpscr_fields_and_clears_only_exception_bits() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
            return;
        }

        let sequence = (0..8).map(|field| mcrfs(field, field)).collect::<Vec<_>>();
        let block = Jit::new().build(sequence.iter().copied()).unwrap();
        Validator::new().validate_all(block.wasm()).unwrap();

        let initial_cr = 0x0123_4567;
        let initial_fpscr = 0xffff_ffff;
        let expected_cr = 0xffff_ffff;
        // All sticky exception bits and FX were read and cleared. VX and FEX are now clear because
        // no underlying exception remains; result, reserved, and control bits are preserved.
        let expected_fpscr = 0x0007_f8ff;

        let native = execute_with_native_jit_initialized(&sequence, 0x8000_1000, 0, |state| {
            state.cpu.user.cr = CondReg::from_bits(initial_cr);
            state.cpu.user.fpscr = FloatControlReg::from_bits(initial_fpscr);
        });
        assert_eq!(native.cpu.user.cr.to_bits(), expected_cr);
        assert_eq!(native.cpu.user.fpscr.to_bits(), expected_fpscr);

        let wasm = block
            .wasm()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let script = r#"
const [wasmHex, pcOffset, crOffset, fpscrOffset, initialCr, initialFpscr, expectedExecuted, expectedPc, expectedCr, expectedFpscr] = process.argv.slice(1);
const memory = new WebAssembly.Memory({ initial: 1 });
const view = new DataView(memory.buffer);
const cpu = 64;
view.setUint32(cpu + Number(pcOffset), 0x80001000, true);
view.setUint32(cpu + Number(crOffset), Number(initialCr), true);
view.setUint32(cpu + Number(fpscrOffset), Number(initialFpscr), true);
const { instance } = await WebAssembly.instantiate(Buffer.from(wasmHex, "hex"), { lazuli: { memory } });
const executed = instance.exports.run(0, cpu, 0) >>> 0;
if (executed !== (Number(expectedExecuted) >>> 0)) throw new Error(`bad execution metadata: 0x${executed.toString(16)}`);
const pc = view.getUint32(cpu + Number(pcOffset), true);
if (pc !== (Number(expectedPc) >>> 0)) throw new Error(`bad pc: 0x${pc.toString(16)}`);
const cr = view.getUint32(cpu + Number(crOffset), true);
if (cr !== (Number(expectedCr) >>> 0)) throw new Error(`bad CR: 0x${cr.toString(16)}`);
const fpscr = view.getUint32(cpu + Number(fpscrOffset), true);
if (fpscr !== (Number(expectedFpscr) >>> 0)) throw new Error(`bad FPSCR: 0x${fpscr.toString(16)}`);
"#;
        let output = Command::new("node")
            .args([
                "--input-type=module",
                "--eval",
                script,
                &wasm,
                &Reg::PC.offset().to_string(),
                &Reg::CR.offset().to_string(),
                &Reg::FPSCR.offset().to_string(),
                &initial_cr.to_string(),
                &initial_fpscr.to_string(),
                &block.metadata().executed.pack().to_string(),
                &native.cpu.pc.value().to_string(),
                &expected_cr.to_string(),
                &expected_fpscr.to_string(),
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
    fn condition_register_equivalence_runs_in_native_and_webassembly_jits() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
            return;
        }

        // The second instruction is the SDK's `crset` alias (creqv bit, bit, bit), which used to
        // leave an i8 bxor-immediate outside the portable lowerer's supported CLIF subset.
        let sequence = [creqv(6, 2, 3), creqv(7, 7, 7)];
        let initial_cr = (1 << (31 - 2)) | (1 << (31 - 6));
        let expected_cr = (1 << (31 - 2)) | (1 << (31 - 7));
        let block = Jit::new().build(sequence).unwrap();
        Validator::new().validate_all(block.wasm()).unwrap();

        let native = execute_with_native_jit_initialized(&sequence, 0x8000_1000, 0, |state| {
            state.cpu.user.cr = CondReg::from_bits(initial_cr);
        });
        assert_eq!(native.cpu.user.cr.to_bits(), expected_cr);

        let wasm = block
            .wasm()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let script = r#"
const [wasmHex, pcOffset, crOffset, initialCr, expectedExecuted, expectedPc, expectedCr] = process.argv.slice(1);
const memory = new WebAssembly.Memory({ initial: 1 });
const view = new DataView(memory.buffer);
const cpu = 64;
view.setUint32(cpu + Number(pcOffset), 0x80001000, true);
view.setUint32(cpu + Number(crOffset), Number(initialCr), true);
const { instance } = await WebAssembly.instantiate(Buffer.from(wasmHex, "hex"), { lazuli: { memory } });
const executed = instance.exports.run(0, cpu, 0) >>> 0;
if (executed !== (Number(expectedExecuted) >>> 0)) throw new Error(`bad execution metadata: 0x${executed.toString(16)}`);
const pc = view.getUint32(cpu + Number(pcOffset), true);
if (pc !== (Number(expectedPc) >>> 0)) throw new Error(`bad pc: 0x${pc.toString(16)}`);
const cr = view.getUint32(cpu + Number(crOffset), true);
if (cr !== (Number(expectedCr) >>> 0)) throw new Error(`bad CR: 0x${cr.toString(16)}`);
"#;
        let output = Command::new("node")
            .args([
                "--input-type=module",
                "--eval",
                script,
                &wasm,
                &Reg::PC.offset().to_string(),
                &Reg::CR.offset().to_string(),
                &initial_cr.to_string(),
                &block.metadata().executed.pack().to_string(),
                &native.cpu.pc.value().to_string(),
                &expected_cr.to_string(),
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
    fn fnabs_sets_sign_without_changing_fpscr_in_native_and_webassembly_jits() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
            return;
        }

        let sequence = [fnabs(2, 1, false), fnabs(4, 3, true)];
        let initial_cr = u32::MAX;
        let block = Jit::new().build(sequence).unwrap();
        Validator::new().validate_all(block.wasm()).unwrap();
        let native = execute_with_native_jit_initialized(&sequence, 0x8000_1000, 0, |state| {
            state.cpu.supervisor.config.msr = state
                .cpu
                .supervisor
                .config
                .msr
                .clone()
                .with_float_available(true);
            state.cpu.user.cr = CondReg::from_bits(initial_cr);
            state.cpu.user.fpscr = FloatControlReg::from_bits(0);
            state.cpu.user.fpr[1] = FloatPair([3.5, -99.0]);
            state.cpu.user.fpr[3] = FloatPair([-2.25, 4.0]);
        });
        assert_eq!(native.cpu.user.fpr[2], FloatPair([-3.5, -3.5]));
        assert_eq!(native.cpu.user.fpr[4], FloatPair([-2.25, -2.25]));
        assert_eq!(native.cpu.user.fpscr.to_bits(), 0);
        assert_eq!(native.cpu.user.cr.to_bits(), 0xf0ff_ffff);

        let wasm = block
            .wasm()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let expected_f2 = [
            native.cpu.user.fpr[2][0].to_bits(),
            native.cpu.user.fpr[2][1].to_bits(),
        ];
        let expected_f4 = [
            native.cpu.user.fpr[4][0].to_bits(),
            native.cpu.user.fpr[4][1].to_bits(),
        ];
        let script = r#"
const [wasmHex, pcOffset, msrOffset, crOffset, fpscrOffset, f1Offset, f2Offset, f3Offset, f4Offset, initialMsr, initialCr, expectedExecuted, expectedPc, expectedCr, expectedFpscr, expectedF2a, expectedF2b, expectedF4a, expectedF4b] = process.argv.slice(1);
const memory = new WebAssembly.Memory({ initial: 1 });
const view = new DataView(memory.buffer);
const cpu = 64;
view.setUint32(cpu + Number(pcOffset), 0x80001000, true);
view.setUint32(cpu + Number(msrOffset), Number(initialMsr), true);
view.setUint32(cpu + Number(crOffset), Number(initialCr), true);
view.setUint32(cpu + Number(fpscrOffset), 0, true);
view.setFloat64(cpu + Number(f1Offset), 3.5, true);
view.setFloat64(cpu + Number(f1Offset) + 8, -99.0, true);
view.setFloat64(cpu + Number(f3Offset), -2.25, true);
view.setFloat64(cpu + Number(f3Offset) + 8, 4.0, true);
const { instance } = await WebAssembly.instantiate(Buffer.from(wasmHex, "hex"), {
  lazuli: { memory },
  lazuli_hooks: { user_1_0() { throw new Error("unexpected floating-point exception"); } },
});
const executed = instance.exports.run(0, cpu, 0) >>> 0;
if (executed !== (Number(expectedExecuted) >>> 0)) throw new Error(`bad execution metadata: 0x${executed.toString(16)}`);
const pc = view.getUint32(cpu + Number(pcOffset), true);
if (pc !== (Number(expectedPc) >>> 0)) throw new Error(`bad pc: 0x${pc.toString(16)}`);
const cr = view.getUint32(cpu + Number(crOffset), true);
if (cr !== (Number(expectedCr) >>> 0)) throw new Error(`bad CR: 0x${cr.toString(16)}`);
const fpscr = view.getUint32(cpu + Number(fpscrOffset), true);
if (fpscr !== (Number(expectedFpscr) >>> 0)) throw new Error(`bad FPSCR: 0x${fpscr.toString(16)}`);
for (const [offset, expected] of [
  [Number(f2Offset), BigInt(expectedF2a)],
  [Number(f2Offset) + 8, BigInt(expectedF2b)],
  [Number(f4Offset), BigInt(expectedF4a)],
  [Number(f4Offset) + 8, BigInt(expectedF4b)],
]) {
  const actual = view.getBigUint64(cpu + offset, true);
  if (actual !== expected) throw new Error(`bad FPR bits at ${offset}: 0x${actual.toString(16)}`);
}
"#;
        let output = Command::new("node")
            .args([
                "--input-type=module",
                "--eval",
                script,
                &wasm,
                &Reg::PC.offset().to_string(),
                &Reg::MSR.offset().to_string(),
                &Reg::CR.offset().to_string(),
                &Reg::FPSCR.offset().to_string(),
                &FPR::R1.offset().to_string(),
                &FPR::R2.offset().to_string(),
                &FPR::R3.offset().to_string(),
                &FPR::R4.offset().to_string(),
                &native.cpu.supervisor.config.msr.to_bits().to_string(),
                &initial_cr.to_string(),
                &block.metadata().executed.pack().to_string(),
                &native.cpu.pc.value().to_string(),
                &native.cpu.user.cr.to_bits().to_string(),
                &native.cpu.user.fpscr.to_bits().to_string(),
                &expected_f2[0].to_string(),
                &expected_f2[1].to_string(),
                &expected_f4[0].to_string(),
                &expected_f4[1].to_string(),
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
    fn paired_single_results_round_to_f32_in_native_and_webassembly_jits() {
        const ROUNDING_DELTA: f64 = f64::from_bits(0x3e60_0000_0000_0000);
        const ONE_BITS: u64 = 0x3ff0_0000_0000_0000;
        const THREE_BITS: u64 = 0x4008_0000_0000_0000;
        const SEVEN_BITS: u64 = 0x401c_0000_0000_0000;
        const NEG_FIVE_BITS: u64 = 0xc014_0000_0000_0000;
        const NEG_SEVEN_BITS: u64 = 0xc01c_0000_0000_0000;
        const SINGLE_THIRD_BITS: u64 = 0x3fd5_5555_6000_0000;

        let sequence = [
            ps_add(4, 1, 2),
            ps_sum0(5, 1, 3, 2),
            ps_madd(6, 1, 3, 2),
            ps_mul(7, 1, 3),
            ps_div(9, 1, 8),
        ];
        let inputs = [
            (1, [1.0f64.to_bits(), (-1.0f64).to_bits()]),
            (2, [ROUNDING_DELTA.to_bits(), 2.0f64.to_bits()]),
            (3, [1.0f64.to_bits(), 7.0f64.to_bits()]),
            (8, [3.0f64.to_bits(), (-3.0f64).to_bits()]),
        ];
        let expected = [
            (4, [ONE_BITS, ONE_BITS]),
            (5, [THREE_BITS, SEVEN_BITS]),
            (6, [ONE_BITS, NEG_FIVE_BITS]),
            (7, [ONE_BITS, NEG_SEVEN_BITS]),
            (9, [SINGLE_THIRD_BITS, SINGLE_THIRD_BITS]),
        ];
        assert_paired_float_execution(&sequence, &inputs, &expected);
    }

    #[test]
    fn paired_multipliers_force_c_to_gekko_25_bit_precision() {
        const NORMAL_A: u64 = 0x3ff6_7593_0000_0000;
        const LARGE_A: u64 = 0x7fd0_0000_0000_0000;
        const NORMAL_C: u64 = 0x3ff7_03a0_7888_e24d;
        const SUBNORMAL_C: u64 = 0x000f_319b_68f9_d237;
        const NORMAL_PRODUCT: u64 = 0x4000_270d_6000_0000;
        const SUBNORMAL_PRODUCT: u64 = 0x3fee_6336_c000_0000;
        const NEG_NORMAL_PRODUCT: u64 = 0xc000_270d_6000_0000;
        const NEG_SUBNORMAL_PRODUCT: u64 = 0xbfee_6336_c000_0000;

        let sequence = [
            ps_mul(4, 1, 2),
            ps_muls0(5, 1, 2),
            ps_muls1(6, 1, 2),
            ps_madd(7, 1, 2, 3),
            ps_msub(8, 1, 2, 3),
            ps_nmadd(9, 1, 2, 3),
            ps_nmsub(10, 1, 2, 3),
            ps_madds0(11, 1, 2, 3),
            ps_madds1(12, 1, 2, 3),
        ];
        let inputs = [
            (1, [NORMAL_A, LARGE_A]),
            (2, [NORMAL_C, SUBNORMAL_C]),
            (3, [0, 0]),
        ];
        let expected = [
            (4, [NORMAL_PRODUCT, SUBNORMAL_PRODUCT]),
            (5, [NORMAL_PRODUCT, f64::INFINITY.to_bits()]),
            (6, [0, SUBNORMAL_PRODUCT]),
            (7, [NORMAL_PRODUCT, SUBNORMAL_PRODUCT]),
            (8, [NORMAL_PRODUCT, SUBNORMAL_PRODUCT]),
            (9, [NEG_NORMAL_PRODUCT, NEG_SUBNORMAL_PRODUCT]),
            (10, [NEG_NORMAL_PRODUCT, NEG_SUBNORMAL_PRODUCT]),
            (11, [NORMAL_PRODUCT, f64::INFINITY.to_bits()]),
            (12, [0, SUBNORMAL_PRODUCT]),
        ];
        assert_paired_float_execution(&sequence, &inputs, &expected);
    }

    #[test]
    fn executes_tagged_secondary_fastmem_with_tlb_permissions() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
            return;
        }

        let load = Jit::with_browser_secondary_fastmem()
            .build([lwz(4, 3, 0)])
            .unwrap();
        let store = Jit::with_browser_secondary_fastmem()
            .build([stw(4, 3, 0)])
            .unwrap();
        Validator::new().validate_all(load.wasm()).unwrap();
        Validator::new().validate_all(store.wasm()).unwrap();
        let to_hex = |block: &Block| {
            block
                .wasm()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        };
        let load_wasm = to_hex(&load);
        let store_wasm = to_hex(&store);
        let script = r#"
const [
  loadHex,
  storeHex,
  pcOffset,
  r3Offset,
  r4Offset,
  readI32Hook,
  writeI32Hook,
  loadExecuted,
  storeExecuted,
  pageShift,
  setCount,
  controlOffset,
  readHitsOffset,
  writeHitsOffset,
  missesOffset,
  lruOffset,
  tagOffset,
  readPointerOffset,
  writePointerOffset,
] = process.argv.slice(1).map((value, index) => index < 2 ? value : Number(value));

const cpu = 64;
const fmem = 0x10000;
const dataPage = 0x60000;
const effectivePage = 0x81234000;
const readHookName = `user_0_${readI32Hook}`;
const writeHookName = `user_0_${writeI32Hook}`;

function makeState(address, way, { enabled = true, read = true, write = false, tag = null } = {}) {
  const memory = new WebAssembly.Memory({ initial: 8 });
  const view = new DataView(memory.buffer);
  const page = address >>> pageShift;
  const set = page & (setCount - 1);
  const entry = set * 2 + way;
  view.setUint32(cpu + pcOffset, 0x80001000, true);
  view.setUint32(cpu + r3Offset, address, true);
  view.setUint32(cpu + r4Offset, 0xaabbccdd, true);
  view.setUint32(fmem + controlOffset, enabled ? 1 : 0, true);
  view.setUint32(fmem + tagOffset + entry * 4, tag ?? ((page + 1) >>> 0), true);
  if (read) view.setUint32(fmem + readPointerOffset + entry * 4, dataPage, true);
  if (write) view.setUint32(fmem + writePointerOffset + entry * 4, dataPage, true);
  return { memory, view, address, set };
}

function counters(state) {
  return {
    read: state.view.getUint32(fmem + readHitsOffset, true),
    write: state.view.getUint32(fmem + writeHitsOffset, true),
    miss: state.view.getUint32(fmem + missesOffset, true),
    lru: state.view.getUint32(fmem + lruOffset + state.set * 4, true),
  };
}

async function execute(hex, expectedExecuted, state, overrides = {}) {
  const hooks = {
    [readHookName]() { throw new Error("unexpected slow read"); },
    [writeHookName]() { throw new Error("unexpected slow write"); },
    user_1_0() { throw new Error("unexpected data-storage exception"); },
    ...overrides,
  };
  const { instance } = await WebAssembly.instantiate(Buffer.from(hex, "hex"), {
    lazuli: { memory: state.memory },
    lazuli_hooks: hooks,
  });
  const executed = instance.exports.run(0, cpu, fmem) >>> 0;
  if (executed !== (expectedExecuted >>> 0)) {
    throw new Error(`bad execution metadata: 0x${executed.toString(16)}`);
  }
}

// Both hardware-shaped ways are addressable. A hit updates the shared next-replacement word to
// the opposite way and performs the guest's big-endian access without a JS memory hook.
for (const [way, value, expectedLru] of [[0, 0x11223344, 1], [1, 0x55667788, 0]]) {
  const state = makeState(effectivePage + 0x10, way);
  state.view.setUint32(dataPage + 0x10, value, false);
  await execute(loadHex, loadExecuted, state);
  const actual = state.view.getUint32(cpu + r4Offset, true);
  if (actual !== value) throw new Error(`way ${way} loaded 0x${actual.toString(16)}`);
  const actualCounters = counters(state);
  const expectedCounters = { read: 1, write: 0, miss: 0, lru: expectedLru };
  if (JSON.stringify(actualCounters) !== JSON.stringify(expectedCounters)) {
    throw new Error(`bad way ${way} counters: ${JSON.stringify(actualCounters)}`);
  }
}

// The established 128 KiB LUT remains first priority. Its hit must not touch sidecar state even
// when an exact 4 KiB entry is also present.
{
  const state = makeState(effectivePage + 0x10, 0);
  const primaryPage = 0x40000;
  const primaryOffset = state.address & 0x1ffff;
  state.view.setUint32(fmem + (state.address >>> 17) * 4, primaryPage, true);
  state.view.setUint32(primaryPage + primaryOffset, 0x31415926, false);
  state.view.setUint32(dataPage + 0x10, 0x27182818, false);
  await execute(loadHex, loadExecuted, state);
  const actual = state.view.getUint32(cpu + r4Offset, true);
  if (actual !== 0x31415926) throw new Error(`primary LUT lost priority: 0x${actual.toString(16)}`);
  const actualCounters = counters(state);
  const expectedCounters = { read: 0, write: 0, miss: 0, lru: 0 };
  if (JSON.stringify(actualCounters) !== JSON.stringify(expectedCounters)) {
    throw new Error(`primary hit touched sidecar state: ${JSON.stringify(actualCounters)}`);
  }
}

// A read-committed PTE does not authorize a direct write. The write remains on the checked hook
// until the browser commits C and publishes the independent write pointer.
{
  const state = makeState(effectivePage + 0x10, 0);
  state.view.setUint32(dataPage + 0x10, 0x01020304, false);
  state.view.setUint32(fmem + lruOffset + state.set * 4, 1, true);
  let writes = 0;
  await execute(storeHex, storeExecuted, state, {
    [writeHookName](context, address, value) {
      if (context !== 0 || (address >>> 0) !== (state.address >>> 0) || (value >>> 0) !== 0xaabbccdd) {
        throw new Error("bad slow-write hook arguments");
      }
      writes++;
      return 1;
    },
  });
  if (writes !== 1) throw new Error(`expected one checked write, got ${writes}`);
  if (state.view.getUint32(dataPage + 0x10, false) !== 0x01020304) {
    throw new Error("read-only sidecar entry performed a direct write");
  }
  const actualCounters = counters(state);
  const expectedCounters = { read: 0, write: 0, miss: 1, lru: 1 };
  if (JSON.stringify(actualCounters) !== JSON.stringify(expectedCounters)) {
    throw new Error(`bad read-only counters: ${JSON.stringify(actualCounters)}`);
  }
}

// Once write permission is published, the same store is direct and remains big-endian.
{
  const state = makeState(effectivePage + 0x10, 0, { write: true });
  await execute(storeHex, storeExecuted, state);
  const actual = state.view.getUint32(dataPage + 0x10, false);
  if (actual !== 0xaabbccdd) throw new Error(`bad direct store: 0x${actual.toString(16)}`);
  const actualCounters = counters(state);
  const expectedCounters = { read: 0, write: 1, miss: 0, lru: 1 };
  if (JSON.stringify(actualCounters) !== JSON.stringify(expectedCounters)) {
    throw new Error(`bad writable counters: ${JSON.stringify(actualCounters)}`);
  }
}

async function expectSlowRead(state, value, expectedCounters) {
  let reads = 0;
  await execute(loadHex, loadExecuted, state, {
    [readHookName](context, address, output) {
      if (context !== 0 || (address >>> 0) !== (state.address >>> 0)) {
        throw new Error("bad slow-read hook arguments");
      }
      reads++;
      state.view.setUint32(output, value, true);
      return 1;
    },
  });
  if (reads !== 1) throw new Error(`expected one checked read, got ${reads}`);
  if (state.view.getUint32(cpu + r4Offset, true) !== (value >>> 0)) {
    throw new Error("slow-read result was not committed");
  }
  const actualCounters = counters(state);
  if (JSON.stringify(actualCounters) !== JSON.stringify(expectedCounters)) {
    throw new Error(`bad slow-read counters: ${JSON.stringify(actualCounters)}`);
  }
}

// Full-page tags reject same-set aliases. Disabling DR retains entries but bypasses them without
// telemetry noise. A multi-byte access that crosses a 4 KiB page boundary is never direct.
{
  const state = makeState(effectivePage + 0x10, 0, { tag: 0x12345678 });
  await expectSlowRead(state, 0xcafebabe, { read: 0, write: 0, miss: 1, lru: 0 });
}
{
  const state = makeState(effectivePage + 0x10, 0, { enabled: false });
  await expectSlowRead(state, 0xdecafbad, { read: 0, write: 0, miss: 0, lru: 0 });
}
{
  const state = makeState(effectivePage + 0xfff, 0);
  await expectSlowRead(state, 0x0badf00d, { read: 0, write: 0, miss: 1, lru: 0 });
}
{
  const primaryBoundary = ((effectivePage & ~0x1ffff) + 0x1ffff) >>> 0;
  const state = makeState(primaryBoundary, 0);
  const primaryPage = 0x40000;
  state.view.setUint32(fmem + (state.address >>> 17) * 4, primaryPage, true);
  await expectSlowRead(state, 0x76543210, { read: 0, write: 0, miss: 0, lru: 0 });
}
"#;
        let output = Command::new("node")
            .args([
                "--input-type=module",
                "--eval",
                script,
                &load_wasm,
                &store_wasm,
                &Reg::PC.offset().to_string(),
                &GPR::R3.offset().to_string(),
                &GPR::R4.offset().to_string(),
                &(ppcjit::hooks::HookKind::ReadI32 as u32).to_string(),
                &(ppcjit::hooks::HookKind::WriteI32 as u32).to_string(),
                &load.metadata().executed.pack().to_string(),
                &store.metadata().executed.pack().to_string(),
                &SECONDARY_FASTMEM_PAGE_SHIFT.to_string(),
                &SECONDARY_FASTMEM_SET_COUNT.to_string(),
                &SECONDARY_FASTMEM_CONTROL_OFFSET.to_string(),
                &SECONDARY_FASTMEM_READ_HITS_OFFSET.to_string(),
                &SECONDARY_FASTMEM_WRITE_HITS_OFFSET.to_string(),
                &SECONDARY_FASTMEM_MISSES_OFFSET.to_string(),
                &SECONDARY_FASTMEM_LRU_OFFSET.to_string(),
                &SECONDARY_FASTMEM_TAG_OFFSET.to_string(),
                &SECONDARY_FASTMEM_READ_POINTER_OFFSET.to_string(),
                &SECONDARY_FASTMEM_WRITE_POINTER_OFFSET.to_string(),
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
    fn executes_word_fastmem_like_the_native_jit() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
            return;
        }

        let sequence = [
            addis(3, 0, i16::MIN),
            lwz(4, 3, 0x2000),
            xoris(4, 4, 0xd389),
            xori(4, 4, 0x5121),
            stw(4, 3, 0x2004),
        ];
        let input = 0x1357_9bdfu32;
        let block = Jit::new().build(sequence).unwrap();
        let native = execute_with_native_jit_initialized(&sequence, 0x8000_1000, 0, |state| {
            state.guest_page[0x2000..0x2004].copy_from_slice(&input.to_be_bytes());
        });
        let native_executed = native.executed.expect("native JIT did not exit");
        let expected_executed = Executed {
            instructions: native_executed.instructions,
            cycles: native_executed.cycles,
        }
        .pack();
        let expected_result =
            u32::from_be_bytes(native.guest_page[0x2004..0x2008].try_into().unwrap());
        let wasm = block
            .wasm()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let script = r#"
const [wasmHex, pcOffset, r4Offset, expectedExecuted, expectedPc, expectedR4, expectedResult] = process.argv.slice(1);
const memory = new WebAssembly.Memory({ initial: 8 });
const view = new DataView(memory.buffer);
const cpu = 64;
const fmem = 0x10000;
const page = 0x40000;
view.setUint32(cpu + Number(pcOffset), 0x80001000, true);
view.setUint32(fmem + (0x80000000 >>> 17) * 4, page, true);
view.setUint32(page + 0x2000, 0x13579bdf, false);
const { instance } = await WebAssembly.instantiate(Buffer.from(wasmHex, "hex"), { lazuli: { memory } });
const executed = instance.exports.run(0, cpu, fmem) >>> 0;
if (executed !== (Number(expectedExecuted) >>> 0)) throw new Error(`bad execution metadata: 0x${executed.toString(16)}`);
const pc = view.getUint32(cpu + Number(pcOffset), true);
if (pc !== (Number(expectedPc) >>> 0)) throw new Error(`bad pc: 0x${pc.toString(16)}`);
const r4 = view.getUint32(cpu + Number(r4Offset), true);
if (r4 !== (Number(expectedR4) >>> 0)) throw new Error(`bad r4: 0x${r4.toString(16)}`);
const result = view.getUint32(page + 0x2004, false);
if (result !== (Number(expectedResult) >>> 0)) throw new Error(`bad guest result: 0x${result.toString(16)}`);
"#;
        let output = Command::new("node")
            .args([
                "--input-type=module",
                "--eval",
                script,
                &wasm,
                &Reg::PC.offset().to_string(),
                &GPR::R4.offset().to_string(),
                &expected_executed.to_string(),
                &native.cpu.pc.value().to_string(),
                &native.cpu.user.gpr[4].to_string(),
                &expected_result.to_string(),
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
    fn executes_narrow_fastmem_like_the_native_jit() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
            return;
        }

        let sequence = [
            addis(3, 0, i16::MIN),
            addi(4, 0, 0x1234),
            stb(4, 3, 0x2000),
            sth(4, 3, 0x2002),
            lbz(6, 3, 0x2000),
            lhz(7, 3, 0x2002),
        ];
        let block = Jit::new().build(sequence).unwrap();
        let native = execute_with_native_jit(&sequence, 0x8000_1000, 0);
        let native_executed = native.executed.expect("native JIT did not exit");
        let expected_executed = Executed {
            instructions: native_executed.instructions,
            cycles: native_executed.cycles,
        }
        .pack();
        let expected_bytes = native.guest_page[0x2000..0x2004]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let wasm = block
            .wasm()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let script = r#"
const [wasmHex, pcOffset, r6Offset, r7Offset, expectedExecuted, expectedPc, expectedR6, expectedR7, expectedBytes] = process.argv.slice(1);
const memory = new WebAssembly.Memory({ initial: 8 });
const view = new DataView(memory.buffer);
const cpu = 64;
const fmem = 0x10000;
const page = 0x40000;
view.setUint32(cpu + Number(pcOffset), 0x80001000, true);
view.setUint32(fmem + (0x80000000 >>> 17) * 4, page, true);
const { instance } = await WebAssembly.instantiate(Buffer.from(wasmHex, "hex"), { lazuli: { memory } });
const executed = instance.exports.run(0, cpu, fmem) >>> 0;
if (executed !== (Number(expectedExecuted) >>> 0)) throw new Error("bad execution metadata");
const pc = view.getUint32(cpu + Number(pcOffset), true);
if (pc !== (Number(expectedPc) >>> 0)) throw new Error("bad pc");
const r6 = view.getUint32(cpu + Number(r6Offset), true);
if (r6 !== (Number(expectedR6) >>> 0)) throw new Error("bad r6");
const r7 = view.getUint32(cpu + Number(r7Offset), true);
if (r7 !== (Number(expectedR7) >>> 0)) throw new Error("bad r7");
const bytes = Buffer.from(new Uint8Array(memory.buffer, page + 0x2000, 4)).toString("hex");
if (bytes !== expectedBytes) throw new Error("bad guest bytes: " + bytes);
"#;
        let output = Command::new("node")
            .args([
                "--input-type=module",
                "--eval",
                script,
                &wasm,
                &Reg::PC.offset().to_string(),
                &GPR::R6.offset().to_string(),
                &GPR::R7.offset().to_string(),
                &expected_executed.to_string(),
                &native.cpu.pc.value().to_string(),
                &native.cpu.user.gpr[6].to_string(),
                &native.cpu.user.gpr[7].to_string(),
                &expected_bytes,
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
    fn executes_quantized_fastmem_without_runtime_hooks() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
            return;
        }

        let sequence = [psq_l(2, 3, 0, false, 0), psq_st(2, 3, 8, false, 0)];
        let block = Jit::with_slow_memory().build(sequence).unwrap();
        Validator::new().validate_all(block.wasm()).unwrap();
        let wasm = block
            .wasm()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let script = r#"
const [wasmHex, pcOffset, msrOffset, r3Offset, gqrOffset] = process.argv.slice(1);
const memory = new WebAssembly.Memory({ initial: 8 });
const view = new DataView(memory.buffer);
const cpu = 64;
const fmem = 0x10000;
const page = 0x40000;
view.setUint32(cpu + Number(pcOffset), 0x80001000, true);
view.setUint32(cpu + Number(msrOffset), 0x2000, true);
view.setUint32(cpu + Number(r3Offset), 0x80002000, true);
view.setUint32(cpu + Number(gqrOffset), (1 << 24) | (4 << 16) | (1 << 8) | 4, true);
view.setUint32(fmem + (0x80000000 >>> 17) * 4, page, true);
view.setUint8(page + 0x2000, 7);
view.setUint8(page + 0x2001, 250);
const hooks = new Proxy({}, {
  get(_target, name) {
    return () => { throw new Error("unexpected runtime hook: " + String(name)); };
  },
});
const { instance } = await WebAssembly.instantiate(Buffer.from(wasmHex, "hex"), {
  lazuli: { memory },
  lazuli_hooks: hooks,
});
instance.exports.run(0, cpu, fmem);
const result = [view.getUint8(page + 0x2008), view.getUint8(page + 0x2009)];
if (result[0] !== 7 || result[1] !== 250) {
  throw new Error("bad quantized round trip: " + result.join(","));
}
"#;
        let output = Command::new("node")
            .args([
                "--input-type=module",
                "--eval",
                script,
                &wasm,
                &Reg::PC.offset().to_string(),
                &Reg::MSR.offset().to_string(),
                &GPR::R3.offset().to_string(),
                &SPR::GQR[0].offset().to_string(),
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
    fn quantized_fastmem_loads_halfwords_in_guest_byte_order() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
            return;
        }

        let sequence = [
            psq_l(2, 3, 0, false, 0),
            psq_st(2, 3, 16, false, 0),
            psq_l(3, 3, 4, false, 1),
            psq_st(3, 3, 20, false, 1),
        ];
        let block = Jit::with_slow_memory().build(sequence).unwrap();
        Validator::new().validate_all(block.wasm()).unwrap();
        let wasm = block
            .wasm()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let script = r#"
const [wasmHex, pcOffset, msrOffset, r3Offset, gqr0Offset, gqr1Offset] = process.argv.slice(1);
const memory = new WebAssembly.Memory({ initial: 8 });
const view = new DataView(memory.buffer);
const cpu = 64;
const fmem = 0x10000;
const page = 0x40000;
view.setUint32(cpu + Number(pcOffset), 0x80001000, true);
view.setUint32(cpu + Number(msrOffset), 0x2000, true);
view.setUint32(cpu + Number(r3Offset), 0x80002000, true);
view.setUint32(cpu + Number(gqr0Offset), (5 << 16) | 5, true);
view.setUint32(cpu + Number(gqr1Offset), (7 << 16) | 7, true);
view.setUint32(fmem + (0x80000000 >>> 17) * 4, page, true);
const input = Uint8Array.of(0x12, 0x34, 0xab, 0xcd, 0x80, 0x01, 0x7f, 0xfe);
new Uint8Array(memory.buffer, page + 0x2000, input.length).set(input);
const hooks = new Proxy({}, {
  get(_target, name) {
    return () => { throw new Error("unexpected runtime hook: " + String(name)); };
  },
});
const { instance } = await WebAssembly.instantiate(Buffer.from(wasmHex, "hex"), {
  lazuli: { memory },
  lazuli_hooks: hooks,
});
instance.exports.run(0, cpu, fmem);
const result = new Uint8Array(memory.buffer, page + 0x2010, input.length);
if (!result.every((value, index) => value === input[index])) {
  throw new Error(
    "bad quantized halfword byte order: "
      + Buffer.from(result).toString("hex")
  );
}
"#;
        let output = Command::new("node")
            .args([
                "--input-type=module",
                "--eval",
                script,
                &wasm,
                &Reg::PC.offset().to_string(),
                &Reg::MSR.offset().to_string(),
                &GPR::R3.offset().to_string(),
                &SPR::GQR[0].offset().to_string(),
                &SPR::GQR[1].offset().to_string(),
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
    fn executes_both_conditional_branch_paths_like_the_native_jit() {
        for (count, expected_r4) in [(2, 2), (1, 41)] {
            let sequence = [
                addi(4, 0, count),
                mtspr(4, 9),
                conditional_branch(16, 0, 8),
                addi(4, 4, 40),
            ];
            let block = Jit::new().build(sequence).unwrap();
            let native = execute_with_native_jit(&sequence, 0x8000_1000, 0);
            let native_executed = native.executed.expect("native JIT did not exit");
            assert_eq!(native.cpu.user.gpr[4], expected_r4);

            assert_wasm_execution(
                block.wasm(),
                0x8000_1000,
                0,
                Executed {
                    instructions: native_executed.instructions,
                    cycles: native_executed.cycles,
                }
                .pack(),
                native.cpu.pc.value(),
                expected_r4,
                native.cpu.user.lr,
            );
        }
    }

    #[test]
    fn executes_linked_relative_branch() {
        let sequence = [addi(4, 3, 1), branch(8, false, true)];
        let block = Jit::new().build(sequence).unwrap();
        let native = execute_with_native_jit(&sequence, 0x8000_1000, 7);
        let native_executed = native.executed.expect("native JIT did not exit");

        assert_wasm_execution(
            block.wasm(),
            0x8000_1000,
            7,
            Executed {
                instructions: native_executed.instructions,
                cycles: native_executed.cycles,
            }
            .pack(),
            native.cpu.pc.value(),
            native.cpu.user.gpr[4],
            native.cpu.user.lr,
        );
    }

    #[test]
    fn preserves_unconditional_bc_metadata() {
        let block = Jit::new()
            .build([unconditional_bc(8), addi(4, 4, 1)])
            .unwrap();

        assert_eq!(block.metadata().sequence.len(), 1);
        assert_eq!(
            block.metadata().exit,
            Exit::Branch {
                relative: true,
                indirect: false,
                call: false,
            }
        );
        assert_wasm_execution(
            block.wasm(),
            0x8000_1000,
            7,
            Executed {
                instructions: 1,
                cycles: 2,
            }
            .pack(),
            0x8000_1008,
            0xdead_beef,
            0,
        );
    }

    #[test]
    fn preserves_indirect_branch_metadata() {
        let block = Jit::new()
            .build([branch_to_link_register(), addi(4, 4, 1)])
            .unwrap();

        assert_eq!(block.metadata().sequence.len(), 1);
        assert_eq!(
            block.metadata().exit,
            Exit::Branch {
                relative: false,
                indirect: true,
                call: false,
            }
        );
        assert_wasm_execution(
            block.wasm(),
            0x8000_1000,
            7,
            Executed {
                instructions: 1,
                cycles: 2,
            }
            .pack(),
            0,
            0xdead_beef,
            0,
        );
    }

    #[test]
    fn wasm_backend_consumes_clif() {
        let sequence = [addi(4, 3, -2), oris(4, 4, 0xabcd)];
        let mut translator = Translator::new(TranslationConfig::new(
            CodegenSettings::default(),
            ir::types::I32,
            CallConv::Fast,
            ExitMode::ReturnExecuted,
        ));
        let mut translated = translator.translate(sequence.into_iter()).unwrap();
        let block = translated.function.layout.entry_block().unwrap();
        let immediate = translated
            .function
            .layout
            .block_insts(block)
            .find(|&inst| {
                matches!(
                    translated.function.dfg.insts[inst],
                    InstructionData::UnaryImm {
                        opcode: Opcode::Iconst,
                        imm,
                    } if imm.bits() as u32 == 0xabcd_0000
                )
            })
            .expect("oris mask Iconst missing from frontend CLIF");
        translated
            .function
            .dfg
            .replace(immediate)
            .iconst(ir::types::I32, 0x1357_0000);

        let wasm = lower_clif(&translated.function).unwrap();
        Validator::new().validate_all(&wasm).unwrap();
        assert_wasm_execution(
            &wasm,
            0x8000_1000,
            7,
            Executed {
                instructions: 2,
                cycles: 3,
            }
            .pack(),
            0x8000_1008,
            0x1357_0005,
            0,
        );
    }

    #[test]
    fn rejects_invalid_clif() {
        let mut translator = Translator::new(TranslationConfig::new(
            CodegenSettings::default(),
            ir::types::I32,
            CallConv::Fast,
            ExitMode::ReturnExecuted,
        ));
        let mut translated = translator.translate([addi(4, 3, 1)].into_iter()).unwrap();
        translated.function.signature.returns[0] = ir::AbiParam::new(ir::types::I64);

        assert!(matches!(
            lower_clif(&translated.function),
            Err(LowerError::InvalidClif(_))
        ));
    }

    #[test]
    fn rejects_big_endian_memory_operations() {
        let mut translator = Translator::new(TranslationConfig::new(
            CodegenSettings::default(),
            ir::types::I32,
            CallConv::Fast,
            ExitMode::ReturnExecuted,
        ));
        let mut translated = translator.translate([addi(4, 3, 1)].into_iter()).unwrap();
        let block = translated.function.layout.entry_block().unwrap();
        let load = translated
            .function
            .layout
            .block_insts(block)
            .find(|&inst| {
                matches!(
                    translated.function.dfg.insts[inst],
                    InstructionData::Load { .. }
                )
            })
            .expect("addi frontend CLIF did not load r3");
        match &mut translated.function.dfg.insts[load] {
            InstructionData::Load { flags, .. } => flags.set_endianness(ir::Endianness::Big),
            _ => unreachable!(),
        }

        assert!(matches!(
            lower_clif(&translated.function),
            Err(LowerError::UnsupportedEndianness(ir::Endianness::Big))
        ));
    }
}
