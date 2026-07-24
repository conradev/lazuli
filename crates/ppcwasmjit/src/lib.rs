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
mod gx_fifo;
mod region;

use std::fmt;

pub use clifwasm::LowerError;
use clifwasm::ModuleConfig;
use cranelift_codegen::ir;
use cranelift_codegen::isa::CallConv;
use gekko::disasm::Ins;
pub use gx_fifo::hook_runtime as gx_fifo_hook_runtime;
pub use ppcjit::block::Pattern;
use ppcjit::{
    BuildError as PpcBuildError, CodegenSettings, ExitMode, TranslationConfig, TranslationExit,
    Translator,
};
pub use region::{BLOCK_IMPORT_MODULE, REGION_RUN_EXPORT, RegionBlock, RegionError, link_region};

/// Import module used by generated blocks.
pub const IMPORT_MODULE: &str = "lazuli";
/// Imported linear memory used for CPU and, eventually, guest-memory access.
pub const MEMORY_IMPORT: &str = "memory";
/// Import module used by generated blocks for portable runtime hooks.
pub const HOOK_IMPORT_MODULE: &str = "lazuli_hooks";
/// Exported block entry point.
pub const RUN_EXPORT: &str = "run";

/// Lowers portable CLIF with Lazuli's imported-memory module ABI.
pub fn lower_clif(function: &ir::Function) -> Result<Vec<u8>, LowerError> {
    clifwasm::function(
        function,
        &ModuleConfig::new(IMPORT_MODULE, MEMORY_IMPORT, RUN_EXPORT)
            .with_function_import_module(HOOK_IMPORT_MODULE)
            .with_stack_scratch(0, 0x800, 0x800),
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

/// Metadata retained alongside a generated WebAssembly module.
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

    /// Creates a compiler whose generated blocks call runtime hooks for unmapped memory pages.
    pub fn with_slow_memory() -> Self {
        Self::with_exit_mode(ExitMode::ReturnExecutedWithSlowMemory)
    }

    /// Creates the browser compiler with instruction-start hook-cycle publication enabled.
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn with_slow_memory_hook_cycle_offset(hook_cycle_offset: i32) -> Self {
        Self::with_exit_mode_and_hook_cycle_offset(
            ExitMode::ReturnExecutedWithSlowMemory,
            Some(hook_cycle_offset),
        )
    }

    fn with_exit_mode(exit_mode: ExitMode) -> Self {
        Self::with_exit_mode_and_hook_cycle_offset(exit_mode, None)
    }

    fn with_exit_mode_and_hook_cycle_offset(
        exit_mode: ExitMode,
        hook_cycle_offset: Option<i32>,
    ) -> Self {
        let mut config = TranslationConfig::new(
            CodegenSettings::default(),
            ir::types::I32,
            CallConv::Fast,
            exit_mode,
        );
        config.hook_cycle_offset = hook_cycle_offset;
        Self {
            translator: Translator::new(config),
        }
    }

    /// Compiles one PowerPC basic block.
    ///
    /// Compilation stops after an unconditional branch, matching the native JIT's block boundary.
    pub fn build(
        &mut self,
        instructions: impl IntoIterator<Item = Ins>,
    ) -> Result<Block, BuildError> {
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
        let wasm = lower_clif(&translated.function).map_err(BuildError::Lower)?;

        Ok(Block {
            wasm,
            metadata: Metadata {
                sequence: translated.sequence.0,
                executed,
                exit,
                pattern,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use std::alloc::Layout;
    use std::process::Command;
    use std::ptr::NonNull;

    use cranelift_codegen::ir::{self, InstBuilder, InstructionData, Opcode};
    use cranelift_codegen::isa::CallConv;
    use gekko::disasm::{Extensions, Ins};
    use gekko::{Address, CondReg, Cpu, FPR, FloatControlReg, FloatPair, GPR, QuantReg, Reg, SPR};
    use ppcjit::block::{BlockFn, Executed as NativeExecuted, ExitReason as NativeExitReason};
    use ppcjit::hooks::{Context as NativeContext, ExitData, Hooks};
    use ppcjit::{CodegenSettings, ExitMode, FastmemLut, TranslationConfig, Translator};
    use wasmparser::Validator;

    use super::{
        BuildError, Executed, Exit, Jit, LowerError, Pattern, RegionBlock, link_region, lower_clif,
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
    ) -> bool {
        panic!("unexpected native JIT read hook")
    }

    extern "C-unwind" fn unexpected_write<T>(
        _ctx: *mut NativeContext,
        _addr: Address,
        _value: T,
    ) -> bool {
        panic!("unexpected native JIT write hook")
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
            read_quantized: unexpected_read_quantized,
            write_quantized: unexpected_write_quantized,
            invalidate_icache: unexpected_invalidate,
            clear_icache: unexpected_generic,
            dcache_dma: unexpected_generic,
            msr_changed: unexpected_generic,
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
