//! A reusable backend from a verified scalar wasm32 subset of Cranelift IR to WebAssembly.
//!
//! Guest instruction decoding and runtime naming stay in callers. The current module ABI imports
//! one 32-bit linear memory and exports the lowered CLIF function under caller-selected names.

use std::collections::HashMap;
use std::fmt;

use cranelift_codegen::ir::condcodes::{FloatCC, IntCC};
use cranelift_codegen::ir::{
    self, Block, BlockArg, BlockCall, Endianness, FuncRef, InstructionData, MemFlags, Opcode,
    StackSlot, Type, Value,
};
use cranelift_codegen::{settings, verify_function};
use wasm_encoder::{
    BlockType, CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection,
    Ieee32 as WasmIeee32, Ieee64 as WasmIeee64, ImportSection, Instruction, MemArg, MemoryType,
    Module, TypeSection, ValType,
};

/// WebAssembly module ABI used by the lowerer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModuleConfig<'a> {
    /// Module name of the imported linear memory.
    pub memory_import_module: &'a str,
    /// Field name of the imported linear memory.
    pub memory_import_name: &'a str,
    /// Name of the exported lowered function.
    pub function_export_name: &'a str,
    /// Module name used for direct CLIF function imports.
    pub function_import_module: &'a str,
    /// Minimum imported-memory size in WebAssembly pages.
    pub minimum_memory_pages: u64,
    /// Optional maximum imported-memory size in WebAssembly pages.
    pub maximum_memory_pages: Option<u64>,
    /// Optional `(base parameter, byte offset, byte size)` scratch window for explicit stack slots.
    pub stack_scratch: Option<(u32, u32, u32)>,
}

impl<'a> ModuleConfig<'a> {
    /// Creates a 32-bit, unshared, unbounded imported-memory ABI.
    pub const fn new(
        memory_import_module: &'a str,
        memory_import_name: &'a str,
        function_export_name: &'a str,
    ) -> Self {
        Self {
            memory_import_module,
            memory_import_name,
            function_export_name,
            function_import_module: "clif",
            minimum_memory_pages: 1,
            maximum_memory_pages: None,
            stack_scratch: None,
        }
    }

    /// Overrides the imported memory limits while retaining the backend's 32-bit ABI.
    pub const fn with_memory_limits(mut self, minimum: u64, maximum: Option<u64>) -> Self {
        self.minimum_memory_pages = minimum;
        self.maximum_memory_pages = maximum;
        self
    }

    /// Overrides the module name used for direct CLIF function imports.
    pub const fn with_function_import_module(mut self, module: &'a str) -> Self {
        self.function_import_module = module;
        self
    }

    /// Supplies bounded imported-memory scratch space for CLIF explicit stack slots.
    pub const fn with_stack_scratch(
        mut self,
        base_parameter: u32,
        byte_offset: u32,
        byte_size: u32,
    ) -> Self {
        self.stack_scratch = Some((base_parameter, byte_offset, byte_size));
        self
    }
}

/// Failure while lowering the portable CLIF subset to WebAssembly.
#[derive(Debug, Clone)]
pub enum LowerError {
    /// The supplied CLIF function failed Cranelift's target-independent verifier.
    InvalidClif(String),
    /// The configured memory limits cannot describe a standard wasm32 linear memory.
    InvalidMemoryLimits {
        /// Minimum requested pages.
        minimum: u64,
        /// Maximum requested pages.
        maximum: Option<u64>,
    },
    /// A CLIF type has no mapping in the current WebAssembly subset.
    UnsupportedType(Type),
    /// An instruction has not been added to the current WebAssembly subset.
    UnsupportedOpcode(Opcode),
    /// A direct call referenced external-function metadata that could not be lowered.
    InvalidExternalFunction(FuncRef),
    /// The instruction's data did not match its opcode.
    InvalidInstruction(Opcode),
    /// An SSA value was used without a mapped parameter or definition.
    MissingValue(Value),
    /// WebAssembly memory operations are little-endian.
    UnsupportedEndianness(Endianness),
    /// The function does not end in a return.
    MissingReturn,
    /// The CLIF stack-slot layout does not fit the configured scratch window.
    StackScratchTooSmall {
        /// Bytes required by the aligned stack-slot layout.
        required: u32,
        /// Bytes supplied by the caller.
        available: u32,
    },
}

impl fmt::Display for LowerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidClif(error) => write!(f, "invalid CLIF: {error}"),
            Self::InvalidMemoryLimits { minimum, maximum } => {
                write!(
                    f,
                    "invalid wasm32 memory limits: minimum {minimum}, maximum {maximum:?}"
                )
            }
            Self::UnsupportedType(ty) => write!(f, "unsupported CLIF type {ty}"),
            Self::UnsupportedOpcode(opcode) => {
                write!(f, "unsupported CLIF opcode {opcode}")
            }
            Self::InvalidExternalFunction(reference) => {
                write!(f, "invalid CLIF external function {reference}")
            }
            Self::InvalidInstruction(opcode) => {
                write!(f, "invalid instruction data for CLIF opcode {opcode}")
            }
            Self::MissingValue(value) => write!(f, "missing Wasm local for CLIF value {value}"),
            Self::UnsupportedEndianness(endianness) => {
                write!(f, "unsupported CLIF memory endianness {endianness:?}")
            }
            Self::MissingReturn => f.write_str("CLIF function has no return"),
            Self::StackScratchTooSmall {
                required,
                available,
            } => write!(
                f,
                "CLIF stack slots require {required} scratch bytes, only {available} configured"
            ),
        }
    }
}

impl std::error::Error for LowerError {}

/// Lowers the supported scalar CLIF subset into a WebAssembly module.
///
/// Arbitrary `jump`/`brif` control-flow graphs are represented as a structured
/// WebAssembly dispatcher loop. Straight-line functions retain their compact
/// direct encoding.
pub fn function(function: &ir::Function, config: &ModuleConfig<'_>) -> Result<Vec<u8>, LowerError> {
    const MAX_WASM32_PAGES: u64 = 1 << 16;
    if config.minimum_memory_pages > MAX_WASM32_PAGES
        || config.maximum_memory_pages.is_some_and(|maximum| {
            maximum < config.minimum_memory_pages || maximum > MAX_WASM32_PAGES
        })
    {
        return Err(LowerError::InvalidMemoryLimits {
            minimum: config.minimum_memory_pages,
            maximum: config.maximum_memory_pages,
        });
    }

    let flags = settings::Flags::new(settings::builder());
    verify_function(function, &flags)
        .map_err(|error| LowerError::InvalidClif(error.to_string()))?;

    let mut stack_offsets = HashMap::new();
    let mut stack_bytes = 0u32;
    for (stack_slot, data) in function.sized_stack_slots.iter() {
        let alignment = 1u32
            .checked_shl(data.align_shift.into())
            .ok_or(LowerError::InvalidInstruction(Opcode::StackAddr))?;
        stack_bytes = stack_bytes
            .checked_add(alignment - 1)
            .ok_or(LowerError::InvalidInstruction(Opcode::StackAddr))?
            & !(alignment - 1);
        stack_offsets.insert(stack_slot, stack_bytes);
        stack_bytes = stack_bytes
            .checked_add(data.size)
            .ok_or(LowerError::InvalidInstruction(Opcode::StackAddr))?;
    }
    if stack_bytes != 0 {
        let Some((base_parameter, byte_offset, available)) = config.stack_scratch else {
            return Err(LowerError::StackScratchTooSmall {
                required: stack_bytes,
                available: 0,
            });
        };
        if stack_bytes > available || byte_offset.checked_add(stack_bytes).is_none() {
            return Err(LowerError::StackScratchTooSmall {
                required: stack_bytes,
                available,
            });
        }
        let Some(parameter) = function.signature.params.get(base_parameter as usize) else {
            return Err(LowerError::InvalidInstruction(Opcode::StackAddr));
        };
        require_i32(parameter.value_type)?;
    }

    let blocks = function.layout.blocks().collect::<Vec<_>>();
    let block = blocks[0];
    let uses_dispatcher = blocks.len() != 1
        || function.layout.block_insts(block).any(|inst| {
            matches!(
                function.dfg.insts[inst].opcode(),
                Opcode::Jump | Opcode::Brif
            )
        });

    let mut call_indices = HashMap::new();
    let mut call_imports = Vec::new();
    for block in blocks.iter().copied() {
        for inst in function.layout.block_insts(block) {
            let InstructionData::Call {
                opcode: Opcode::Call,
                func_ref,
                ..
            } = function.dfg.insts[inst]
            else {
                continue;
            };
            if call_indices.contains_key(&func_ref) {
                continue;
            }

            let external = function
                .dfg
                .ext_funcs
                .get(func_ref)
                .ok_or(LowerError::InvalidExternalFunction(func_ref))?;
            let signature = &function.dfg.signatures[external.signature];
            let params = signature
                .params
                .iter()
                .map(|param| wasm_storage_type(param.value_type))
                .collect::<Result<Vec<_>, _>>()?;
            let returns = signature
                .returns
                .iter()
                .map(|param| wasm_storage_type(param.value_type))
                .collect::<Result<Vec<_>, _>>()?;
            let name = external_function_name(function, func_ref)?;
            let index = call_imports.len() as u32;
            call_indices.insert(func_ref, index);
            call_imports.push((name, params, returns));
        }
    }

    let mut locals = HashMap::new();
    for (index, value) in function.dfg.block_params(block).iter().copied().enumerate() {
        require_i32(function.dfg.value_type(value))?;
        locals.insert(function.dfg.resolve_aliases(value), index as u32);
    }

    let parameter_count = function.signature.params.len() as u32;
    let mut next_local = parameter_count;
    let mut local_types = Vec::new();
    for (block_index, block) in blocks.iter().copied().enumerate() {
        if block_index != 0 {
            for parameter in function.dfg.block_params(block).iter().copied() {
                allocate_local(
                    function,
                    &mut locals,
                    &mut local_types,
                    parameter,
                    &mut next_local,
                )?;
            }
        }

        for inst in function.layout.block_insts(block) {
            for result in function.dfg.inst_results(inst).iter().copied() {
                allocate_local(
                    function,
                    &mut locals,
                    &mut local_types,
                    result,
                    &mut next_local,
                )?;
            }
        }
    }

    let state_local = uses_dispatcher.then(|| {
        let local = next_local;
        next_local += 1;
        local_types.push(ValType::I32);
        local
    });

    let declarations = local_types.into_iter().map(|ty| (1, ty));
    let mut wasm = Function::new(declarations);
    if let Some(state_local) = state_local {
        lower_dispatcher(
            function,
            &blocks,
            &locals,
            &call_indices,
            &stack_offsets,
            config.stack_scratch,
            state_local,
            &mut wasm,
        )?;
    } else {
        let mut returned = false;
        for inst in function.layout.block_insts(block) {
            returned |= matches!(
                lower_instruction(
                    function,
                    &locals,
                    &call_indices,
                    &stack_offsets,
                    config.stack_scratch,
                    inst,
                    &mut wasm,
                )?,
                Control::Return
            );
        }

        if !returned {
            return Err(LowerError::MissingReturn);
        }
    }
    wasm.instruction(&Instruction::End);

    let params = function
        .signature
        .params
        .iter()
        .map(|param| wasm_type(param.value_type))
        .collect::<Result<Vec<_>, _>>()?;
    let returns = function
        .signature
        .returns
        .iter()
        .map(|param| wasm_type(param.value_type))
        .collect::<Result<Vec<_>, _>>()?;

    let mut types = TypeSection::new();
    for (_, params, returns) in &call_imports {
        types
            .ty()
            .function(params.iter().copied(), returns.iter().copied());
    }
    let function_type_index = call_imports.len() as u32;
    types.ty().function(params, returns);

    let mut imports = ImportSection::new();
    imports.import(
        config.memory_import_module,
        config.memory_import_name,
        EntityType::Memory(MemoryType {
            minimum: config.minimum_memory_pages,
            maximum: config.maximum_memory_pages,
            memory64: false,
            shared: false,
            page_size_log2: None,
        }),
    );
    for (index, (name, _, _)) in call_imports.iter().enumerate() {
        imports.import(
            config.function_import_module,
            name,
            EntityType::Function(index as u32),
        );
    }

    let mut functions = FunctionSection::new();
    functions.function(function_type_index);

    let mut exports = ExportSection::new();
    exports.export(
        config.function_export_name,
        ExportKind::Func,
        call_imports.len() as u32,
    );

    let mut code = CodeSection::new();
    code.function(&wasm);

    let mut module = Module::new();
    module.section(&types);
    module.section(&imports);
    module.section(&functions);
    module.section(&exports);
    module.section(&code);

    Ok(module.finish())
}

#[derive(Clone, Copy)]
enum Control {
    None,
    Return,
    Jump(BlockCall),
    Brif {
        condition: Value,
        then_edge: BlockCall,
        else_edge: BlockCall,
    },
}

fn lower_instruction(
    function: &ir::Function,
    locals: &HashMap<Value, u32>,
    call_indices: &HashMap<FuncRef, u32>,
    stack_offsets: &HashMap<StackSlot, u32>,
    stack_scratch: Option<(u32, u32, u32)>,
    inst: ir::Inst,
    wasm: &mut Function,
) -> Result<Control, LowerError> {
    let data = function.dfg.insts[inst];
    let opcode = data.opcode();

    let control = match data {
        InstructionData::NullAry {
            opcode: Opcode::Nop,
        } => Control::None,
        InstructionData::UnaryImm {
            opcode: Opcode::Iconst,
            imm,
        } => {
            wasm.instruction(&match single_result_type(function, inst)? {
                ir::types::I8 | ir::types::I16 | ir::types::I32 => {
                    Instruction::I32Const(imm.bits() as i32)
                }
                ir::types::I64 => Instruction::I64Const(imm.bits()),
                ty => return Err(LowerError::UnsupportedType(ty)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::UnaryIeee64 {
            opcode: Opcode::F64const,
            imm,
        } => {
            require_single_type(function, inst, ir::types::F64)?;
            wasm.instruction(&Instruction::F64Const(WasmIeee64::new(imm.bits())));
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::UnaryIeee32 {
            opcode: Opcode::F32const,
            imm,
        } => {
            require_single_type(function, inst, ir::types::F32)?;
            wasm.instruction(&Instruction::F32Const(WasmIeee32::new(imm.bits())));
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::UnaryConst {
            opcode: Opcode::Vconst,
            constant_handle,
        } => {
            let result_type = single_result_type(function, inst)?;
            if !result_type.is_vector() || result_type.bits() != 128 {
                return Err(LowerError::UnsupportedType(result_type));
            }
            let data = function.dfg.constants.get(constant_handle).as_slice();
            let constant: [u8; 16] = data
                .try_into()
                .map_err(|_| LowerError::InvalidInstruction(opcode))?;
            wasm.instruction(&Instruction::V128Const(i128::from_le_bytes(constant)));
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Binary { opcode, args }
            if matches!(
                opcode,
                Opcode::Iadd | Opcode::Imul | Opcode::Band | Opcode::Bor | Opcode::Bxor
            ) =>
        {
            let ty = function.dfg.value_type(args[0]);
            if function.dfg.value_type(args[1]) != ty || single_result_type(function, inst)? != ty {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            wasm.instruction(&match (opcode, ty) {
                (Opcode::Iadd, ir::types::I32) => Instruction::I32Add,
                (Opcode::Iadd, ir::types::I64) => Instruction::I64Add,
                (Opcode::Imul, ir::types::I32) => Instruction::I32Mul,
                (Opcode::Imul, ir::types::I64) => Instruction::I64Mul,
                (Opcode::Band, ir::types::I8 | ir::types::I16 | ir::types::I32) => {
                    Instruction::I32And
                }
                (Opcode::Band, ir::types::I64) => Instruction::I64And,
                (Opcode::Band, ty) if ty.is_vector() && ty.bits() == 128 => Instruction::V128And,
                (Opcode::Bor, ir::types::I8 | ir::types::I16 | ir::types::I32) => {
                    Instruction::I32Or
                }
                (Opcode::Bor, ir::types::I64) => Instruction::I64Or,
                (Opcode::Bor, ty) if ty.is_vector() && ty.bits() == 128 => Instruction::V128Or,
                (Opcode::Bxor, ir::types::I8 | ir::types::I16 | ir::types::I32) => {
                    Instruction::I32Xor
                }
                (Opcode::Bxor, ir::types::I64) => Instruction::I64Xor,
                (Opcode::Bxor, ty) if ty.is_vector() && ty.bits() == 128 => Instruction::V128Xor,
                _ => return Err(LowerError::UnsupportedType(ty)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Binary {
            opcode: Opcode::Swizzle,
            args,
        } => {
            let ty = function.dfg.value_type(args[0]);
            if function.dfg.value_type(args[1]) != ty
                || single_result_type(function, inst)? != ty
                || !ty.is_vector()
                || ty.bits() != 128
            {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            wasm.instruction(&Instruction::I8x16Swizzle);
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Binary { opcode, args }
            if matches!(
                opcode,
                Opcode::Fadd | Opcode::Fsub | Opcode::Fmul | Opcode::Fdiv
            ) =>
        {
            let ty = function.dfg.value_type(args[0]);
            if function.dfg.value_type(args[1]) != ty || single_result_type(function, inst)? != ty {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            wasm.instruction(&match (opcode, ty) {
                (Opcode::Fadd, ir::types::F32) => Instruction::F32Add,
                (Opcode::Fadd, ir::types::F64) => Instruction::F64Add,
                (Opcode::Fadd, ir::types::F32X4) => Instruction::F32x4Add,
                (Opcode::Fadd, ir::types::F64X2) => Instruction::F64x2Add,
                (Opcode::Fsub, ir::types::F32) => Instruction::F32Sub,
                (Opcode::Fsub, ir::types::F64) => Instruction::F64Sub,
                (Opcode::Fsub, ir::types::F32X4) => Instruction::F32x4Sub,
                (Opcode::Fsub, ir::types::F64X2) => Instruction::F64x2Sub,
                (Opcode::Fmul, ir::types::F32) => Instruction::F32Mul,
                (Opcode::Fmul, ir::types::F64) => Instruction::F64Mul,
                (Opcode::Fmul, ir::types::F32X4) => Instruction::F32x4Mul,
                (Opcode::Fmul, ir::types::F64X2) => Instruction::F64x2Mul,
                (Opcode::Fdiv, ir::types::F32) => Instruction::F32Div,
                (Opcode::Fdiv, ir::types::F64) => Instruction::F64Div,
                (Opcode::Fdiv, ir::types::F32X4) => Instruction::F32x4Div,
                (Opcode::Fdiv, ir::types::F64X2) => Instruction::F64x2Div,
                _ => return Err(LowerError::UnsupportedType(ty)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Binary { opcode, args }
            if matches!(opcode, Opcode::Sdiv | Opcode::Udiv) =>
        {
            let ty = function.dfg.value_type(args[0]);
            if function.dfg.value_type(args[1]) != ty || single_result_type(function, inst)? != ty {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            wasm.instruction(&match (opcode, ty) {
                (Opcode::Sdiv, ir::types::I32) => Instruction::I32DivS,
                (Opcode::Sdiv, ir::types::I64) => Instruction::I64DivS,
                (Opcode::Udiv, ir::types::I32) => Instruction::I32DivU,
                (Opcode::Udiv, ir::types::I64) => Instruction::I64DivU,
                _ => return Err(LowerError::UnsupportedType(ty)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Binary {
            opcode: Opcode::Umulhi,
            args,
        } => {
            require_i32_value(function, args[0])?;
            require_i32_value(function, args[1])?;
            require_single_i32_result(function, inst)?;
            get_value(function, locals, args[0], wasm)?;
            wasm.instruction(&Instruction::I64ExtendI32U);
            get_value(function, locals, args[1], wasm)?;
            wasm.instruction(&Instruction::I64ExtendI32U);
            wasm.instruction(&Instruction::I64Mul);
            wasm.instruction(&Instruction::I64Const(32));
            wasm.instruction(&Instruction::I64ShrU);
            wasm.instruction(&Instruction::I32WrapI64);
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Binary {
            opcode: Opcode::Smulhi,
            args,
        } => {
            require_i32_value(function, args[0])?;
            require_i32_value(function, args[1])?;
            require_single_i32_result(function, inst)?;
            get_value(function, locals, args[0], wasm)?;
            wasm.instruction(&Instruction::I64ExtendI32S);
            get_value(function, locals, args[1], wasm)?;
            wasm.instruction(&Instruction::I64ExtendI32S);
            wasm.instruction(&Instruction::I64Mul);
            wasm.instruction(&Instruction::I64Const(32));
            wasm.instruction(&Instruction::I64ShrS);
            wasm.instruction(&Instruction::I32WrapI64);
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Binary {
            opcode: Opcode::Sshr,
            args,
        } => {
            let ty = function.dfg.value_type(args[0]);
            if function.dfg.value_type(args[1]) != ty || single_result_type(function, inst)? != ty {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            wasm.instruction(&match ty {
                ir::types::I32 => Instruction::I32ShrS,
                ir::types::I64 => Instruction::I64ShrS,
                _ => return Err(LowerError::UnsupportedType(ty)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Binary {
            opcode: Opcode::Ushr,
            args,
        } => {
            let value_type = function.dfg.value_type(args[0]);
            let shift_type = function.dfg.value_type(args[1]);
            if single_result_type(function, inst)? != value_type {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            let instruction = match value_type {
                ir::types::I32 => {
                    require_i32_storage(shift_type)?;
                    Instruction::I32ShrU
                }
                ir::types::I64 => {
                    if shift_type != ir::types::I64 {
                        return Err(LowerError::UnsupportedType(shift_type));
                    }
                    Instruction::I64ShrU
                }
                ir::types::I8X16 => {
                    require_i32_storage(shift_type)?;
                    Instruction::I8x16ShrU
                }
                ir::types::I16X8 => {
                    require_i32_storage(shift_type)?;
                    Instruction::I16x8ShrU
                }
                ir::types::I32X4 => {
                    require_i32_storage(shift_type)?;
                    Instruction::I32x4ShrU
                }
                ir::types::I64X2 => {
                    if shift_type == ir::types::I64 {
                        wasm.instruction(&Instruction::I32WrapI64);
                    } else {
                        require_i32_storage(shift_type)?;
                    }
                    Instruction::I64x2ShrU
                }
                _ => return Err(LowerError::UnsupportedType(value_type)),
            };
            wasm.instruction(&instruction);
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Binary {
            opcode: Opcode::Rotl,
            args,
        } => {
            let value_type = function.dfg.value_type(args[0]);
            let shift_type = function.dfg.value_type(args[1]);
            if single_result_type(function, inst)? != value_type {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            wasm.instruction(&match value_type {
                ir::types::I32 => {
                    require_i32_storage(shift_type)?;
                    Instruction::I32Rotl
                }
                ir::types::I64 => {
                    if shift_type != ir::types::I64 {
                        return Err(LowerError::UnsupportedType(shift_type));
                    }
                    Instruction::I64Rotl
                }
                _ => return Err(LowerError::UnsupportedType(value_type)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Binary {
            opcode: Opcode::Ishl,
            args,
        } => {
            let value_type = function.dfg.value_type(args[0]);
            let shift_type = function.dfg.value_type(args[1]);
            if single_result_type(function, inst)? != value_type {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            let instruction = match value_type {
                ir::types::I32 => {
                    require_i32_storage(shift_type)?;
                    Instruction::I32Shl
                }
                ir::types::I64 => {
                    if shift_type != ir::types::I64 {
                        return Err(LowerError::UnsupportedType(shift_type));
                    }
                    Instruction::I64Shl
                }
                ir::types::I8X16 => {
                    require_i32_storage(shift_type)?;
                    Instruction::I8x16Shl
                }
                ir::types::I16X8 => {
                    require_i32_storage(shift_type)?;
                    Instruction::I16x8Shl
                }
                ir::types::I32X4 => {
                    require_i32_storage(shift_type)?;
                    Instruction::I32x4Shl
                }
                ir::types::I64X2 => {
                    if shift_type == ir::types::I64 {
                        wasm.instruction(&Instruction::I32WrapI64);
                    } else {
                        require_i32_storage(shift_type)?;
                    }
                    Instruction::I64x2Shl
                }
                _ => return Err(LowerError::UnsupportedType(value_type)),
            };
            wasm.instruction(&instruction);
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Binary {
            opcode: Opcode::BandNot,
            args,
        } => {
            let value_type = function.dfg.value_type(args[0]);
            if function.dfg.value_type(args[1]) != value_type
                || single_result_type(function, inst)? != value_type
            {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            match value_type {
                ir::types::I32 => {
                    wasm.instruction(&Instruction::I32Const(-1));
                    wasm.instruction(&Instruction::I32Xor);
                    wasm.instruction(&Instruction::I32And);
                }
                ty if ty.is_vector() && ty.bits() == 128 => {
                    wasm.instruction(&Instruction::V128AndNot);
                }
                _ => return Err(LowerError::UnsupportedType(value_type)),
            }
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Binary {
            opcode: Opcode::UaddOverflow,
            args,
        } => {
            let results = function.dfg.inst_results(inst);
            if results.len() != 2 {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            require_i32_value(function, args[0])?;
            require_i32_value(function, args[1])?;
            require_i32(function.dfg.value_type(results[0]))?;
            let carry_type = function.dfg.value_type(results[1]);
            if carry_type != ir::types::I8 {
                return Err(LowerError::UnsupportedType(carry_type));
            }

            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            wasm.instruction(&Instruction::I32Add);
            wasm.instruction(&Instruction::LocalTee(local(
                function, &locals, results[0],
            )?));
            get_value(function, locals, args[0], wasm)?;
            wasm.instruction(&Instruction::I32LtU);
            wasm.instruction(&Instruction::LocalSet(local(
                function, &locals, results[1],
            )?));
            Control::None
        }
        InstructionData::Binary {
            opcode: Opcode::SmulOverflow,
            args,
        } => {
            let results = function.dfg.inst_results(inst);
            if results.len() != 2 {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            require_i32_value(function, args[0])?;
            require_i32_value(function, args[1])?;
            require_i32(function.dfg.value_type(results[0]))?;
            let overflow_type = function.dfg.value_type(results[1]);
            if overflow_type != ir::types::I8 {
                return Err(LowerError::UnsupportedType(overflow_type));
            }

            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            wasm.instruction(&Instruction::I32Mul);
            wasm.instruction(&Instruction::LocalSet(local(
                function, &locals, results[0],
            )?));

            get_value(function, locals, args[0], wasm)?;
            wasm.instruction(&Instruction::I64ExtendI32S);
            get_value(function, locals, args[1], wasm)?;
            wasm.instruction(&Instruction::I64ExtendI32S);
            wasm.instruction(&Instruction::I64Mul);
            wasm.instruction(&Instruction::LocalGet(local(
                function, &locals, results[0],
            )?));
            wasm.instruction(&Instruction::I64ExtendI32S);
            wasm.instruction(&Instruction::I64Ne);
            wasm.instruction(&Instruction::LocalSet(local(
                function, &locals, results[1],
            )?));
            Control::None
        }
        InstructionData::BinaryImm64 { opcode, arg, imm }
            if matches!(
                opcode,
                Opcode::IaddImm
                    | Opcode::BandImm
                    | Opcode::BorImm
                    | Opcode::BxorImm
                    | Opcode::ImulImm
                    | Opcode::IshlImm
                    | Opcode::RotlImm
                    | Opcode::UshrImm
            ) =>
        {
            require_i32_value(function, arg)?;
            require_single_i32_result(function, inst)?;
            get_value(function, locals, arg, wasm)?;
            wasm.instruction(&Instruction::I32Const(imm.bits() as i32));
            wasm.instruction(&match opcode {
                Opcode::IaddImm => Instruction::I32Add,
                Opcode::BandImm => Instruction::I32And,
                Opcode::BorImm => Instruction::I32Or,
                Opcode::BxorImm => Instruction::I32Xor,
                Opcode::ImulImm => Instruction::I32Mul,
                Opcode::IshlImm => Instruction::I32Shl,
                Opcode::RotlImm => Instruction::I32Rotl,
                Opcode::UshrImm => Instruction::I32ShrU,
                _ => unreachable!(),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary { opcode, arg }
            if matches!(opcode, Opcode::FcvtFromSint | Opcode::FcvtFromUint) =>
        {
            let source_type = function.dfg.value_type(arg);
            let result_type = single_result_type(function, inst)?;
            get_value(function, locals, arg, wasm)?;
            wasm.instruction(&match (opcode, source_type, result_type) {
                (Opcode::FcvtFromSint, ir::types::I32, ir::types::F32) => {
                    Instruction::F32ConvertI32S
                }
                (Opcode::FcvtFromSint, ir::types::I64, ir::types::F32) => {
                    Instruction::F32ConvertI64S
                }
                (Opcode::FcvtFromSint, ir::types::I32, ir::types::F64) => {
                    Instruction::F64ConvertI32S
                }
                (Opcode::FcvtFromSint, ir::types::I64, ir::types::F64) => {
                    Instruction::F64ConvertI64S
                }
                (Opcode::FcvtFromUint, ir::types::I32, ir::types::F32) => {
                    Instruction::F32ConvertI32U
                }
                (Opcode::FcvtFromUint, ir::types::I64, ir::types::F32) => {
                    Instruction::F32ConvertI64U
                }
                (Opcode::FcvtFromUint, ir::types::I32, ir::types::F64) => {
                    Instruction::F64ConvertI32U
                }
                (Opcode::FcvtFromUint, ir::types::I64, ir::types::F64) => {
                    Instruction::F64ConvertI64U
                }
                _ => return Err(LowerError::InvalidInstruction(opcode)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary { opcode, arg }
            if matches!(opcode, Opcode::Fpromote | Opcode::Fdemote) =>
        {
            let source_type = function.dfg.value_type(arg);
            let result_type = single_result_type(function, inst)?;
            get_value(function, locals, arg, wasm)?;
            wasm.instruction(&match (opcode, source_type, result_type) {
                (Opcode::Fpromote, ir::types::F32, ir::types::F64) => Instruction::F64PromoteF32,
                (Opcode::Fdemote, ir::types::F64, ir::types::F32) => Instruction::F32DemoteF64,
                _ => return Err(LowerError::InvalidInstruction(opcode)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary { opcode, arg }
            if matches!(opcode, Opcode::Fneg | Opcode::Fabs | Opcode::Sqrt) =>
        {
            let ty = function.dfg.value_type(arg);
            if single_result_type(function, inst)? != ty {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            get_value(function, locals, arg, wasm)?;
            wasm.instruction(&match (opcode, ty) {
                (Opcode::Fneg, ir::types::F32) => Instruction::F32Neg,
                (Opcode::Fneg, ir::types::F64) => Instruction::F64Neg,
                (Opcode::Fneg, ir::types::F32X4) => Instruction::F32x4Neg,
                (Opcode::Fneg, ir::types::F64X2) => Instruction::F64x2Neg,
                (Opcode::Fabs, ir::types::F32) => Instruction::F32Abs,
                (Opcode::Fabs, ir::types::F64) => Instruction::F64Abs,
                (Opcode::Fabs, ir::types::F32X4) => Instruction::F32x4Abs,
                (Opcode::Fabs, ir::types::F64X2) => Instruction::F64x2Abs,
                (Opcode::Sqrt, ir::types::F32) => Instruction::F32Sqrt,
                (Opcode::Sqrt, ir::types::F64) => Instruction::F64Sqrt,
                (Opcode::Sqrt, ir::types::F32X4) => Instruction::F32x4Sqrt,
                (Opcode::Sqrt, ir::types::F64X2) => Instruction::F64x2Sqrt,
                _ => return Err(LowerError::UnsupportedType(ty)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary { opcode, arg }
            if matches!(opcode, Opcode::Fvdemote | Opcode::FvpromoteLow) =>
        {
            let source_type = function.dfg.value_type(arg);
            let result_type = single_result_type(function, inst)?;
            get_value(function, locals, arg, wasm)?;
            wasm.instruction(&match (opcode, source_type, result_type) {
                (Opcode::Fvdemote, ir::types::F64X2, ir::types::F32X4) => {
                    Instruction::F32x4DemoteF64x2Zero
                }
                (Opcode::FvpromoteLow, ir::types::F32X4, ir::types::F64X2) => {
                    Instruction::F64x2PromoteLowF32x4
                }
                _ => return Err(LowerError::InvalidInstruction(opcode)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary { opcode, arg }
            if matches!(opcode, Opcode::FcvtToSintSat | Opcode::FcvtToUintSat) =>
        {
            let source_type = function.dfg.value_type(arg);
            let result_type = single_result_type(function, inst)?;
            get_value(function, locals, arg, wasm)?;
            wasm.instruction(&match (opcode, source_type, result_type) {
                (Opcode::FcvtToSintSat, ir::types::F32, ir::types::I32) => {
                    Instruction::I32TruncSatF32S
                }
                (Opcode::FcvtToSintSat, ir::types::F64, ir::types::I32) => {
                    Instruction::I32TruncSatF64S
                }
                (Opcode::FcvtToSintSat, ir::types::F32, ir::types::I64) => {
                    Instruction::I64TruncSatF32S
                }
                (Opcode::FcvtToSintSat, ir::types::F64, ir::types::I64) => {
                    Instruction::I64TruncSatF64S
                }
                (Opcode::FcvtToUintSat, ir::types::F32, ir::types::I32) => {
                    Instruction::I32TruncSatF32U
                }
                (Opcode::FcvtToUintSat, ir::types::F64, ir::types::I32) => {
                    Instruction::I32TruncSatF64U
                }
                (Opcode::FcvtToUintSat, ir::types::F32, ir::types::I64) => {
                    Instruction::I64TruncSatF32U
                }
                (Opcode::FcvtToUintSat, ir::types::F64, ir::types::I64) => {
                    Instruction::I64TruncSatF64U
                }
                _ => return Err(LowerError::InvalidInstruction(opcode)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary {
            opcode: Opcode::Ireduce,
            arg,
        } => {
            let source_type = function.dfg.value_type(arg);
            let result_type = single_result_type(function, inst)?;
            match (source_type, result_type) {
                (ir::types::I32, ir::types::I8) => {
                    get_value(function, locals, arg, wasm)?;
                    wasm.instruction(&Instruction::I32Const(0xff));
                    wasm.instruction(&Instruction::I32And);
                }
                (ir::types::I32, ir::types::I16) => {
                    get_value(function, locals, arg, wasm)?;
                    wasm.instruction(&Instruction::I32Const(0xffff));
                    wasm.instruction(&Instruction::I32And);
                }
                (ir::types::I64, ir::types::I32) => {
                    get_value(function, locals, arg, wasm)?;
                    wasm.instruction(&Instruction::I32WrapI64);
                }
                _ => return Err(LowerError::InvalidInstruction(opcode)),
            }
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary {
            opcode: Opcode::Uextend,
            arg,
        } => {
            let source_type = function.dfg.value_type(arg);
            let result_type = single_result_type(function, inst)?;
            match (source_type, result_type) {
                (ir::types::I8 | ir::types::I16, ir::types::I32) => {
                    get_value(function, locals, arg, wasm)?;
                }
                (ir::types::I8 | ir::types::I16 | ir::types::I32, ir::types::I64) => {
                    get_value(function, locals, arg, wasm)?;
                    wasm.instruction(&Instruction::I64ExtendI32U);
                }
                _ => return Err(LowerError::InvalidInstruction(opcode)),
            }
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary {
            opcode: Opcode::Sextend,
            arg,
        } => {
            let source_type = function.dfg.value_type(arg);
            let result_type = single_result_type(function, inst)?;
            get_value(function, locals, arg, wasm)?;
            match (source_type, result_type) {
                (ir::types::I8, ir::types::I32) => {
                    wasm.instruction(&Instruction::I32Extend8S);
                }
                (ir::types::I16, ir::types::I32) => {
                    wasm.instruction(&Instruction::I32Extend16S);
                }
                (ir::types::I8, ir::types::I64) => {
                    wasm.instruction(&Instruction::I32Extend8S);
                    wasm.instruction(&Instruction::I64ExtendI32S);
                }
                (ir::types::I16, ir::types::I64) => {
                    wasm.instruction(&Instruction::I32Extend16S);
                    wasm.instruction(&Instruction::I64ExtendI32S);
                }
                (ir::types::I32, ir::types::I64) => {
                    wasm.instruction(&Instruction::I64ExtendI32S);
                }
                _ => return Err(LowerError::InvalidInstruction(opcode)),
            }
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary {
            opcode: Opcode::ScalarToVector,
            arg,
        } => {
            let result_type = single_result_type(function, inst)?;
            wasm_storage_type(function.dfg.value_type(arg))?;
            wasm.instruction(&Instruction::V128Const(0));
            get_value(function, locals, arg, wasm)?;
            wasm.instruction(&match result_type {
                ir::types::I8X16 => Instruction::I8x16ReplaceLane(0),
                ir::types::I16X8 => Instruction::I16x8ReplaceLane(0),
                ir::types::I32X4 => Instruction::I32x4ReplaceLane(0),
                ir::types::I64X2 => Instruction::I64x2ReplaceLane(0),
                ir::types::F32X4 => Instruction::F32x4ReplaceLane(0),
                ir::types::F64X2 => Instruction::F64x2ReplaceLane(0),
                _ => return Err(LowerError::UnsupportedType(result_type)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary {
            opcode: Opcode::Splat,
            arg,
        } => {
            let result_type = single_result_type(function, inst)?;
            wasm_storage_type(function.dfg.value_type(arg))?;
            get_value(function, locals, arg, wasm)?;
            wasm.instruction(&match result_type {
                ir::types::I8X16 => Instruction::I8x16Splat,
                ir::types::I16X8 => Instruction::I16x8Splat,
                ir::types::I32X4 => Instruction::I32x4Splat,
                ir::types::I64X2 => Instruction::I64x2Splat,
                ir::types::F32X4 => Instruction::F32x4Splat,
                ir::types::F64X2 => Instruction::F64x2Splat,
                _ => return Err(LowerError::UnsupportedType(result_type)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary {
            opcode: Opcode::Ineg,
            arg,
        } => {
            let ty = function.dfg.value_type(arg);
            if single_result_type(function, inst)? != ty {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            match ty {
                ir::types::I32 => wasm.instruction(&Instruction::I32Const(0)),
                ir::types::I64 => wasm.instruction(&Instruction::I64Const(0)),
                _ => return Err(LowerError::UnsupportedType(ty)),
            };
            get_value(function, locals, arg, wasm)?;
            wasm.instruction(&match ty {
                ir::types::I32 => Instruction::I32Sub,
                ir::types::I64 => Instruction::I64Sub,
                _ => unreachable!(),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary {
            opcode: Opcode::Bnot,
            arg,
        } => {
            let ty = function.dfg.value_type(arg);
            if single_result_type(function, inst)? != ty {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            get_value(function, locals, arg, wasm)?;
            match ty {
                ir::types::I8 => {
                    wasm.instruction(&Instruction::I32Const(0xff));
                    wasm.instruction(&Instruction::I32Xor);
                }
                ir::types::I16 => {
                    wasm.instruction(&Instruction::I32Const(0xffff));
                    wasm.instruction(&Instruction::I32Xor);
                }
                ir::types::I32 => {
                    wasm.instruction(&Instruction::I32Const(-1));
                    wasm.instruction(&Instruction::I32Xor);
                }
                ir::types::I64 => {
                    wasm.instruction(&Instruction::I64Const(-1));
                    wasm.instruction(&Instruction::I64Xor);
                }
                ty if ty.is_vector() && ty.bits() == 128 => {
                    wasm.instruction(&Instruction::V128Not);
                }
                _ => return Err(LowerError::UnsupportedType(ty)),
            }
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary {
            opcode: Opcode::Clz,
            arg,
        } => {
            let ty = function.dfg.value_type(arg);
            if single_result_type(function, inst)? != ty {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            get_value(function, locals, arg, wasm)?;
            wasm.instruction(&match ty {
                ir::types::I32 => Instruction::I32Clz,
                ir::types::I64 => Instruction::I64Clz,
                _ => return Err(LowerError::UnsupportedType(ty)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary {
            opcode: Opcode::Ctz,
            arg,
        } => {
            let ty = function.dfg.value_type(arg);
            if single_result_type(function, inst)? != ty {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            get_value(function, locals, arg, wasm)?;
            wasm.instruction(&match ty {
                ir::types::I32 => Instruction::I32Ctz,
                ir::types::I64 => Instruction::I64Ctz,
                _ => return Err(LowerError::UnsupportedType(ty)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::LoadNoOffset {
            opcode: Opcode::Bitcast,
            arg,
            flags,
        } => {
            let source_type = function.dfg.value_type(arg);
            let result_type = single_result_type(function, inst)?;
            if source_type.is_vector() || result_type.is_vector() {
                require_little_endian(flags)?;
            }
            get_value(function, locals, arg, wasm)?;
            match (source_type, result_type) {
                (ir::types::I32, ir::types::F32) => {
                    wasm.instruction(&Instruction::F32ReinterpretI32);
                }
                (ir::types::F32, ir::types::I32) => {
                    wasm.instruction(&Instruction::I32ReinterpretF32);
                }
                (ir::types::I64, ir::types::F64) => {
                    wasm.instruction(&Instruction::F64ReinterpretI64);
                }
                (ir::types::F64, ir::types::I64) => {
                    wasm.instruction(&Instruction::I64ReinterpretF64);
                }
                (source, result)
                    if source.is_vector()
                        && result.is_vector()
                        && source.bits() == 128
                        && result.bits() == 128 => {}
                _ => return Err(LowerError::InvalidInstruction(opcode)),
            }
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Unary {
            opcode: Opcode::Bswap,
            arg,
        } => {
            let ty = function.dfg.value_type(arg);
            if single_result_type(function, inst)? != ty {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            match ty {
                ir::types::I16 => emit_i16_bswap(function, locals, arg, wasm)?,
                ir::types::I32 => emit_i32_bswap(function, locals, arg, wasm)?,
                ir::types::I64 => emit_i64_bswap(function, locals, arg, wasm)?,
                _ => return Err(LowerError::UnsupportedType(ty)),
            }
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::IntCompare {
            opcode: Opcode::Icmp,
            args,
            cond,
        } => {
            require_i32_value(function, args[0])?;
            require_i32_value(function, args[1])?;
            require_single_type(function, inst, ir::types::I8)?;
            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            wasm.instruction(&comparison(cond));
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::FloatCompare {
            opcode: Opcode::Fcmp,
            args,
            cond,
        } => {
            let ty = function.dfg.value_type(args[0]);
            if function.dfg.value_type(args[1]) != ty {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            let expected_result_type = match ty {
                ir::types::F32 | ir::types::F64 => ir::types::I8,
                ir::types::F32X4 => ir::types::I32X4,
                ir::types::F64X2 => ir::types::I64X2,
                _ => return Err(LowerError::UnsupportedType(ty)),
            };
            require_single_type(function, inst, expected_result_type)?;
            match cond {
                FloatCC::Equal
                | FloatCC::LessThan
                | FloatCC::GreaterThan
                | FloatCC::GreaterThanOrEqual => {
                    get_value(function, locals, args[0], wasm)?;
                    get_value(function, locals, args[1], wasm)?;
                    wasm.instruction(&match (cond, ty) {
                        (FloatCC::Equal, ir::types::F32) => Instruction::F32Eq,
                        (FloatCC::Equal, ir::types::F64) => Instruction::F64Eq,
                        (FloatCC::Equal, ir::types::F32X4) => Instruction::F32x4Eq,
                        (FloatCC::Equal, ir::types::F64X2) => Instruction::F64x2Eq,
                        (FloatCC::LessThan, ir::types::F32) => Instruction::F32Lt,
                        (FloatCC::LessThan, ir::types::F64) => Instruction::F64Lt,
                        (FloatCC::LessThan, ir::types::F32X4) => Instruction::F32x4Lt,
                        (FloatCC::LessThan, ir::types::F64X2) => Instruction::F64x2Lt,
                        (FloatCC::GreaterThan, ir::types::F32) => Instruction::F32Gt,
                        (FloatCC::GreaterThan, ir::types::F64) => Instruction::F64Gt,
                        (FloatCC::GreaterThan, ir::types::F32X4) => Instruction::F32x4Gt,
                        (FloatCC::GreaterThan, ir::types::F64X2) => Instruction::F64x2Gt,
                        (FloatCC::GreaterThanOrEqual, ir::types::F32) => Instruction::F32Ge,
                        (FloatCC::GreaterThanOrEqual, ir::types::F64) => Instruction::F64Ge,
                        (FloatCC::GreaterThanOrEqual, ir::types::F32X4) => Instruction::F32x4Ge,
                        (FloatCC::GreaterThanOrEqual, ir::types::F64X2) => Instruction::F64x2Ge,
                        _ => return Err(LowerError::UnsupportedType(ty)),
                    });
                }
                FloatCC::Unordered => {
                    get_value(function, locals, args[0], wasm)?;
                    get_value(function, locals, args[0], wasm)?;
                    wasm.instruction(&match ty {
                        ir::types::F32 => Instruction::F32Ne,
                        ir::types::F64 => Instruction::F64Ne,
                        ir::types::F32X4 => Instruction::F32x4Ne,
                        ir::types::F64X2 => Instruction::F64x2Ne,
                        _ => return Err(LowerError::UnsupportedType(ty)),
                    });
                    get_value(function, locals, args[1], wasm)?;
                    get_value(function, locals, args[1], wasm)?;
                    wasm.instruction(&match ty {
                        ir::types::F32 => Instruction::F32Ne,
                        ir::types::F64 => Instruction::F64Ne,
                        ir::types::F32X4 => Instruction::F32x4Ne,
                        ir::types::F64X2 => Instruction::F64x2Ne,
                        _ => return Err(LowerError::UnsupportedType(ty)),
                    });
                    wasm.instruction(&if ty.is_vector() {
                        Instruction::V128Or
                    } else {
                        Instruction::I32Or
                    });
                }
                _ => return Err(LowerError::InvalidInstruction(opcode)),
            }
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::IntCompareImm {
            opcode: Opcode::IcmpImm,
            arg,
            cond,
            imm,
        } => {
            require_i32_value(function, arg)?;
            require_single_type(function, inst, ir::types::I8)?;
            get_value(function, locals, arg, wasm)?;
            wasm.instruction(&Instruction::I32Const(imm.bits() as i32));
            wasm.instruction(&comparison(cond));
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Load {
            opcode: Opcode::Load,
            arg,
            flags,
            offset,
        } => {
            require_i32_value(function, arg)?;
            require_little_endian(flags)?;
            let result_type = single_result_type(function, inst)?;
            let align = memory_alignment(result_type)?;
            let memarg = address(function, locals, arg, offset.into(), align, wasm)?;
            wasm.instruction(&load_instruction(result_type, memarg)?);
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Store {
            opcode: Opcode::Store,
            args,
            flags,
            offset,
        } => {
            require_i32_value(function, args[1])?;
            require_little_endian(flags)?;
            let value_type = function.dfg.value_type(args[0]);
            let align = memory_alignment(value_type)?;
            let memarg = address(function, locals, args[1], offset.into(), align, wasm)?;
            get_value(function, locals, args[0], wasm)?;
            wasm.instruction(&store_instruction(value_type, memarg)?);
            Control::None
        }
        InstructionData::StackLoad {
            opcode: Opcode::StackLoad,
            stack_slot,
            offset,
        } => {
            let result_type = single_result_type(function, inst)?;
            let align = memory_alignment(result_type)?;
            let memarg = stack_memarg(
                stack_offsets,
                stack_scratch,
                stack_slot,
                offset.into(),
                align,
                opcode,
                wasm,
            )?;
            wasm.instruction(&load_instruction(result_type, memarg)?);
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::StackStore {
            opcode: Opcode::StackStore,
            arg,
            stack_slot,
            offset,
        } => {
            let value_type = function.dfg.value_type(arg);
            let align = memory_alignment(value_type)?;
            let memarg = stack_memarg(
                stack_offsets,
                stack_scratch,
                stack_slot,
                offset.into(),
                align,
                opcode,
                wasm,
            )?;
            get_value(function, locals, arg, wasm)?;
            wasm.instruction(&store_instruction(value_type, memarg)?);
            Control::None
        }
        InstructionData::StackLoad {
            opcode: Opcode::StackAddr,
            stack_slot,
            offset,
        } => {
            require_single_i32_result(function, inst)?;
            let (base_parameter, scratch_offset, _) =
                stack_scratch.ok_or(LowerError::StackScratchTooSmall {
                    required: 1,
                    available: 0,
                })?;
            let slot_offset = stack_offsets
                .get(&stack_slot)
                .copied()
                .ok_or(LowerError::InvalidInstruction(opcode))?;
            let offset: i32 = offset.into();
            let offset =
                u32::try_from(offset).map_err(|_| LowerError::InvalidInstruction(opcode))?;
            let address_offset = scratch_offset
                .checked_add(slot_offset)
                .and_then(|address| address.checked_add(offset))
                .ok_or(LowerError::InvalidInstruction(opcode))?;
            wasm.instruction(&Instruction::LocalGet(base_parameter));
            wasm.instruction(&Instruction::I32Const(address_offset as i32));
            wasm.instruction(&Instruction::I32Add);
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::TernaryImm8 {
            opcode: Opcode::Insertlane,
            args,
            imm,
        } => {
            let vector_type = function.dfg.value_type(args[0]);
            if single_result_type(function, inst)? != vector_type {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            wasm_storage_type(function.dfg.value_type(args[1]))?;
            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            let lane = imm;
            wasm.instruction(&match vector_type {
                ir::types::I8X16 => Instruction::I8x16ReplaceLane(lane),
                ir::types::I16X8 => Instruction::I16x8ReplaceLane(lane),
                ir::types::I32X4 => Instruction::I32x4ReplaceLane(lane),
                ir::types::I64X2 => Instruction::I64x2ReplaceLane(lane),
                ir::types::F32X4 => Instruction::F32x4ReplaceLane(lane),
                ir::types::F64X2 => Instruction::F64x2ReplaceLane(lane),
                _ => return Err(LowerError::UnsupportedType(vector_type)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::BinaryImm8 {
            opcode: Opcode::Extractlane,
            arg,
            imm,
        } => {
            let vector_type = function.dfg.value_type(arg);
            require_single_storage_result(function, inst)?;
            get_value(function, locals, arg, wasm)?;
            wasm.instruction(&match vector_type {
                ir::types::I8X16 => Instruction::I8x16ExtractLaneU(imm),
                ir::types::I16X8 => Instruction::I16x8ExtractLaneU(imm),
                ir::types::I32X4 => Instruction::I32x4ExtractLane(imm),
                ir::types::I64X2 => Instruction::I64x2ExtractLane(imm),
                ir::types::F32X4 => Instruction::F32x4ExtractLane(imm),
                ir::types::F64X2 => Instruction::F64x2ExtractLane(imm),
                _ => return Err(LowerError::UnsupportedType(vector_type)),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Ternary {
            opcode: Opcode::Fma,
            args,
        } => {
            let ty = function.dfg.value_type(args[0]);
            if function.dfg.value_type(args[1]) != ty
                || function.dfg.value_type(args[2]) != ty
                || single_result_type(function, inst)? != ty
            {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            // Core Wasm has no scalar fused multiply-add. Keep this browser-compatible by
            // preserving the operation order as multiply followed by add.
            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            wasm.instruction(&match ty {
                ir::types::F32 => Instruction::F32Mul,
                ir::types::F64 => Instruction::F64Mul,
                ir::types::F32X4 => Instruction::F32x4Mul,
                ir::types::F64X2 => Instruction::F64x2Mul,
                _ => return Err(LowerError::UnsupportedType(ty)),
            });
            get_value(function, locals, args[2], wasm)?;
            wasm.instruction(&match ty {
                ir::types::F32 => Instruction::F32Add,
                ir::types::F64 => Instruction::F64Add,
                ir::types::F32X4 => Instruction::F32x4Add,
                ir::types::F64X2 => Instruction::F64x2Add,
                _ => unreachable!(),
            });
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Ternary {
            opcode: Opcode::Bitselect,
            args,
        } => {
            let ty = function.dfg.value_type(args[0]);
            if function.dfg.value_type(args[1]) != ty
                || function.dfg.value_type(args[2]) != ty
                || single_result_type(function, inst)? != ty
            {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            match ty {
                ir::types::I32 => {
                    get_value(function, locals, args[0], wasm)?;
                    get_value(function, locals, args[1], wasm)?;
                    wasm.instruction(&Instruction::I32And);
                    get_value(function, locals, args[0], wasm)?;
                    wasm.instruction(&Instruction::I32Const(-1));
                    wasm.instruction(&Instruction::I32Xor);
                    get_value(function, locals, args[2], wasm)?;
                    wasm.instruction(&Instruction::I32And);
                    wasm.instruction(&Instruction::I32Or);
                }
                ty if ty.is_vector() && ty.bits() == 128 => {
                    get_value(function, locals, args[1], wasm)?;
                    get_value(function, locals, args[2], wasm)?;
                    get_value(function, locals, args[0], wasm)?;
                    wasm.instruction(&Instruction::V128Bitselect);
                }
                _ => return Err(LowerError::UnsupportedType(ty)),
            }
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Ternary {
            opcode: Opcode::Select,
            args,
        } => {
            require_i32_storage(function.dfg.value_type(args[0]))?;
            let value_type = function.dfg.value_type(args[1]);
            if function.dfg.value_type(args[2]) != value_type
                || single_result_type(function, inst)? != value_type
            {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            wasm_storage_type(value_type)?;
            get_value(function, locals, args[1], wasm)?;
            get_value(function, locals, args[2], wasm)?;
            get_value(function, locals, args[0], wasm)?;
            wasm.instruction(&Instruction::Select);
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Shuffle {
            opcode: Opcode::Shuffle,
            args,
            imm,
        } => {
            let result_type = single_result_type(function, inst)?;
            if result_type != ir::types::I8X16
                || function.dfg.value_type(args[0]) != ir::types::I8X16
                || function.dfg.value_type(args[1]) != ir::types::I8X16
            {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            let lanes: [u8; 16] = function
                .dfg
                .immediates
                .get(imm)
                .ok_or(LowerError::InvalidInstruction(opcode))?
                .as_slice()
                .try_into()
                .map_err(|_| LowerError::InvalidInstruction(opcode))?;
            get_value(function, locals, args[0], wasm)?;
            get_value(function, locals, args[1], wasm)?;
            wasm.instruction(&Instruction::I8x16Shuffle(lanes));
            set_result(function, locals, inst, wasm)?;
            Control::None
        }
        InstructionData::Call {
            opcode: Opcode::Call,
            func_ref,
            ..
        } => {
            for argument in function.dfg.inst_args(inst).iter().copied() {
                wasm_storage_type(function.dfg.value_type(argument))?;
                get_value(function, locals, argument, wasm)?;
            }
            let function_index = call_indices
                .get(&func_ref)
                .copied()
                .ok_or(LowerError::InvalidExternalFunction(func_ref))?;
            wasm.instruction(&Instruction::Call(function_index));
            for result in function.dfg.inst_results(inst).iter().rev().copied() {
                wasm_storage_type(function.dfg.value_type(result))?;
                wasm.instruction(&Instruction::LocalSet(local(function, locals, result)?));
            }
            Control::None
        }
        InstructionData::MultiAry {
            opcode: Opcode::Return,
            ..
        } => {
            let returns = function.dfg.inst_args(inst);
            if returns.len() != 1 {
                return Err(LowerError::InvalidInstruction(opcode));
            }
            require_i32_value(function, returns[0])?;
            get_value(function, locals, returns[0], wasm)?;
            wasm.instruction(&Instruction::Return);
            Control::Return
        }
        InstructionData::Jump {
            opcode: Opcode::Jump,
            destination,
        } => Control::Jump(destination),
        InstructionData::Brif {
            opcode: Opcode::Brif,
            arg,
            blocks,
        } => Control::Brif {
            condition: arg,
            then_edge: blocks[0],
            else_edge: blocks[1],
        },
        _ => return Err(LowerError::UnsupportedOpcode(opcode)),
    };

    Ok(control)
}

fn allocate_local(
    function: &ir::Function,
    locals: &mut HashMap<Value, u32>,
    local_types: &mut Vec<ValType>,
    value: Value,
    next_local: &mut u32,
) -> Result<(), LowerError> {
    let value = function.dfg.resolve_aliases(value);
    if let std::collections::hash_map::Entry::Vacant(entry) = locals.entry(value) {
        let ty = wasm_storage_type(function.dfg.value_type(value))?;
        let local = *next_local;
        *next_local += 1;
        local_types.push(ty);
        entry.insert(local);
    }
    Ok(())
}

fn lower_dispatcher(
    function: &ir::Function,
    blocks: &[Block],
    locals: &HashMap<Value, u32>,
    call_indices: &HashMap<FuncRef, u32>,
    stack_offsets: &HashMap<StackSlot, u32>,
    stack_scratch: Option<(u32, u32, u32)>,
    state_local: u32,
    wasm: &mut Function,
) -> Result<(), LowerError> {
    let block_indexes = blocks
        .iter()
        .copied()
        .enumerate()
        .map(|(index, block)| (block, index as u32))
        .collect::<HashMap<_, _>>();
    let block_count = blocks.len() as u32;

    // The entry block is first in CLIF layout order, but initialize the state
    // explicitly so the encoding does not rely on Wasm's zeroed locals.
    wasm.instruction(&Instruction::I32Const(0));
    wasm.instruction(&Instruction::LocalSet(state_local));
    wasm.instruction(&Instruction::Loop(BlockType::Empty));

    // A default br_table target exits this guard and reaches `unreachable`,
    // making a corrupt dispatcher state trap instead of silently looping.
    wasm.instruction(&Instruction::Block(BlockType::Empty));
    for _ in blocks.iter().rev() {
        wasm.instruction(&Instruction::Block(BlockType::Empty));
    }
    wasm.instruction(&Instruction::LocalGet(state_local));
    wasm.instruction(&Instruction::BrTable(
        (0..block_count).collect::<Vec<_>>().into(),
        block_count,
    ));

    for (index, block) in blocks.iter().copied().enumerate() {
        // End the case label selected by this block's state.
        wasm.instruction(&Instruction::End);

        let mut control = Control::None;
        for inst in function.layout.block_insts(block) {
            control = lower_instruction(
                function,
                locals,
                call_indices,
                stack_offsets,
                stack_scratch,
                inst,
                wasm,
            )?;
        }

        let dispatch_depth = block_count - index as u32;
        match control {
            Control::None => return Err(LowerError::MissingReturn),
            Control::Return => {}
            Control::Jump(edge) => {
                emit_edge(
                    function,
                    locals,
                    state_local,
                    edge,
                    &block_indexes,
                    Opcode::Jump,
                    wasm,
                )?;
                wasm.instruction(&Instruction::Br(dispatch_depth));
            }
            Control::Brif {
                condition,
                then_edge,
                else_edge,
            } => {
                require_i32_storage(function.dfg.value_type(condition))?;
                get_value(function, locals, condition, wasm)?;
                wasm.instruction(&Instruction::If(BlockType::Empty));
                emit_edge(
                    function,
                    locals,
                    state_local,
                    then_edge,
                    &block_indexes,
                    Opcode::Brif,
                    wasm,
                )?;
                wasm.instruction(&Instruction::Br(dispatch_depth + 1));
                wasm.instruction(&Instruction::Else);
                emit_edge(
                    function,
                    locals,
                    state_local,
                    else_edge,
                    &block_indexes,
                    Opcode::Brif,
                    wasm,
                )?;
                wasm.instruction(&Instruction::Br(dispatch_depth + 1));
                wasm.instruction(&Instruction::End);
            }
        }
    }

    wasm.instruction(&Instruction::End);
    wasm.instruction(&Instruction::Unreachable);
    wasm.instruction(&Instruction::End);
    // The loop can only return, branch back to itself, or trap. Keep the
    // function's fallthrough unreachable for result-bearing signatures.
    wasm.instruction(&Instruction::Unreachable);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn emit_edge(
    function: &ir::Function,
    locals: &HashMap<Value, u32>,
    state_local: u32,
    edge: BlockCall,
    block_indexes: &HashMap<Block, u32>,
    opcode: Opcode,
    wasm: &mut Function,
) -> Result<(), LowerError> {
    let target = edge.block(&function.dfg.value_lists);
    let parameters = function.dfg.block_params(target);
    let arguments = edge.args(&function.dfg.value_lists).collect::<Vec<_>>();
    if parameters.len() != arguments.len() {
        return Err(LowerError::InvalidInstruction(opcode));
    }

    // Read every source before writing any destination. The Wasm operand stack
    // acts as the temporary storage needed for simultaneous SSA phi copies.
    for argument in arguments {
        let BlockArg::Value(value) = argument else {
            return Err(LowerError::InvalidInstruction(opcode));
        };
        wasm_storage_type(function.dfg.value_type(value))?;
        get_value(function, locals, value, wasm)?;
    }
    for parameter in parameters.iter().rev().copied() {
        wasm.instruction(&Instruction::LocalSet(local(function, locals, parameter)?));
    }

    let target_index = block_indexes
        .get(&target)
        .copied()
        .ok_or(LowerError::InvalidInstruction(opcode))?;
    wasm.instruction(&Instruction::I32Const(target_index as i32));
    wasm.instruction(&Instruction::LocalSet(state_local));
    Ok(())
}

fn wasm_type(ty: Type) -> Result<ValType, LowerError> {
    require_i32(ty)?;
    Ok(ValType::I32)
}

fn wasm_storage_type(ty: Type) -> Result<ValType, LowerError> {
    match ty {
        ir::types::I8 | ir::types::I16 | ir::types::I32 => Ok(ValType::I32),
        ir::types::I64 => Ok(ValType::I64),
        ir::types::F32 => Ok(ValType::F32),
        ir::types::F64 => Ok(ValType::F64),
        ty if ty.is_vector() && ty.bits() == 128 => Ok(ValType::V128),
        _ => Err(LowerError::UnsupportedType(ty)),
    }
}

fn external_function_name(
    function: &ir::Function,
    reference: FuncRef,
) -> Result<String, LowerError> {
    let external = function
        .dfg
        .ext_funcs
        .get(reference)
        .ok_or(LowerError::InvalidExternalFunction(reference))?;
    match &external.name {
        ir::ExternalName::User(name_reference) => {
            let name = function
                .params
                .user_named_funcs()
                .get(*name_reference)
                .ok_or(LowerError::InvalidExternalFunction(reference))?;
            Ok(format!("user_{}_{}", name.namespace, name.index))
        }
        ir::ExternalName::LibCall(libcall) => Ok(format!("libcall_{libcall}")),
        _ => Err(LowerError::InvalidExternalFunction(reference)),
    }
}

fn require_i32_storage(ty: Type) -> Result<(), LowerError> {
    if matches!(ty, ir::types::I8 | ir::types::I16 | ir::types::I32) {
        Ok(())
    } else {
        Err(LowerError::UnsupportedType(ty))
    }
}

fn require_i32(ty: Type) -> Result<(), LowerError> {
    if ty == ir::types::I32 {
        Ok(())
    } else {
        Err(LowerError::UnsupportedType(ty))
    }
}

fn require_i32_value(function: &ir::Function, value: Value) -> Result<(), LowerError> {
    require_i32(function.dfg.value_type(value))
}

fn require_single_i32_result(function: &ir::Function, inst: ir::Inst) -> Result<(), LowerError> {
    require_single_type(function, inst, ir::types::I32)
}

fn require_single_storage_result(
    function: &ir::Function,
    inst: ir::Inst,
) -> Result<(), LowerError> {
    wasm_storage_type(single_result_type(function, inst)?).map(|_| ())
}

fn require_single_type(
    function: &ir::Function,
    inst: ir::Inst,
    expected: Type,
) -> Result<(), LowerError> {
    let actual = single_result_type(function, inst)?;
    if actual == expected {
        Ok(())
    } else {
        Err(LowerError::UnsupportedType(actual))
    }
}

fn single_result_type(function: &ir::Function, inst: ir::Inst) -> Result<Type, LowerError> {
    let results = function.dfg.inst_results(inst);
    if results.len() != 1 {
        return Err(LowerError::InvalidInstruction(
            function.dfg.insts[inst].opcode(),
        ));
    }
    Ok(function.dfg.value_type(results[0]))
}

fn memory_alignment(ty: Type) -> Result<u32, LowerError> {
    match ty {
        ir::types::I8 => Ok(0),
        ir::types::I16 => Ok(1),
        ir::types::I32 | ir::types::F32 => Ok(2),
        ir::types::I64 | ir::types::F64 => Ok(3),
        ty if ty.is_vector() && ty.bits() == 128 => Ok(4),
        _ => Err(LowerError::UnsupportedType(ty)),
    }
}

fn load_instruction(ty: Type, memarg: MemArg) -> Result<Instruction<'static>, LowerError> {
    match ty {
        ir::types::I8 => Ok(Instruction::I32Load8U(memarg)),
        ir::types::I16 => Ok(Instruction::I32Load16U(memarg)),
        ir::types::I32 => Ok(Instruction::I32Load(memarg)),
        ir::types::I64 => Ok(Instruction::I64Load(memarg)),
        ir::types::F32 => Ok(Instruction::F32Load(memarg)),
        ir::types::F64 => Ok(Instruction::F64Load(memarg)),
        ty if ty.is_vector() && ty.bits() == 128 => Ok(Instruction::V128Load(memarg)),
        _ => Err(LowerError::UnsupportedType(ty)),
    }
}

fn store_instruction(ty: Type, memarg: MemArg) -> Result<Instruction<'static>, LowerError> {
    match ty {
        ir::types::I8 => Ok(Instruction::I32Store8(memarg)),
        ir::types::I16 => Ok(Instruction::I32Store16(memarg)),
        ir::types::I32 => Ok(Instruction::I32Store(memarg)),
        ir::types::I64 => Ok(Instruction::I64Store(memarg)),
        ir::types::F32 => Ok(Instruction::F32Store(memarg)),
        ir::types::F64 => Ok(Instruction::F64Store(memarg)),
        ty if ty.is_vector() && ty.bits() == 128 => Ok(Instruction::V128Store(memarg)),
        _ => Err(LowerError::UnsupportedType(ty)),
    }
}

fn comparison(condition: IntCC) -> Instruction<'static> {
    match condition {
        IntCC::Equal => Instruction::I32Eq,
        IntCC::NotEqual => Instruction::I32Ne,
        IntCC::SignedLessThan => Instruction::I32LtS,
        IntCC::SignedGreaterThanOrEqual => Instruction::I32GeS,
        IntCC::SignedGreaterThan => Instruction::I32GtS,
        IntCC::SignedLessThanOrEqual => Instruction::I32LeS,
        IntCC::UnsignedLessThan => Instruction::I32LtU,
        IntCC::UnsignedGreaterThanOrEqual => Instruction::I32GeU,
        IntCC::UnsignedGreaterThan => Instruction::I32GtU,
        IntCC::UnsignedLessThanOrEqual => Instruction::I32LeU,
    }
}

fn require_little_endian(flags: MemFlags) -> Result<(), LowerError> {
    match flags.explicit_endianness() {
        None | Some(Endianness::Little) => Ok(()),
        Some(endianness @ Endianness::Big) => Err(LowerError::UnsupportedEndianness(endianness)),
    }
}

fn emit_i32_bswap(
    function: &ir::Function,
    locals: &HashMap<Value, u32>,
    value: Value,
    wasm: &mut Function,
) -> Result<(), LowerError> {
    let parts = [
        (0x0000_00ffu32, 24, true),
        (0x0000_ff00, 8, true),
        (0x00ff_0000, 8, false),
        (0xff00_0000, 24, false),
    ];

    for (index, (mask, shift, left)) in parts.into_iter().enumerate() {
        get_value(function, locals, value, wasm)?;
        wasm.instruction(&Instruction::I32Const(mask as i32));
        wasm.instruction(&Instruction::I32And);
        wasm.instruction(&Instruction::I32Const(shift));
        wasm.instruction(&if left {
            Instruction::I32Shl
        } else {
            Instruction::I32ShrU
        });
        if index != 0 {
            wasm.instruction(&Instruction::I32Or);
        }
    }

    Ok(())
}

fn emit_i16_bswap(
    function: &ir::Function,
    locals: &HashMap<Value, u32>,
    value: Value,
    wasm: &mut Function,
) -> Result<(), LowerError> {
    get_value(function, locals, value, wasm)?;
    wasm.instruction(&Instruction::I32Const(0xff));
    wasm.instruction(&Instruction::I32And);
    wasm.instruction(&Instruction::I32Const(8));
    wasm.instruction(&Instruction::I32Shl);
    get_value(function, locals, value, wasm)?;
    wasm.instruction(&Instruction::I32Const(8));
    wasm.instruction(&Instruction::I32ShrU);
    wasm.instruction(&Instruction::I32Const(0xff));
    wasm.instruction(&Instruction::I32And);
    wasm.instruction(&Instruction::I32Or);
    Ok(())
}

fn emit_i64_bswap(
    function: &ir::Function,
    locals: &HashMap<Value, u32>,
    value: Value,
    wasm: &mut Function,
) -> Result<(), LowerError> {
    for source_byte in 0..8u32 {
        let source_shift = source_byte * 8;
        let destination_shift = (7 - source_byte) * 8;
        get_value(function, locals, value, wasm)?;
        wasm.instruction(&Instruction::I64Const((0xffu64 << source_shift) as i64));
        wasm.instruction(&Instruction::I64And);
        if destination_shift > source_shift {
            wasm.instruction(&Instruction::I64Const(
                (destination_shift - source_shift) as i64,
            ));
            wasm.instruction(&Instruction::I64Shl);
        } else if source_shift > destination_shift {
            wasm.instruction(&Instruction::I64Const(
                (source_shift - destination_shift) as i64,
            ));
            wasm.instruction(&Instruction::I64ShrU);
        }
        if source_byte != 0 {
            wasm.instruction(&Instruction::I64Or);
        }
    }
    Ok(())
}

fn local(
    function: &ir::Function,
    locals: &HashMap<Value, u32>,
    value: Value,
) -> Result<u32, LowerError> {
    let value = function.dfg.resolve_aliases(value);
    locals
        .get(&value)
        .copied()
        .ok_or(LowerError::MissingValue(value))
}

fn get_value(
    function: &ir::Function,
    locals: &HashMap<Value, u32>,
    value: Value,
    wasm: &mut Function,
) -> Result<(), LowerError> {
    wasm.instruction(&Instruction::LocalGet(local(function, locals, value)?));
    Ok(())
}

fn set_result(
    function: &ir::Function,
    locals: &HashMap<Value, u32>,
    inst: ir::Inst,
    wasm: &mut Function,
) -> Result<(), LowerError> {
    let results = function.dfg.inst_results(inst);
    if results.len() != 1 {
        return Err(LowerError::InvalidInstruction(
            function.dfg.insts[inst].opcode(),
        ));
    }
    wasm.instruction(&Instruction::LocalSet(local(function, locals, results[0])?));
    Ok(())
}

fn address(
    function: &ir::Function,
    locals: &HashMap<Value, u32>,
    base: Value,
    offset: i32,
    align: u32,
    wasm: &mut Function,
) -> Result<MemArg, LowerError> {
    get_value(function, locals, base, wasm)?;

    let offset = if offset < 0 {
        wasm.instruction(&Instruction::I32Const(offset));
        wasm.instruction(&Instruction::I32Add);
        0
    } else {
        offset as u64
    };

    Ok(MemArg {
        offset,
        align,
        memory_index: 0,
    })
}

fn stack_memarg(
    stack_offsets: &HashMap<StackSlot, u32>,
    stack_scratch: Option<(u32, u32, u32)>,
    stack_slot: StackSlot,
    offset: i32,
    align: u32,
    opcode: Opcode,
    wasm: &mut Function,
) -> Result<MemArg, LowerError> {
    let (base_parameter, scratch_offset, _) =
        stack_scratch.ok_or(LowerError::StackScratchTooSmall {
            required: 1,
            available: 0,
        })?;
    let slot_offset = stack_offsets
        .get(&stack_slot)
        .copied()
        .ok_or(LowerError::InvalidInstruction(opcode))?;
    let offset = u32::try_from(offset).map_err(|_| LowerError::InvalidInstruction(opcode))?;
    let offset = scratch_offset
        .checked_add(slot_offset)
        .and_then(|address| address.checked_add(offset))
        .ok_or(LowerError::InvalidInstruction(opcode))?;
    wasm.instruction(&Instruction::LocalGet(base_parameter));
    Ok(MemArg {
        offset: offset.into(),
        align,
        memory_index: 0,
    })
}

#[cfg(test)]
mod tests {
    use cranelift_codegen::ir::{self, InstBuilder};
    use cranelift_frontend::{FunctionBuilder, FunctionBuilderContext};
    use wasmparser::Validator;

    use super::{LowerError, ModuleConfig, function};

    fn identity_function() -> ir::Function {
        let mut function = ir::Function::new();
        function
            .signature
            .params
            .push(ir::AbiParam::new(ir::types::I32));
        function
            .signature
            .returns
            .push(ir::AbiParam::new(ir::types::I32));

        let mut context = FunctionBuilderContext::new();
        let mut builder = FunctionBuilder::new(&mut function, &mut context);
        let entry = builder.create_block();
        builder.append_block_params_for_function_params(entry);
        builder.switch_to_block(entry);
        builder.seal_block(entry);
        let value = builder.block_params(entry)[0];
        builder.ins().return_(&[value]);
        builder.finalize();
        function
    }

    #[test]
    fn emits_caller_selected_module_abi() {
        let config = ModuleConfig::new("portable.compiler", "heap", "execute")
            .with_memory_limits(2, Some(4));
        let wasm = function(&identity_function(), &config).unwrap();
        Validator::new().validate_all(&wasm).unwrap();

        for name in ["portable.compiler", "heap", "execute"] {
            assert!(
                wasm.windows(name.len())
                    .any(|bytes| bytes == name.as_bytes()),
                "configured ABI name {name:?} is absent from the module",
            );
        }
    }

    #[test]
    fn rejects_invalid_wasm32_memory_limits() {
        let config = ModuleConfig::new("portable.compiler", "heap", "execute")
            .with_memory_limits(2, Some(1));

        assert!(matches!(
            function(&identity_function(), &config),
            Err(LowerError::InvalidMemoryLimits {
                minimum: 2,
                maximum: Some(1),
            })
        ));
    }
}
