mod icache;
mod mapping;
mod table;

use std::alloc::Layout;
use std::path::PathBuf;

use indexmap::IndexSet;
use lazuli::cores::{CpuCore, Info};
use lazuli::gekko::{self, Cpu, QuantReg};
use lazuli::runtime_hooks::{HookOutcome, INVALIDATION_HAS_PHYSICAL, MachineRuntimeHooks};
use lazuli::system::mmu::{TranslationEffect, TranslationFault};
use lazuli::system::{self, System};
use lazuli::{Address, Cycles, Primitive};
use mapping::Mapping;
use ppcjit::block::{BlockFn, Executed, ExitKind, ExitReason, Pattern};
use ppcjit::hooks::*;
use ppcjit::{Block, FastmemLut};

#[rustfmt::skip]
pub use ppcjit;

#[repr(C)]
struct ExitData {
    pub linked: Option<BlockFn>,
    pub linked_pattern: Pattern,
    pub linked_return: Option<BlockFn>,
}

/// Identifier for a block in a [`Blocks`] storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockId(usize);

pub struct StoredBlock {
    pub inner: Block,
    linked_from: Vec<*mut ExitData>,
    linked_return_from: Vec<*mut ExitData>,
}

// TODO: this is problematic
unsafe impl Send for StoredBlock {}

/// A structure which keeps tracks of compiled [`Block`]s.
pub struct Blocks {
    storage: Vec<StoredBlock>,
    logical_mappings: mapping::Table,
    physical_mappings: mapping::Table,
    logical_deps: mapping::DepsTable,
    physical_deps: mapping::DepsTable,
    temp_deps: IndexSet<Address>,
}

impl Default for Blocks {
    fn default() -> Self {
        Self {
            storage: Default::default(),
            logical_mappings: Default::default(),
            physical_mappings: Default::default(),
            logical_deps: Default::default(),
            physical_deps: Default::default(),
            temp_deps: IndexSet::new(),
        }
    }
}

struct MappingNotFoundError;

impl Blocks {
    fn insert_mapping(&mut self, logical: bool, addr: Address, mapping: Mapping) {
        let (mappings, deps) = if logical {
            (&mut self.logical_mappings, &mut self.logical_deps)
        } else {
            (&mut self.physical_mappings, &mut self.physical_deps)
        };

        mappings.insert(addr, mapping);

        let start = addr;
        let end = addr + mapping.length;
        deps.mark(addr, start..end);
    }

    fn remove_mapping_if_contains(
        &mut self,
        logical: bool,
        addr: Address,
        target: Address,
    ) -> Result<Option<Mapping>, MappingNotFoundError> {
        let (mappings, deps) = if logical {
            (&mut self.logical_mappings, &mut self.logical_deps)
        } else {
            (&mut self.physical_mappings, &mut self.physical_deps)
        };

        let mapping = mappings.get(addr).ok_or(MappingNotFoundError)?;

        let start = addr;
        let end = addr + mapping.length;
        let range = start..end;

        if range.contains(&target) {
            deps.unmark(addr, range);
            Ok(mappings.remove(addr))
        } else {
            Ok(None)
        }
    }

    /// Inserts a block into the storage and maps it to the given address.
    #[inline(always)]
    pub fn insert(&mut self, logical: bool, addr: Address, block: Block) -> BlockId {
        let length = 4 * block.meta().seq.len() as u32;
        let id = BlockId(self.storage.len());

        self.storage.push(StoredBlock {
            inner: block,
            linked_from: Vec::new(),
            linked_return_from: Vec::new(),
        });

        self.insert_mapping(logical, addr, Mapping { id, length });

        id
    }

    /// Returns the mapping at `addr`.
    #[inline(always)]
    pub fn get_mapping(&self, logical: bool, addr: Address) -> Option<Mapping> {
        let mappings = if logical {
            &self.logical_mappings
        } else {
            &self.physical_mappings
        };

        mappings.get(addr).copied()
    }

    /// Returns the block mapped to `addr`.
    #[inline(always)]
    pub fn get(&mut self, logical: bool, addr: Address) -> Option<&StoredBlock> {
        self.storage.get(self.get_mapping(logical, addr)?.id.0)
    }

    /// Invalidate mappings that contain `addr`.
    pub fn invalidate(&mut self, logical: bool, target: Address) {
        let deps = if logical {
            &mut self.logical_deps
        } else {
            &mut self.physical_deps
        };

        let Some(deps) = deps.get(target) else { return };
        if deps.is_empty() {
            return;
        }

        let mut temp_deps = std::mem::replace(&mut self.temp_deps, IndexSet::new());
        deps.clone_into(&mut temp_deps);

        for dep in temp_deps.iter() {
            let Ok(mapping) = self.remove_mapping_if_contains(logical, *dep, target) else {
                panic!("mapping {dep} is listed as dependent on a page but it does not exist");
            };

            // invalidate links of blocks that depend on this block
            let Some(mapping) = mapping else {
                continue;
            };

            let block = &mut self.storage[mapping.id.0];
            for data in block.linked_from.drain(..) {
                unsafe {
                    (*data).linked = None;
                    (*data).linked_pattern = Pattern::None;
                }
            }

            for data in block.linked_return_from.drain(..) {
                unsafe {
                    (*data).linked_return = None;
                }
            }
        }

        temp_deps.clear();
        self.temp_deps = temp_deps;
    }

    /// Clears all mappings.
    pub fn clear(&mut self) {
        self.unlink_all();
        self.logical_mappings.clear();
        self.physical_mappings.clear();
        self.logical_deps.clear();
        self.physical_deps.clear();
    }

    fn unlink_all(&mut self) {
        for block in &mut self.storage {
            for data in block.linked_from.drain(..) {
                unsafe {
                    (*data).linked = None;
                    (*data).linked_pattern = Pattern::None;
                }
            }

            for data in block.linked_return_from.drain(..) {
                unsafe {
                    (*data).linked_return = None;
                }
            }
        }
    }
}

/// Context to be passed in for execution of JIT blocks.
struct Context<'a> {
    /// The system state, so that the JIT block can operate on it.
    sys: &'a mut System,
    /// The block mapping, so that write operations can invalidate blocks.
    blocks: &'a mut Blocks,
    /// ICache
    icache: &'a mut icache::Cache,
    /// A shadow stack for calls and returns.
    shadow_stack: &'a mut Vec<(Address, BlockFn)>,
    /// Cycles executed.   
    executed_cycles: u32,
    /// Instructions executed.   
    executed_instructions: u32,
    /// Amount of cycles we are trying to execute.
    target_cycles: u32,
    /// Maximum instructions we should execute.
    max_instructions: u32,
    /// Last followed link, if any.
    last_followed_link: Option<BlockFn>,
    /// Whether the current block changed the instruction or data address space.
    address_space_changed: bool,
}

fn reset_address_space_links(ctx: &mut Context, clear_mappings: bool) {
    if clear_mappings {
        ctx.blocks.clear();
    } else {
        ctx.blocks.unlink_all();
    }
    ctx.shadow_stack.clear();
    ctx.last_followed_link = None;
    ctx.address_space_changed = true;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstructionFetchFault {
    Translation(TranslationFault),
    Unbacked {
        effective: Address,
        physical: Address,
    },
}

fn raise_instruction_fetch_fault(sys: &mut System, fault: InstructionFetchFault) -> bool {
    let InstructionFetchFault::Translation(fault) = fault else {
        return false;
    };
    match fault.instruction_storage_cause() {
        Some(cause) => {
            sys.cpu.raise_instruction_storage_exception(cause);
            true
        }
        None => false,
    }
}

const CTX_HOOKS: Hooks = {
    extern "C-unwind" fn get_registers<'a>(ctx: &'a mut Context) -> &'a mut Cpu {
        &mut ctx.sys.cpu
    }

    extern "C-unwind" fn get_fastmem<'a>(ctx: &'a mut Context) -> &'a FastmemLut {
        if ctx.sys.cpu.supervisor.config.msr.data_addr_translation() {
            ctx.sys.mem.data_fastmem_lut_logical_write()
        } else {
            ctx.sys.mem.data_fastmem_lut_physical_write()
        }
    }

    extern "C-unwind" fn exit(
        ctx: &mut Context,
        data: &mut ExitData,
        reason: ExitReason,
        block_executed: Executed,
    ) -> Option<BlockFn> {
        ctx.executed_cycles += block_executed.cycles as u32;
        ctx.executed_instructions += block_executed.instructions as u32;
        ctx.sys.scheduler.advance(block_executed.cycles as u64);

        // A yielded slow load preserves its current PC for a later retry. A normal synchronous
        // exit is linkable, which would otherwise tail-call that same load indefinitely while the
        // asynchronous producer is still pending.
        if reason == ExitReason::YIELD {
            ctx.last_followed_link = None;
            return None;
        }

        // should we exit?
        let has_pending = ctx.sys.scheduler.has_pending();
        let limits_reached = ctx.executed_cycles >= ctx.target_cycles
            || ctx.executed_instructions >= ctx.max_instructions;

        if has_pending || limits_reached || ctx.address_space_changed {
            std::hint::cold_path();
            return None;
        }

        // if not, first try detecting idle loops
        if matches!(
            data.linked_pattern,
            Pattern::IdleBasic | Pattern::IdleVolatileRead
        ) && ctx.last_followed_link == data.linked
        {
            std::hint::cold_path();

            let delta = if let Some(delta) = ctx.sys.scheduler.until_next() {
                delta
            } else {
                (ctx.target_cycles - ctx.executed_cycles) as u64
            }
            .min(ctx.target_cycles as u64);

            ctx.sys.scheduler.advance(delta);
            ctx.executed_cycles += delta as u32;
            return None;
        }

        let reason_kind = reason.kind();
        let reason_branch = reason.branch();

        // otherwise, try linking
        if data.linked.is_none() {
            std::hint::cold_path();

            // try linking
            match (reason_kind, reason_branch.indirect()) {
                // fixed address branching
                (ExitKind::Sync, _) | (ExitKind::Branch, false) => {
                    let source = ctx.sys.cpu.pc;
                    let logical = ctx.sys.cpu.supervisor.config.msr.instr_addr_translation();
                    if let Some(mapping) = ctx.blocks.get_mapping(logical, source) {
                        let stored = ctx.blocks.storage.get_mut(mapping.id.0).unwrap();
                        data.linked = Some(stored.inner.as_ptr());
                        data.linked_pattern = stored.inner.meta().pattern;
                        stored.linked_from.push(data);
                    }
                }
                // indirect branching
                (ExitKind::Branch, true) => (),
            }
        }

        // if it is a call, also push into shadow stack
        if reason_kind == ExitKind::Branch && reason_branch.call() {
            let target = Address(reason.address()) + 4;
            if data.linked_return.is_none() {
                std::hint::cold_path();
                let logical = ctx.sys.cpu.supervisor.config.msr.instr_addr_translation();
                if let Some(mapping) = ctx.blocks.get_mapping(logical, target) {
                    let stored = ctx.blocks.storage.get_mut(mapping.id.0).unwrap();
                    data.linked_return = Some(stored.inner.as_ptr());
                    stored.linked_return_from.push(data);
                }
            }

            if let Some(linked) = data.linked_return {
                ctx.shadow_stack.push((target, linked));
            }
        }

        // and finally, try following linked or shadow stack
        let linked =
            if reason_kind == ExitKind::Branch && !reason_branch.call() && reason_branch.indirect()
            {
                std::hint::cold_path();
                if let Some((addr, block)) = ctx.shadow_stack.pop()
                    && addr == ctx.sys.cpu.pc
                {
                    Some(block)
                } else {
                    ctx.shadow_stack.clear();
                    None
                }
            } else {
                data.linked
            };

        ctx.last_followed_link = linked;
        linked
    }

    extern "C-unwind" fn read<P: Primitive>(ctx: &mut Context, addr: Address, value: &mut P) -> u8 {
        let result = MachineRuntimeHooks::read_slow(ctx.sys, addr, value);
        match result.outcome {
            HookOutcome::Complete => READ_COMPLETE,
            HookOutcome::Yield => READ_YIELD,
            HookOutcome::Fault | HookOutcome::Invalidated => {
                std::hint::cold_path();
                tracing::error!(pc = ?ctx.sys.cpu.pc, dsisr = result.detail, "failed data read at {addr}");
                READ_FAULT
            }
        }
    }

    extern "C-unwind" fn write<P: Primitive>(ctx: &mut Context, addr: Address, value: P) -> bool {
        let result = MachineRuntimeHooks::write_slow(ctx.sys, addr, value);
        match result.outcome {
            HookOutcome::Complete => true,
            HookOutcome::Fault | HookOutcome::Yield | HookOutcome::Invalidated => {
                std::hint::cold_path();
                tracing::error!(pc = ?ctx.sys.cpu.pc, dsisr = result.detail, "failed data write at {addr}");
                false
            }
        }
    }

    extern "C-unwind" fn load_reserve(ctx: &mut Context, addr: Address, value: &mut i32) -> u8 {
        let result = MachineRuntimeHooks::load_reserve(ctx.sys, addr, value);
        match result.outcome {
            HookOutcome::Complete => LOAD_RESERVE_LOADED,
            HookOutcome::Yield => READ_YIELD,
            HookOutcome::Fault | HookOutcome::Invalidated => {
                std::hint::cold_path();
                tracing::error!(pc = ?ctx.sys.cpu.pc, dsisr = result.detail, "failed load-reserve access at {addr}");
                LOAD_RESERVE_FAULT
            }
        }
    }

    extern "C-unwind" fn store_conditional(ctx: &mut Context, addr: Address, value: i32) -> u8 {
        let mut stored = false;
        let result = MachineRuntimeHooks::store_conditional(ctx.sys, addr, value, &mut stored);
        match result.outcome {
            HookOutcome::Complete if stored => STORE_CONDITIONAL_STORED,
            HookOutcome::Complete => STORE_CONDITIONAL_NOT_STORED,
            HookOutcome::Fault | HookOutcome::Yield | HookOutcome::Invalidated => {
                std::hint::cold_path();
                tracing::error!(pc = ?ctx.sys.cpu.pc, dsisr = result.detail, "failed store-conditional access at {addr}");
                STORE_CONDITIONAL_FAULT
            }
        }
    }

    extern "C-unwind" fn read_quantized(
        ctx: &mut Context,
        addr: Address,
        gqr: QuantReg,
        value: &mut f64,
    ) -> u8 {
        let mut size = 0;
        let result = MachineRuntimeHooks::read_quantized(ctx.sys, addr, gqr, value, &mut size);
        if result.outcome != HookOutcome::Complete {
            std::hint::cold_path();
            tracing::error!(
                dsisr = result.detail,
                "failed quantized data read at {addr}"
            );
        }
        size
    }

    extern "C-unwind" fn write_quantized(
        ctx: &mut Context,
        addr: Address,
        gqr: QuantReg,
        value: f64,
    ) -> u8 {
        let mut size = 0;
        let result = MachineRuntimeHooks::write_quantized(ctx.sys, addr, gqr, value, &mut size);
        if result.outcome != HookOutcome::Complete {
            std::hint::cold_path();
            tracing::error!(
                dsisr = result.detail,
                "failed quantized data write at {addr}"
            );
        }
        size
    }

    extern "C-unwind" fn invalidate_icache(ctx: &mut Context, addr: Address) {
        let is_logical = ctx.sys.cpu.supervisor.config.msr.instr_addr_translation();
        let result = MachineRuntimeHooks::invalidate_instruction_cache_line(ctx.sys, addr);
        let invalidation = result.invalidation;
        let cacheline_base = Address(invalidation.effective);

        if is_logical {
            for offset in 0..32 {
                let logical = cacheline_base + offset;
                ctx.blocks.invalidate(true, logical);
                if invalidation.flags & INVALIDATION_HAS_PHYSICAL != 0 {
                    ctx.blocks
                        .invalidate(false, Address(invalidation.physical) + offset);
                }
            }

            if invalidation.flags & INVALIDATION_HAS_PHYSICAL != 0 {
                ctx.icache.invalidate(Address(invalidation.physical));
            }
        } else {
            for offset in 0..32 {
                let physical = cacheline_base + offset;
                ctx.blocks.invalidate(false, physical);
            }

            ctx.icache.invalidate(cacheline_base);
        }
    }

    extern "C-unwind" fn clear_icache(ctx: &mut Context) {
        ctx.icache.clear();
    }

    extern "C-unwind" fn tlbie(ctx: &mut Context, address: Address) {
        MachineRuntimeHooks::tlbie(ctx.sys, address);
        // The native cache does not yet index hashed dependencies by TLB set, so it still retires
        // every linked address-space edge. Translation residency itself is now exact and shared
        // with the browser machine.
        reset_address_space_links(ctx, true);
    }

    extern "C-unwind" fn tlbsync(ctx: &mut Context) {
        // The MPC750 has no local synchronization side effect when its external TLBISYNC input
        // permits execution to continue. The JIT boundary itself provides the ordering point.
        MachineRuntimeHooks::tlbsync(ctx.sys);
    }

    extern "C-unwind" fn dcache_dma(ctx: &mut Context) {
        MachineRuntimeHooks::locked_cache_dma(ctx.sys);
    }

    extern "C-unwind" fn msr_changed(ctx: &mut Context) {
        // The legacy native mapping key contains IR but not PR. Conservatively retire mappings on
        // every MSR publication so a privilege transition cannot reuse code translated in the
        // other address space. The browser-resident Rust directory uses full generations instead.
        ctx.sys.refresh_data_fastmem_luts();
        reset_address_space_links(ctx, true);
        ctx.sys.scheduler.schedule_now(system::pi::check_interrupts);
    }

    extern "C-unwind" fn sr_changed(ctx: &mut Context) {
        tracing::info!("segment registers changed - clearing blocks mapping");
        reset_address_space_links(ctx, true);
    }

    extern "C-unwind" fn sdr1_changed(ctx: &mut Context) {
        tracing::info!("SDR1 changed - clearing blocks mapping");
        reset_address_space_links(ctx, true);
    }

    extern "C-unwind" fn ibat_changed(ctx: &mut Context) {
        tracing::info!("ibats changed - clearing blocks mapping and rebuilding ibat lut");
        reset_address_space_links(ctx, true);
        ctx.sys
            .mem
            .build_inst_bat_lut(&ctx.sys.cpu.supervisor.memory.ibat);
    }

    extern "C-unwind" fn dbat_changed(ctx: &mut Context) {
        tracing::info!("dbats changed - rebuilding dbat lut");
        MachineRuntimeHooks::data_bat_changed(ctx.sys);
    }

    extern "C-unwind" fn dec_read(ctx: &mut Context) {
        ctx.sys.update_decrementer();
    }

    extern "C-unwind" fn dec_changed(ctx: &mut Context) {
        ctx.sys
            .decrementer_changed()
            .expect("native decrementer deadline overflowed scheduler time");
    }

    extern "C-unwind" fn tb_read(ctx: &mut Context) {
        ctx.sys.update_time_base();
    }

    extern "C-unwind" fn tb_changed(ctx: &mut Context) {
        ctx.sys.lazy.last_updated_tb = ctx.sys.scheduler.elapsed_time_base();
        tracing::info!("time base changed to {}", ctx.sys.cpu.supervisor.misc.tb);
    }

    #[expect(
        clippy::missing_transmute_annotations,
        reason = "unnecessary - the definitions are above"
    )]
    unsafe {
        use std::mem::transmute;

        let get_registers =
            transmute::<_, GetRegistersHook>(get_registers as extern "C-unwind" fn(_) -> _);
        let get_fastmem =
            transmute::<_, GetFastmemHook>(get_fastmem as extern "C-unwind" fn(_) -> _);

        let exit = transmute::<_, ExitHook>(exit as extern "C-unwind" fn(_, _, _, _) -> _);

        let read_i8 =
            transmute::<_, ReadHook<i8>>(read::<i8> as extern "C-unwind" fn(_, _, _) -> _);
        let write_i8 =
            transmute::<_, WriteHook<i8>>(write::<i8> as extern "C-unwind" fn(_, _, _) -> _);
        let read_i16 =
            transmute::<_, ReadHook<i16>>(read::<i16> as extern "C-unwind" fn(_, _, _) -> _);
        let write_i16 =
            transmute::<_, WriteHook<i16>>(write::<i16> as extern "C-unwind" fn(_, _, _) -> _);
        let read_i32 =
            transmute::<_, ReadHook<i32>>(read::<i32> as extern "C-unwind" fn(_, _, _) -> _);
        let write_i32 =
            transmute::<_, WriteHook<i32>>(write::<i32> as extern "C-unwind" fn(_, _, _) -> _);
        let read_i64 =
            transmute::<_, ReadHook<i64>>(read::<i64> as extern "C-unwind" fn(_, _, _) -> _);
        let write_i64 =
            transmute::<_, WriteHook<i64>>(write::<i64> as extern "C-unwind" fn(_, _, _) -> _);
        let load_reserve =
            transmute::<_, ReadHook<i32>>(load_reserve as extern "C-unwind" fn(_, _, _) -> _);
        let store_conditional = transmute::<_, StoreConditionalHook>(
            store_conditional as extern "C-unwind" fn(_, _, _) -> _,
        );
        let read_quantized = transmute::<_, ReadQuantizedHook>(
            read_quantized as extern "C-unwind" fn(_, _, _, _) -> _,
        );
        let write_quantized = transmute::<_, WriteQuantizedHook>(
            write_quantized as extern "C-unwind" fn(_, _, _, _) -> _,
        );

        let invalidate_icache =
            transmute::<_, InvalidateICache>(invalidate_icache as extern "C-unwind" fn(_, _));
        let tlbie = transmute::<_, InvalidateICache>(tlbie as extern "C-unwind" fn(_, _));
        let tlbsync = transmute::<_, GenericHook>(tlbsync as extern "C-unwind" fn(_));
        let clear_icache = transmute::<_, GenericHook>(clear_icache as extern "C-unwind" fn(_));
        let dcache_dma = transmute::<_, GenericHook>(dcache_dma as extern "C-unwind" fn(_));

        let msr_changed = transmute::<_, GenericHook>(msr_changed as extern "C-unwind" fn(_));

        let sr_changed = transmute::<_, GenericHook>(sr_changed as extern "C-unwind" fn(_));
        let sdr1_changed = transmute::<_, GenericHook>(sdr1_changed as extern "C-unwind" fn(_));

        let ibat_changed = transmute::<_, GenericHook>(ibat_changed as extern "C-unwind" fn(_));
        let dbat_changed = transmute::<_, GenericHook>(dbat_changed as extern "C-unwind" fn(_));

        let tb_read = transmute::<_, GenericHook>(tb_read as extern "C-unwind" fn(_));
        let tb_changed = transmute::<_, GenericHook>(tb_changed as extern "C-unwind" fn(_));

        let dec_read = transmute::<_, GenericHook>(dec_read as extern "C-unwind" fn(_));
        let dec_changed = transmute::<_, GenericHook>(dec_changed as extern "C-unwind" fn(_));

        Hooks {
            get_registers,
            get_fastmem,

            exit,

            read_i8,
            write_i8,
            read_i16,
            write_i16,
            read_i32,
            write_i32,
            read_i64,
            write_i64,
            load_reserve,
            store_conditional,
            read_quantized,
            write_quantized,

            invalidate_icache,
            tlbie,
            tlbsync,
            clear_icache,
            dcache_dma,

            msr_changed,

            sr_changed,
            sdr1_changed,

            ibat_changed,
            dbat_changed,

            tb_read,
            tb_changed,

            dec_read,
            dec_changed,
        }
    }
};

/// JIT configuration.
pub struct Settings {
    /// Maximum number of instructions per JIT block.
    pub instr_per_block: u32,
    /// Codegen settings.
    pub codegen: ppcjit::CodegenSettings,
    /// Path to the block cache directory.
    pub cache_path: Option<PathBuf>,
}

pub struct Core {
    pub settings: Settings,
    pub compiler: ppcjit::Jit,
    pub blocks: Blocks,
    pub icache: icache::Cache,
    pub shadow_stack: Vec<(Address, BlockFn)>,
}

fn closest_breakpoint(pc: Address, breakpoints: &[Address]) -> Address {
    let mut closest_breakpoint = Address(pc.value().saturating_add(u32::MAX));
    let mut closest_distance = closest_breakpoint.value() - pc.value();
    for breakpoint in breakpoints.iter().copied() {
        let distance = breakpoint.value().checked_sub(pc.value());
        if let Some(distance) = distance
            && distance <= closest_distance
            && distance != 0
        {
            closest_breakpoint = breakpoint;
            closest_distance = distance;
        }
    }

    closest_breakpoint
}

impl Core {
    pub fn new(settings: Settings) -> Self {
        let compiler = ppcjit::Jit::new(
            ppcjit::Settings {
                codegen: settings.codegen.clone(),
                cache_path: settings.cache_path.clone(),
                exit_data_layout: Layout::new::<ExitData>(),
            },
            CTX_HOOKS,
        );

        Self {
            settings,
            compiler,
            blocks: Blocks::default(),
            icache: Default::default(),
            shadow_stack: Vec::new(),
        }
    }

    /// Compiles a sequence of at most `limit` instructions starting at `addr` into a JIT block.
    fn compile(
        &mut self,
        sys: &mut System,
        addr: Address,
        limit: u32,
    ) -> Result<ppcjit::Block, InstructionFetchFault> {
        let _span = tracing::trace_span!("compiling new block", addr = ?sys.cpu.pc).entered();

        let mut count = 0;
        let mut fetch_fault = None;
        let instructions = std::iter::from_fn(|| {
            if count >= limit {
                return None;
            }

            let current = addr + 4 * count;
            let mapping =
                match sys.translate_instruction_mmu(current, TranslationEffect::Architectural) {
                    Ok(mapping) => mapping,
                    Err(fault) => {
                        tracing::error!(?fault, "failed to translate {current} at {addr}");
                        fetch_fault = Some(InstructionFetchFault::Translation(fault));
                        return None;
                    }
                };
            let physical = Address(mapping.physical);

            let Some(ins) = self.icache.get(sys, physical) else {
                let fault = InstructionFetchFault::Unbacked {
                    effective: current,
                    physical,
                };
                tracing::error!(
                    ?fault,
                    "instruction fetch reached unbacked physical storage"
                );
                fetch_fault = Some(fault);
                return None;
            };
            count += 1;

            Some(ins)
        });

        let block = match self.compiler.build(instructions) {
            Ok(b) => b,
            Err(e) => match e {
                ppcjit::BuildError::EmptyBlock => {
                    if let Some(fault) = fetch_fault {
                        return Err(fault);
                    }
                    panic!("built empty block at pc {}", sys.cpu.pc)
                }
                ppcjit::BuildError::Builder { source } => {
                    panic!("block builder error at pc {}: {}", sys.cpu.pc, source)
                }
                ppcjit::BuildError::Codegen {
                    source,
                    sequence,
                    clir,
                } => {
                    panic!(
                        "block codegen error:\n{}\n{}\n{:?}",
                        sequence,
                        clir.as_deref().unwrap_or("<missing clir>"),
                        source,
                    )
                }
            },
        };

        tracing::trace!(
            instructions = block.meta().seq.len(),
            "block sequence built"
        );

        Ok(block)
    }

    #[inline(always)]
    fn uncached_exec(
        &mut self,
        sys: &mut System,
        target_cycles: u32,
        max_instructions: u32,
        _force_no_link: bool,
    ) -> Info {
        let logical = sys.cpu.supervisor.config.msr.instr_addr_translation();
        let stored = self
            .blocks
            .get(logical, sys.cpu.pc)
            .filter(|b| b.inner.meta().seq.len() <= max_instructions as usize);

        let compiled: ppcjit::Block;
        let block = match stored {
            Some(stored) => stored.inner.as_ptr(),
            None => {
                std::hint::cold_path();

                compiled = match self.compile(sys, sys.cpu.pc, max_instructions) {
                    Ok(block) => block,
                    Err(fault) => {
                        if !raise_instruction_fetch_fault(sys, fault) {
                            panic!(
                                "instruction fetch reached non-architectural host storage at {}: {fault:?}",
                                sys.cpu.pc
                            );
                        }
                        return Info::default();
                    }
                };
                compiled.as_ptr()
            }
        };

        let mut ctx = Context {
            sys,
            blocks: &mut self.blocks,
            icache: &mut self.icache,
            shadow_stack: &mut self.shadow_stack,
            executed_cycles: 0,
            executed_instructions: 0,
            target_cycles,
            max_instructions,
            last_followed_link: None,
            address_space_changed: false,
        };

        unsafe {
            self.compiler
                .call(&raw mut ctx as *mut ppcjit::hooks::Context, block);
        }

        Info {
            executed_cycles: Cycles(ctx.executed_cycles as u64),
            executed_instructions: ctx.executed_instructions,
            hit_breakpoint: false,
        }
    }

    fn cached_exec(
        &mut self,
        sys: &mut System,
        target_cycles: u32,
        max_instructions: u32,
        force_no_link: bool,
    ) -> Info {
        let logical = sys.cpu.supervisor.config.msr.instr_addr_translation();
        let block = self
            .blocks
            .get(logical, sys.cpu.pc)
            .filter(|b| b.inner.meta().seq.len() <= max_instructions as usize);

        if block.is_none() {
            // avoid trying to compile unimplemented instructions in debug mode
            let instructions = if cfg!(debug_assertions) {
                self.settings.instr_per_block.min(max_instructions)
            } else {
                self.settings.instr_per_block
            };

            match self.compile(sys, sys.cpu.pc, instructions) {
                Ok(block) => {
                    self.blocks.insert(logical, sys.cpu.pc, block);
                }
                Err(fault) => {
                    if !raise_instruction_fetch_fault(sys, fault) {
                        panic!(
                            "instruction fetch reached non-architectural host storage at {}: {fault:?}",
                            sys.cpu.pc
                        );
                    }
                    return Info::default();
                }
            }
        }

        self.uncached_exec(sys, target_cycles, max_instructions, force_no_link)
    }

    fn exec_inner<const BREAKPOINTS: bool>(
        &mut self,
        sys: &mut System,
        cycles: Cycles,
        breakpoints: &[Address],
    ) -> Info {
        let max_instructions = if BREAKPOINTS {
            let closest_breakpoint = closest_breakpoint(sys.cpu.pc, breakpoints);
            (closest_breakpoint.value() - sys.cpu.pc.value()) / 4
        } else {
            u32::MAX
        };

        // execute
        let mut info = self.cached_exec(sys, cycles.0 as u32, max_instructions, BREAKPOINTS);
        if BREAKPOINTS && breakpoints.contains(&sys.cpu.pc) {
            info.hit_breakpoint = true;
        }

        info
    }
}

impl CpuCore for Core {
    fn exec(&mut self, sys: &mut System, cycles: Cycles, breakpoints: &[Address]) -> Info {
        if breakpoints.is_empty() {
            self.exec_inner::<false>(sys, cycles, &[])
        } else {
            self.exec_inner::<true>(sys, cycles, breakpoints)
        }
    }

    fn step(&mut self, sys: &mut System) -> Info {
        let info = self.uncached_exec(sys, u32::MAX, 1, true);
        sys.process_events();

        info
    }
}

#[cfg(test)]
mod tests {
    use lazuli::gekko::disasm::{Extensions, Ins};
    use lazuli::gekko::{Bat, CondReg, SPR};
    use lazuli::modules::audio::NopAudioModule;
    use lazuli::modules::debug::NopDebugModule;
    use lazuli::modules::disk::NopDiskModule;
    use lazuli::modules::input::NopInputModule;
    use lazuli::modules::render::NopRenderModule;
    use lazuli::modules::vertex::NopVertexModule;
    use lazuli::system::{Config, Modules};

    use super::*;

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
                ipl_lle: false,
                ipl: None,
                sideload: None,
                perform_efb_copies: false,
                uart_escape: false,
            },
        )
    }

    fn run_one(sys: &mut System, instruction: u32) {
        sys.cpu.pc = Address(0);
        sys.write_phys_slow(Address(0), instruction);
        let mut core = Core::new(Settings {
            instr_per_block: 1,
            codegen: ppcjit::CodegenSettings::default(),
            cache_path: None,
        });
        let info = core.step(sys);
        assert_eq!(info.executed_instructions, 1);
    }

    fn lwarx(rd: u8, ra: u8, rb: u8) -> u32 {
        31 << 26 | u32::from(rd) << 21 | u32::from(ra) << 16 | u32::from(rb) << 11 | 20 << 1
    }

    fn stwcx(rs: u8, ra: u8, rb: u8) -> u32 {
        31 << 26 | u32::from(rs) << 21 | u32::from(ra) << 16 | u32::from(rb) << 11 | 150 << 1 | 1
    }

    fn lwz(rd: u8, ra: u8, displacement: i16) -> u32 {
        32 << 26 | u32::from(rd) << 21 | u32::from(ra) << 16 | u32::from(displacement as u16)
    }

    fn stw(rs: u8, ra: u8, displacement: i16) -> u32 {
        36 << 26 | u32::from(rs) << 21 | u32::from(ra) << 16 | u32::from(displacement as u16)
    }

    fn mtspr(rs: u8, spr: u16) -> u32 {
        let encoded = (u32::from(spr) & 0x1f) << 16 | (u32::from(spr) >> 5) << 11;
        31 << 26 | u32::from(rs) << 21 | encoded | 467 << 1
    }

    fn psq(opcode: u32, fr: u8, ra: u8, displacement: i16, w: bool, gqr: u8) -> u32 {
        opcode << 26
            | u32::from(fr) << 21
            | u32::from(ra) << 16
            | u32::from(w) << 15
            | u32::from(gqr & 7) << 12
            | u32::from(displacement as u16 & 0x0fff)
    }

    fn psq_l(fd: u8, ra: u8, displacement: i16, w: bool, gqr: u8) -> u32 {
        psq(56, fd, ra, displacement, w, gqr)
    }

    fn psq_st(fs: u8, ra: u8, displacement: i16, w: bool, gqr: u8) -> u32 {
        psq(60, fs, ra, displacement, w, gqr)
    }

    fn bat(upper: u32, lower: u32) -> Bat {
        Bat::from_bits(u64::from(upper) << 32 | u64::from(lower))
    }

    #[test]
    fn clearing_address_space_mappings_unlinks_stale_exit_targets() {
        let mut core = Core::new(Settings {
            instr_per_block: 1,
            codegen: ppcjit::CodegenSettings::default(),
            cache_path: None,
        });
        let target = core
            .compiler
            .build([Ins::new(0x6000_0000, Extensions::gekko_broadway())].into_iter())
            .unwrap();
        let target_ptr = target.as_ptr();
        let target_id = core.blocks.insert(false, Address(0x1000), target);
        let mut source_exit = ExitData {
            linked: Some(target_ptr),
            linked_pattern: Pattern::Call,
            linked_return: Some(target_ptr),
        };
        let target = &mut core.blocks.storage[target_id.0];
        target.linked_from.push(&raw mut source_exit);
        target.linked_return_from.push(&raw mut source_exit);

        core.blocks.clear();

        assert_eq!(source_exit.linked, None);
        assert_eq!(source_exit.linked_pattern, Pattern::None);
        assert_eq!(source_exit.linked_return, None);
        assert!(core.blocks.get_mapping(false, Address(0x1000)).is_none());
        assert!(core.blocks.storage[target_id.0].linked_from.is_empty());
        assert!(
            core.blocks.storage[target_id.0]
                .linked_return_from
                .is_empty()
        );
    }

    #[test]
    fn native_mtspr_decrementer_uses_global_time_base_phase() {
        let mut system = test_system();
        system.scheduler.cancel(lazuli::system::gx::cmd::process);
        system.scheduler.advance(5);
        system.cpu.user.gpr[3] = 2;

        run_one(&mut system, mtspr(3, SPR::DEC as u16));

        assert_eq!(system.cpu.supervisor.misc.dec, 2);
        assert_eq!(system.lazy.last_updated_dec, 0);
        assert_eq!(system.scheduler.elapsed(), 6);
        assert_eq!(system.scheduler.until_next(), Some(30));
    }

    #[test]
    fn native_reservation_instructions_preserve_state_across_precise_faults() {
        let mut sys = test_system();
        let reserved = Address(0x40);
        let unbacked = Address(0x1000_0000);

        sys.cpu.user.gpr[3] = unbacked.value();
        sys.cpu.user.gpr[4] = 0xdead_beef;
        sys.cpu.reservation.reserve(reserved);
        sys.cpu.supervisor.exception.dsisr = 0xfeed_face;
        run_one(&mut sys, lwarx(4, 0, 3));
        assert_eq!(sys.cpu.user.gpr[4], 0xdead_beef);
        assert_eq!(sys.cpu.reservation.physical_granule(), Some(reserved));
        assert_eq!(sys.cpu.supervisor.exception.dar, unbacked.value());
        assert_eq!(sys.cpu.supervisor.exception.dsisr, 0);

        sys.cpu = Cpu::default();
        sys.cpu.user.gpr[3] = unbacked.value();
        sys.cpu.user.gpr[4] = 0x1122_3344;
        sys.cpu.user.cr = CondReg::from_bits(0xafff_ffff);
        sys.cpu.reservation.reserve(reserved);
        run_one(&mut sys, stwcx(4, 0, 3));
        assert_eq!(sys.cpu.user.cr.to_bits(), 0xafff_ffff);
        assert_eq!(sys.cpu.reservation.physical_granule(), Some(reserved));
        assert_eq!(sys.cpu.supervisor.exception.dar, unbacked.value());
        assert_eq!(sys.cpu.supervisor.exception.dsisr, 0x0200_0000);

        // Without a reservation, write translation completes but unbacked physical storage is
        // deliberately not probed, so stwcx. completes as failed rather than raising DSI.
        sys.cpu = Cpu::default();
        sys.cpu.user.gpr[3] = unbacked.value();
        sys.cpu.user.gpr[4] = 0x5566_7788;
        sys.cpu.supervisor.exception.dsisr = 0xcafe_babe;
        run_one(&mut sys, stwcx(4, 0, 3));
        assert_eq!(sys.cpu.pc, Address(4));
        assert_eq!(sys.cpu.supervisor.exception.dsisr, 0xcafe_babe);
        assert!(!sys.cpu.user.cr.fields()[7].eq());

        let effective = Address(0x9000_0020);
        sys.cpu = Cpu::default();
        sys.cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        sys.cpu.supervisor.config.msr.set_user_mode(true);
        sys.cpu.supervisor.memory.dbat[0] = bat(0x9000_0001, 0x0000_0001);
        sys.cpu.user.gpr[3] = effective.value();
        sys.cpu.user.gpr[4] = 0xaabb_ccdd;
        sys.cpu.user.cr = CondReg::from_bits(0xafff_ffff);
        sys.cpu.reservation.reserve(reserved);
        run_one(&mut sys, stwcx(4, 0, 3));
        assert_eq!(sys.cpu.user.cr.to_bits(), 0xafff_ffff);
        assert_eq!(sys.cpu.reservation.physical_granule(), Some(reserved));
        assert_eq!(sys.cpu.supervisor.exception.dar, effective.value());
        assert_eq!(sys.cpu.supervisor.exception.dsisr, 0x0a00_0000);

        // Protection remains a fault even when no reservation is live.
        sys.cpu = Cpu::default();
        sys.cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        sys.cpu.supervisor.config.msr.set_user_mode(true);
        sys.cpu.supervisor.memory.dbat[0] = bat(0x9000_0001, 0x0000_0001);
        sys.cpu.user.gpr[3] = effective.value();
        sys.cpu.user.gpr[4] = 0x0102_0304;
        sys.cpu.user.cr = CondReg::from_bits(0xafff_ffff);
        run_one(&mut sys, stwcx(4, 0, 3));
        assert_eq!(sys.cpu.user.cr.to_bits(), 0xafff_ffff);
        assert_eq!(sys.cpu.supervisor.exception.dsisr, 0x0a00_0000);

        sys.cpu = Cpu::default();
        sys.cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        sys.cpu.supervisor.config.msr.set_user_mode(true);
        sys.cpu.supervisor.memory.dbat[0] = bat(0x9000_0001, 0x0000_0000);
        sys.cpu.user.gpr[3] = effective.value();
        sys.cpu.user.gpr[4] = 0x1357_9bdf;
        sys.cpu.reservation.reserve(reserved);
        run_one(&mut sys, lwarx(4, 0, 3));
        assert_eq!(sys.cpu.user.gpr[4], 0x1357_9bdf);
        assert_eq!(sys.cpu.reservation.physical_granule(), Some(reserved));
        assert_eq!(sys.cpu.supervisor.exception.dar, effective.value());
        assert_eq!(sys.cpu.supervisor.exception.dsisr, 0x0800_0000);
    }

    #[test]
    fn native_reservation_instructions_use_checked_ram_backing() {
        let mut sys = test_system();
        let address = Address(0x100);
        sys.write_phys_slow(address, 0x1122_3344u32);
        sys.cpu.user.gpr[3] = address.value();

        run_one(&mut sys, lwarx(4, 0, 3));
        assert_eq!(sys.cpu.user.gpr[4], 0x1122_3344);
        assert_eq!(sys.cpu.reservation.physical_granule(), Some(Address(0x100)));

        sys.cpu.user.gpr[4] = 0xaabb_ccdd;
        run_one(&mut sys, stwcx(4, 0, 3));
        assert_eq!(sys.read_phys_slow::<u32>(address), 0xaabb_ccdd);
        assert!(!sys.cpu.reservation.is_valid());
        assert!(sys.cpu.user.cr.fields()[7].eq());
    }

    #[test]
    fn native_scalar_hooks_publish_precise_data_storage_causes() {
        let effective = Address(0x9000_1000);

        let mut load = test_system();
        load.cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        load.cpu.supervisor.config.msr.set_exception_prefix(false);
        load.cpu.user.gpr[3] = effective.value();
        load.cpu.user.gpr[4] = 0xdead_beef;
        run_one(&mut load, lwz(4, 3, 0));
        assert_eq!(load.cpu.pc, Address(0x0000_0300));
        assert_eq!(load.cpu.supervisor.exception.srr[0], 0);
        assert_eq!(load.cpu.supervisor.exception.dar, effective.value());
        assert_eq!(load.cpu.supervisor.exception.dsisr, 0x4000_0000);
        assert_eq!(load.cpu.user.gpr[4], 0xdead_beef);

        let mut store = test_system();
        store
            .cpu
            .supervisor
            .config
            .msr
            .set_data_addr_translation(true);
        store.cpu.supervisor.config.msr.set_exception_prefix(false);
        store.cpu.user.gpr[3] = effective.value();
        store.cpu.user.gpr[4] = 0x1122_3344;
        run_one(&mut store, stw(4, 3, 0));
        assert_eq!(store.cpu.pc, Address(0x0000_0300));
        assert_eq!(store.cpu.supervisor.exception.srr[0], 0);
        assert_eq!(store.cpu.supervisor.exception.dar, effective.value());
        assert_eq!(store.cpu.supervisor.exception.dsisr, 0x4200_0000);
    }

    #[test]
    fn native_data_accesses_publish_protection_direct_store_and_quantized_causes() {
        let protected = Address(0x9000_0020);

        for (instruction, expected) in [(lwz(4, 3, 0), 0x0800_0000), (stw(4, 3, 0), 0x0a00_0000)] {
            let mut sys = test_system();
            sys.cpu
                .supervisor
                .config
                .msr
                .set_data_addr_translation(true);
            sys.cpu.supervisor.config.msr.set_exception_prefix(false);
            sys.cpu.supervisor.memory.dbat[0] = bat(0x9000_0002, 0x0000_0000);
            sys.cpu.user.gpr[3] = protected.value();
            sys.cpu.user.gpr[4] = 0x1122_3344;
            run_one(&mut sys, instruction);
            assert_eq!(sys.cpu.pc, Address(0x0000_0300));
            assert_eq!(sys.cpu.supervisor.exception.srr[0], 0);
            assert_eq!(sys.cpu.supervisor.exception.dar, protected.value());
            assert_eq!(sys.cpu.supervisor.exception.dsisr, expected);
        }

        let direct_store = Address(0x9000_1000);
        for (instruction, expected) in [(lwz(4, 3, 0), 0x0400_0000), (stw(4, 3, 0), 0x0600_0000)] {
            let mut sys = test_system();
            sys.cpu
                .supervisor
                .config
                .msr
                .set_data_addr_translation(true);
            sys.cpu.supervisor.config.msr.set_exception_prefix(false);
            sys.cpu.supervisor.memory.sr[9] = 0x8000_0000;
            sys.cpu.user.gpr[3] = direct_store.value();
            sys.cpu.user.gpr[4] = 0x5566_7788;
            run_one(&mut sys, instruction);
            assert_eq!(sys.cpu.pc, Address(0x0000_0300));
            assert_eq!(sys.cpu.supervisor.exception.srr[0], 0);
            assert_eq!(sys.cpu.supervisor.exception.dar, direct_store.value());
            assert_eq!(sys.cpu.supervisor.exception.dsisr, expected);
        }

        let paged = Address(0x9000_2000);
        for (instruction, expected) in [
            (psq_l(1, 3, 0, true, 0), 0x4000_0000),
            (psq_st(1, 3, 0, true, 0), 0x4200_0000),
        ] {
            let mut sys = test_system();
            sys.cpu
                .supervisor
                .config
                .msr
                .set_data_addr_translation(true);
            sys.cpu.supervisor.config.msr.set_float_available(true);
            sys.cpu.supervisor.config.msr.set_exception_prefix(false);
            sys.cpu.user.gpr[3] = paged.value();
            run_one(&mut sys, instruction);
            assert_eq!(sys.cpu.pc, Address(0x0000_0300));
            assert_eq!(sys.cpu.supervisor.exception.srr[0], 0);
            assert_eq!(sys.cpu.supervisor.exception.dar, paged.value());
            assert_eq!(sys.cpu.supervisor.exception.dsisr, expected);
        }
    }

    #[test]
    fn first_instruction_page_fault_enters_isi_and_retries_after_rfi() {
        const RFI: u32 = 0x4c00_0064;
        const NOP: u32 = 0x6000_0000;

        let mut sys = test_system();
        let effective = Address(0x8000_1000);
        let physical_page = 0x0000_2000;
        let segment = 0x0012_3456;
        sys.cpu.pc = effective;
        sys.cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(true);
        sys.cpu.supervisor.config.msr.set_exception_prefix(false);
        sys.cpu.supervisor.memory.sr[8] = segment;
        sys.write_phys_slow(Address(0x400), RFI);

        let mut core = Core::new(Settings {
            instr_per_block: 1,
            codegen: ppcjit::CodegenSettings::default(),
            cache_path: None,
        });
        let fault = core.step(&mut sys);
        assert_eq!(fault.executed_instructions, 0);
        assert_eq!(sys.cpu.pc, Address(0x0000_0400));
        assert_eq!(sys.cpu.supervisor.exception.srr[0], effective.value());
        assert_eq!(
            sys.cpu.supervisor.exception.srr[1] & gekko::Exception::SPECIAL_SRR1_BITS_MASK,
            0x4000_0000
        );

        let vector = system::mmu::page_table_vector(effective.value(), segment, 0);
        sys.write_phys_slow(Address(vector.primary_pteg), vector.primary_pte0);
        sys.write_phys_slow(Address(vector.primary_pteg + 4), physical_page | 2);
        sys.write_phys_slow(Address(physical_page), NOP);

        let returned = core.step(&mut sys);
        assert_eq!(returned.executed_instructions, 1);
        assert_eq!(sys.cpu.pc, effective);
        assert!(sys.cpu.supervisor.config.msr.instr_addr_translation());

        let retried = core.step(&mut sys);
        assert_eq!(retried.executed_instructions, 1);
        assert_eq!(sys.cpu.pc, effective + 4);
        assert_eq!(
            sys.read_phys_slow::<u32>(Address(vector.primary_pteg + 4)),
            physical_page | 0x0100 | 2
        );
    }

    #[test]
    fn first_instruction_permission_faults_publish_exact_isi_causes() {
        let effective = Address(0x9000_1000);

        for segment in [0x8000_0000, 0x1000_0000] {
            let mut sys = test_system();
            sys.cpu.pc = effective;
            sys.cpu
                .supervisor
                .config
                .msr
                .set_instr_addr_translation(true);
            sys.cpu.supervisor.config.msr.set_exception_prefix(false);
            sys.cpu.supervisor.memory.sr[9] = segment;

            let mut core = Core::new(Settings {
                instr_per_block: 1,
                codegen: ppcjit::CodegenSettings::default(),
                cache_path: None,
            });
            let fault = core.step(&mut sys);
            assert_eq!(fault.executed_instructions, 0);
            assert_eq!(sys.cpu.pc, Address(0x0000_0400));
            assert_eq!(sys.cpu.supervisor.exception.srr[0], effective.value());
            assert_eq!(
                sys.cpu.supervisor.exception.srr[1] & gekko::Exception::SPECIAL_SRR1_BITS_MASK,
                0x1000_0000
            );
        }

        let mut protected = test_system();
        protected.cpu.pc = effective;
        protected
            .cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(true);
        protected
            .cpu
            .supervisor
            .config
            .msr
            .set_exception_prefix(false);
        protected.cpu.supervisor.memory.ibat[0] = bat(0x9000_0002, 0x0000_0000);
        let mut core = Core::new(Settings {
            instr_per_block: 1,
            codegen: ppcjit::CodegenSettings::default(),
            cache_path: None,
        });
        let fault = core.step(&mut protected);
        assert_eq!(fault.executed_instructions, 0);
        assert_eq!(protected.cpu.pc, Address(0x0000_0400));
        assert_eq!(protected.cpu.supervisor.exception.srr[0], effective.value());
        assert_eq!(
            protected.cpu.supervisor.exception.srr[1] & gekko::Exception::SPECIAL_SRR1_BITS_MASK,
            0x0800_0000
        );

        let mut guarded = test_system();
        let segment = 0x0012_3456;
        let physical_page = 0x0000_2000;
        guarded.cpu.pc = effective;
        guarded
            .cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(true);
        guarded
            .cpu
            .supervisor
            .config
            .msr
            .set_exception_prefix(false);
        guarded.cpu.supervisor.memory.sr[9] = segment;
        let vector = system::mmu::page_table_vector(effective.value(), segment, 0);
        guarded.write_phys_slow(Address(vector.primary_pteg), vector.primary_pte0);
        guarded.write_phys_slow(Address(vector.primary_pteg + 4), physical_page | 0x0a);
        let mut core = Core::new(Settings {
            instr_per_block: 1,
            codegen: ppcjit::CodegenSettings::default(),
            cache_path: None,
        });
        let fault = core.step(&mut guarded);
        assert_eq!(fault.executed_instructions, 0);
        assert_eq!(guarded.cpu.pc, Address(0x0000_0400));
        assert_eq!(guarded.cpu.supervisor.exception.srr[0], effective.value());
        assert_eq!(
            guarded.cpu.supervisor.exception.srr[1] & gekko::Exception::SPECIAL_SRR1_BITS_MASK,
            0x1000_0000
        );
    }

    #[test]
    fn translated_unbacked_instruction_storage_never_becomes_zero_code() {
        let mut sys = test_system();
        let effective = Address(0x9000_0000);
        let physical = Address(0x1000_0000);
        sys.cpu.pc = effective;
        sys.cpu
            .supervisor
            .config
            .msr
            .set_instr_addr_translation(true);
        sys.cpu.supervisor.memory.ibat[0] = bat(0x9000_0002, 0x1000_0002);

        let mut core = Core::new(Settings {
            instr_per_block: 1,
            codegen: ppcjit::CodegenSettings::default(),
            cache_path: None,
        });
        let result = core.compile(&mut sys, effective, 1);
        assert_eq!(
            result.err(),
            Some(InstructionFetchFault::Unbacked {
                effective,
                physical,
            })
        );
        assert_eq!(sys.cpu.pc, effective);
    }
}
