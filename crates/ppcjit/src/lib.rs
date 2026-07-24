#![feature(debug_closure_helpers)]
#![feature(maybe_uninit_array_assume_init)]

mod builder;
#[cfg(feature = "native")]
mod cache;
#[cfg(feature = "native")]
mod module;
mod sequence;
#[cfg(feature = "native")]
mod unwind;

#[cfg(all(test, feature = "native"))]
mod test;
#[cfg(test)]
mod translation_test;

pub mod block;
pub mod hooks;

use std::ptr::NonNull;
#[cfg(feature = "native")]
use std::{alloc::Layout, path::PathBuf, sync::Arc};

#[cfg(feature = "native")]
use cranelift_codegen::entity::PrimaryMap;
#[cfg(feature = "native")]
use cranelift_codegen::ir::InstBuilder;
use cranelift_codegen::isa::CallConv;
#[cfg(feature = "native")]
use cranelift_codegen::isa::TargetIsa;
#[cfg(feature = "native")]
use cranelift_codegen::settings::Configurable;
use cranelift_codegen::{self as codegen, ir};
use cranelift_frontend as frontend;
#[cfg(feature = "native")]
use cranelift_native as native;
use easyerr::{Error, ResultExt};
use gekko::disasm::Ins;
#[cfg(feature = "native")]
use gekko::{Cpu, Exception};
#[cfg(feature = "native")]
use serde::{Deserialize, Serialize};

#[cfg(feature = "native")]
pub use crate::block::Block;
#[cfg(feature = "native")]
use crate::block::{BlockFn, Meta, Trampoline};
use crate::builder::BlockBuilder;
#[cfg(feature = "native")]
use crate::cache::{ArtifactKey, Cache};
#[cfg(feature = "native")]
use crate::hooks::{Context, HookKind, HookSignatures, Hooks};
#[cfg(feature = "native")]
use crate::module::Module;
pub use crate::sequence::Sequence;
#[cfg(feature = "native")]
use crate::unwind::UnwindHandle;

#[derive(Debug, Clone, PartialEq, Hash)]
pub struct CodegenSettings {
    /// Whether to treat `sc` instructions as no-ops.
    pub nop_syscalls: bool,
    /// Whether to ignore the FPU enabled bit in MSR.
    pub force_fpu: bool,
    /// Whether to ignore unimplemented instructions instead of panicking.
    pub ignore_unimplemented: bool,
    /// Whether to perform round to single operations.
    pub round_to_single: bool,
}

impl Default for CodegenSettings {
    fn default() -> Self {
        Self {
            nop_syscalls: false,
            force_fpu: false,
            ignore_unimplemented: false,
            round_to_single: false,
        }
    }
}

/// How translated blocks leave the generated function.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitMode {
    /// Call the native runtime exit hook and optionally tail-link to another compiled block.
    Native,
    /// Return the packed execution counters directly to the caller.
    ///
    /// The returned `i32` stores the instruction count in bits 0..16 and the cycle count in bits
    /// 16..32, matching [`block::Executed`]. The exit reason is reflected in the flushed CPU state,
    /// most importantly the program counter. Calls required by individual instruction semantics
    /// can still appear in the CLIF and must be implemented or rejected by the consumer. Guest
    /// memory accesses use the supplied fast-memory LUT directly, so every accessed page must have
    /// a valid entry; this mode does not emit the native slow-memory fallback.
    ReturnExecuted,
    /// Return packed execution counters and branch to runtime hooks for unmapped fast-memory pages.
    ReturnExecutedWithSlowMemory,
}

/// Target-independent inputs needed by the PowerPC-to-CLIF frontend.
#[derive(Debug, Clone)]
pub struct TranslationConfig {
    /// PowerPC semantic/code generation settings.
    pub settings: CodegenSettings,
    /// The pointer type used for context, register, and fast-memory pointers.
    pub pointer_type: ir::Type,
    /// Calling convention used by runtime hooks and by portable returned blocks.
    pub call_conv: CallConv,
    /// How generated blocks exit.
    pub exit_mode: ExitMode,
    /// Optional byte offset in the caller context where portable semantic hooks publish the
    /// current instruction's start-cycle offset as a little-endian `u32`.
    ///
    /// Native translations do not support this portable context ABI.
    pub hook_cycle_offset: Option<i32>,
}

impl TranslationConfig {
    /// Creates a frontend configuration.
    pub fn new(
        settings: CodegenSettings,
        pointer_type: ir::Type,
        call_conv: CallConv,
        exit_mode: ExitMode,
    ) -> Self {
        Self {
            settings,
            pointer_type,
            call_conv,
            exit_mode,
            hook_cycle_offset: None,
        }
    }

    fn block_signature(&self) -> ir::Signature {
        let returns = match self.exit_mode {
            ExitMode::Native => vec![],
            ExitMode::ReturnExecuted | ExitMode::ReturnExecutedWithSlowMemory => {
                vec![ir::AbiParam::new(ir::types::I32)]
            }
        };

        ir::Signature {
            // ctx, regs, fastmem
            params: vec![ir::AbiParam::new(self.pointer_type); 3],
            returns,
            call_conv: match self.exit_mode {
                ExitMode::Native => CallConv::Tail,
                ExitMode::ReturnExecuted | ExitMode::ReturnExecutedWithSlowMemory => self.call_conv,
            },
        }
    }
}

/// How a target-independent translation ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranslationExit {
    /// The instruction iterator ended without a terminal instruction.
    Fallthrough,
    /// A branch ended the translated block.
    Branch(block::BranchMeta),
    /// A non-branch instruction requested a synchronous runtime exit.
    Synchronous,
}

/// The target-independent result of translating PowerPC instructions to Cranelift IR.
pub struct Translation {
    /// Generated CLIF function.
    pub function: ir::Function,
    /// Instructions consumed by the frontend.
    pub sequence: Sequence,
    /// Maximum cycles executed by the translated region.
    pub cycles: u16,
    /// Static reason the translated region ends.
    pub exit: TranslationExit,
}

/// Reusable PowerPC-to-CLIF translator.
pub struct Translator {
    config: TranslationConfig,
    func_ctx: frontend::FunctionBuilderContext,
}

impl Translator {
    /// Creates a translator for the given target-independent frontend environment.
    pub fn new(config: TranslationConfig) -> Self {
        Self {
            config,
            func_ctx: frontend::FunctionBuilderContext::new(),
        }
    }

    /// Returns this translator's frontend configuration.
    pub fn config(&self) -> &TranslationConfig {
        &self.config
    }

    /// Translates instructions up to a terminal instruction or the end of the iterator.
    pub fn translate(
        &mut self,
        instructions: impl Iterator<Item = Ins>,
    ) -> Result<Translation, BuildError> {
        if self.config.hook_cycle_offset.is_some() && self.config.exit_mode == ExitMode::Native {
            return Err(BuildError::Builder {
                source: builder::BuilderError::HookCycleOffsetRequiresPortableExit,
            });
        }

        let mut function = ir::Function::new();
        function.signature = self.config.block_signature();

        let func_builder = frontend::FunctionBuilder::new(&mut function, &mut self.func_ctx);
        let builder = BlockBuilder::new(&self.config, func_builder);

        let (sequence, cycles, exit) = builder.build(instructions).context(BuildCtx::Builder)?;
        if sequence.is_empty() {
            return Err(BuildError::EmptyBlock);
        }

        Ok(Translation {
            function,
            sequence,
            cycles,
            exit,
        })
    }
}

#[cfg(feature = "native")]
#[derive(Debug, Clone)]
pub struct Settings {
    /// Codegen settings
    pub codegen: CodegenSettings,
    /// Layout for the exit data.
    pub exit_data_layout: Layout,
    /// Path to the block cache directory
    pub cache_path: Option<PathBuf>,
}

#[cfg(feature = "native")]
impl Default for Settings {
    fn default() -> Self {
        Self {
            codegen: Default::default(),
            cache_path: Default::default(),
            exit_data_layout: Layout::new::<usize>(),
        }
    }
}

pub const FASTMEM_LUT_COUNT: usize = 1 << 15;
pub type FastmemLut = [Option<NonNull<u8>>; FASTMEM_LUT_COUNT];

const NAMESPACE_USER_HOOKS: u32 = 0;
const NAMESPACE_INTERNALS: u32 = 1;
const NAMESPACE_EXIT_DATA: u32 = 2;

const INTERNAL_RAISE_EXCEPTION: u32 = 0;

#[cfg(feature = "native")]
struct Codegen {
    settings: CodegenSettings,
    exit_data_layout: Layout,
    hooks: Hooks,
    isa: Arc<dyn TargetIsa>,
    module: Module,
    code_ctx: codegen::Context,
}

#[cfg(feature = "native")]
impl Codegen {
    fn new(
        isa: codegen::isa::Builder,
        settings: CodegenSettings,
        exit_data_layout: Layout,
        hooks: Hooks,
    ) -> Self {
        let verifier = if cfg!(debug_assertions) {
            "true"
        } else {
            "false"
        };

        let mut codegen = codegen::settings::builder();
        codegen.set("preserve_frame_pointers", "true").unwrap();
        codegen.set("use_colocated_libcalls", "false").unwrap();
        codegen.set("stack_switch_model", "basic").unwrap();
        codegen.set("unwind_info", "true").unwrap();
        codegen.set("is_pic", "false").unwrap();

        // affect runtime performance
        codegen.set("opt_level", "speed").unwrap();
        codegen.set("enable_verifier", verifier).unwrap();
        codegen.set("enable_alias_analysis", "true").unwrap();
        codegen.set("regalloc_algorithm", "backtracking").unwrap();
        codegen.set("regalloc_checker", "false").unwrap();
        codegen.set("enable_pinned_reg", "false").unwrap();
        codegen
            .set("enable_heap_access_spectre_mitigation", "false")
            .unwrap();
        codegen
            .set("enable_table_access_spectre_mitigation", "false")
            .unwrap();

        let flags = codegen::settings::Flags::new(codegen);
        let isa = isa.finish(flags).unwrap();

        Codegen {
            settings,
            exit_data_layout,
            hooks,
            isa,
            module: Module::new(),
            code_ctx: codegen::Context::new(),
        }
    }

    fn block_signature(&self) -> ir::Signature {
        let ptr = self.isa.pointer_type();
        ir::Signature {
            // ctx, regs, fastmem
            params: vec![ir::AbiParam::new(ptr); 3],
            returns: vec![],
            call_conv: codegen::isa::CallConv::Tail,
        }
    }

    fn trampoline_signature(&self, call_conv: CallConv) -> ir::Signature {
        let ptr = self.isa.pointer_type();
        ir::Signature {
            params: vec![ir::AbiParam::new(ptr); 3],
            returns: vec![],
            call_conv,
        }
    }

    /// Compiles a cranelift function in the code context into an artifact.
    fn compile(
        &mut self,
        func: ir::Function,
        disasm: bool,
    ) -> Result<Artifact, codegen::CodegenError> {
        self.code_ctx.clear();
        self.code_ctx.func = func;
        self.code_ctx.want_disasm = disasm;
        self.code_ctx
            .compile(&*self.isa, &mut Default::default())
            .map_err(|e| e.inner)?;

        let compiled = self.code_ctx.take_compiled_code().unwrap();
        let code = compiled.code_buffer().to_owned();
        let unwind = compiled.create_unwind_info(&*self.isa).ok().flatten();
        let disasm = compiled.vcode;

        Ok(Artifact {
            code,
            user_named_funcs: self.code_ctx.func.params.user_named_funcs().clone(),
            relocs: compiled.buffer.relocs().to_owned(),
            unwind,
            disasm,
        })
    }

    fn apply_user_relocation(
        &mut self,
        code: &mut [u8],
        reloc: &codegen::FinalizedMachReloc,
        name: ir::UserExternalName,
    ) {
        match name.namespace {
            NAMESPACE_USER_HOOKS => {
                let hook_kind = HookKind::from_repr(name.index).unwrap();
                let addr = match hook_kind {
                    HookKind::GetRegisters => self.hooks.get_registers as usize,
                    HookKind::GetFastmem => self.hooks.get_fastmem as usize,
                    HookKind::Exit => self.hooks.exit as usize,
                    HookKind::ReadI8 => self.hooks.read_i8 as usize,
                    HookKind::ReadI16 => self.hooks.read_i16 as usize,
                    HookKind::ReadI32 => self.hooks.read_i32 as usize,
                    HookKind::ReadI64 => self.hooks.read_i64 as usize,
                    HookKind::WriteI8 => self.hooks.write_i8 as usize,
                    HookKind::WriteI16 => self.hooks.write_i16 as usize,
                    HookKind::WriteI32 => self.hooks.write_i32 as usize,
                    HookKind::WriteI64 => self.hooks.write_i64 as usize,
                    HookKind::ReadQuant => self.hooks.read_quantized as usize,
                    HookKind::WriteQuant => self.hooks.write_quantized as usize,
                    HookKind::InvICache => self.hooks.invalidate_icache as usize,
                    HookKind::ClearICache => self.hooks.clear_icache as usize,
                    HookKind::DCacheDma => self.hooks.dcache_dma as usize,
                    HookKind::MsrChanged => self.hooks.msr_changed as usize,
                    HookKind::IBatChanged => self.hooks.ibat_changed as usize,
                    HookKind::DBatChanged => self.hooks.dbat_changed as usize,
                    HookKind::TbRead => self.hooks.tb_read as usize,
                    HookKind::TbChanged => self.hooks.tb_changed as usize,
                    HookKind::DecRead => self.hooks.dec_read as usize,
                    HookKind::DecChanged => self.hooks.dec_changed as usize,
                };

                jitclif::write_relocation(code, reloc, addr);
            }
            NAMESPACE_INTERNALS => {
                assert_eq!(name.index, INTERNAL_RAISE_EXCEPTION);
                extern "C-unwind" fn raise_exception(regs: &mut Cpu, exception: Exception) {
                    regs.raise_exception(exception);
                }

                let addr = raise_exception as extern "C-unwind" fn(_, _) as usize;
                jitclif::write_relocation(code, reloc, addr);
            }
            NAMESPACE_EXIT_DATA => {
                let exit_data = self.module.allocate_data(self.exit_data_layout);

                // zero initialize
                unsafe {
                    std::ptr::write_bytes(
                        exit_data.as_ptr().as_ptr().cast::<u8>(),
                        0,
                        self.exit_data_layout.size(),
                    );
                }

                let addr = unsafe { exit_data.as_ptr().addr().get() };
                jitclif::write_relocation(code, reloc, addr);
            }
            _ => unreachable!(),
        }
    }

    /// Applies all relocations to the given buffer.
    fn apply_relocations(
        &mut self,
        code: &mut [u8],
        mapping: &PrimaryMap<ir::UserExternalNameRef, ir::UserExternalName>,
        relocs: &[codegen::FinalizedMachReloc],
    ) {
        for reloc in relocs {
            let codegen::FinalizedRelocTarget::ExternalName(ext_name) = &reloc.target else {
                unreachable!()
            };

            match ext_name {
                ir::ExternalName::User(name_ref) => {
                    let name = mapping.get(*name_ref).unwrap();
                    self.apply_user_relocation(code, reloc, name.clone());
                }
                ir::ExternalName::LibCall(libcall) => {
                    let addr = jitclif::libcall(*libcall);
                    jitclif::write_relocation(code, reloc, addr);
                }
                _ => unimplemented!("external reloc name: {ext_name:?}"),
            }
        }
    }
}

/// A JIT compiler, producing [`Block`]s.
#[cfg(feature = "native")]
pub struct Jit {
    codegen: Codegen,
    translator: Translator,
    cache: Option<Cache>,
    compiled_count: u64,
    trampoline: Trampoline,
}

#[cfg(feature = "native")]
#[derive(Clone, Serialize, Deserialize)]
struct Artifact {
    user_named_funcs: PrimaryMap<ir::UserExternalNameRef, ir::UserExternalName>,
    relocs: Vec<codegen::FinalizedMachReloc>,
    unwind: Option<codegen::isa::unwind::UnwindInfo>,
    disasm: Option<String>,
    #[serde(with = "serde_bytes")]
    code: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum BuildError {
    #[error("block contains no instructions")]
    EmptyBlock,
    #[error(transparent)]
    Builder { source: builder::BuilderError },
    #[error(transparent)]
    Codegen {
        source: codegen::CodegenError,
        sequence: Sequence,
        clir: Option<String>,
    },
}

#[cfg(feature = "native")]
impl Jit {
    /// Compiles and returns a trampoline to call blocks.
    fn trampoline(
        codegen: &mut Codegen,
        func_ctx: &mut frontend::FunctionBuilderContext,
    ) -> Trampoline {
        let block_sig = codegen.block_signature();
        let default = codegen.isa.default_call_conv();

        let mut func = ir::Function::new();
        func.signature = codegen.trampoline_signature(default);

        let mut builder = frontend::FunctionBuilder::new(&mut func, func_ctx);
        let entry_bb = builder.create_block();
        builder.append_block_params_for_function_params(entry_bb);
        builder.switch_to_block(entry_bb);
        builder.seal_block(entry_bb);

        let params = builder.block_params(entry_bb);
        let ctx_ptr = params[0];
        let block_ptr = params[1];
        let ptr_type = codegen.isa.pointer_type();
        let default = codegen.isa.default_call_conv();

        // extract regs ptr
        let get_regs_sig =
            builder.import_signature(HookSignatures::get_registers(ptr_type, default));
        let get_registers = builder
            .ins()
            .iconst(ptr_type, codegen.hooks.get_registers as usize as i64);
        let inst = builder
            .ins()
            .call_indirect(get_regs_sig, get_registers, &[ctx_ptr]);
        let regs_ptr = builder.inst_results(inst)[0];

        // extract fastmem ptr
        let get_fmem_sig = builder.import_signature(HookSignatures::get_fastmem(ptr_type, default));
        let get_fmem = builder
            .ins()
            .iconst(ptr_type, codegen.hooks.get_fastmem as usize as i64);
        let inst = builder
            .ins()
            .call_indirect(get_fmem_sig, get_fmem, &[ctx_ptr]);
        let fmem_ptr = builder.inst_results(inst)[0];

        // call the block
        let block_sig = builder.import_signature(block_sig);
        builder
            .ins()
            .call_indirect(block_sig, block_ptr, &[ctx_ptr, regs_ptr, fmem_ptr]);

        builder.ins().return_(&[]);
        builder.finalize();

        let artifact = codegen.compile(func, false).unwrap();
        let alloc = codegen.module.allocate_code(&artifact.code);

        Trampoline(alloc)
    }

    /// Creates a new [`Jit`] instance with the given ISA.
    pub(crate) fn with_isa(isa: codegen::isa::Builder, settings: Settings, hooks: Hooks) -> Self {
        let mut codegen = Codegen::new(
            isa,
            settings.codegen.clone(),
            settings.exit_data_layout,
            hooks,
        );
        let mut func_ctx = frontend::FunctionBuilderContext::new();
        let cache = settings.cache_path.map(Cache::new);
        let trampoline = Self::trampoline(&mut codegen, &mut func_ctx);
        let translator = Translator::new(TranslationConfig::new(
            settings.codegen,
            codegen.isa.pointer_type(),
            codegen.isa.default_call_conv(),
            ExitMode::Native,
        ));

        Self {
            codegen,
            translator,
            cache,
            compiled_count: 0,
            trampoline,
        }
    }

    /// Creates a new [`Jit`] instance with the host's ISA.
    pub fn new(settings: Settings, hooks: Hooks) -> Self {
        let isa_builder = native::builder().unwrap_or_else(|msg| {
            panic!("host machine is not supported: {}", msg);
        });

        Self::with_isa(isa_builder, settings, hooks)
    }

    /// Builds an artifact from the given instructions (up until a terminal instruction or the end of
    /// the iterator).
    pub(crate) fn build_artifact(
        &mut self,
        instructions: impl Iterator<Item = Ins>,
    ) -> Result<(Artifact, Meta), BuildError> {
        let translated = self.translator.translate(instructions)?;
        let func = translated.function;
        let sequence = translated.sequence;
        let pattern = sequence.detect_pattern();

        let clir = cfg!(debug_assertions).then(|| func.display().to_string());
        let key = ArtifactKey::new(&*self.codegen.isa, &self.codegen.settings, &sequence);

        let artifact = if let Some(cache) = &mut self.cache
            && let Some(artifact) = cache.get(key)
        {
            artifact
        } else {
            let artifact = self
                .codegen
                .compile(func, cfg!(debug_assertions))
                .with_context(|_| BuildCtx::Codegen {
                    sequence: sequence.clone(),
                    clir: clir.clone(),
                })?;

            if let Some(cache) = &mut self.cache {
                cache.insert(key, &artifact);
            }

            artifact
        };

        let meta = Meta {
            seq: sequence,
            clir,
            disasm: artifact.disasm.clone(),
            cycles: translated.cycles,
            pattern,
        };

        Ok((artifact, meta))
    }

    /// Builds a block with the given instructions (up until a terminal instruction or the end of
    /// the iterator).
    pub fn build(&mut self, instructions: impl Iterator<Item = Ins>) -> Result<Block, BuildError> {
        let (artifact, meta) = self.build_artifact(instructions)?;

        let mut code = artifact.code;
        self.codegen
            .apply_relocations(&mut code, &artifact.user_named_funcs, &artifact.relocs);

        let alloc = self.codegen.module.allocate_code(&code);
        let unwind_handle = if let Some(unwind) = artifact.unwind {
            unsafe { UnwindHandle::new(&*self.codegen.isa, alloc.as_ptr().addr().get(), &unwind) }
        } else {
            None
        };

        // TODO: remove this and deal with handles
        std::mem::forget(unwind_handle);

        let block = Block::new(alloc, meta);
        self.compiled_count += 1;

        Ok(block)
    }

    /// Calls the given block with the given context.
    ///
    /// # Safety
    /// `ctx` must match the type expected by the hooks of this JIT context.
    pub unsafe fn call(&mut self, ctx: *mut Context, block: BlockFn) {
        // SAFETY: the exclusive reference to the context guarantees the allocator is not being
        // used, keeping the allocations safe
        unsafe { self.trampoline.call(ctx, block) }
    }
}
