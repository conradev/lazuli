//! WebAssembly-side dispatch across already lowered PowerPC blocks.

use std::borrow::Cow;
use std::collections::HashSet;
use std::fmt;

use wasm_encoder::{
    BlockType, CodeSection, ConstExpr, ElementSection, Elements, EntityType, ExportKind,
    ExportSection, Function, FunctionSection, ImportSection, Instruction, MemArg, MemoryType,
    Module, RefType, TableSection, TableType, TypeSection, ValType,
};

use crate::{IMPORT_MODULE, MEMORY_IMPORT};

/// Import module used by a linked region's already compiled block functions.
pub const BLOCK_IMPORT_MODULE: &str = "lazuli_blocks";
/// Exported region entry point.
pub const REGION_RUN_EXPORT: &str = "run";

/// One compiled block that may be entered by a linked region.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegionBlock {
    /// Guest program counter at which the block starts.
    pub pc: u32,
    /// Maximum cycles the block can consume before returning.
    pub maximum_cycles: u16,
}

/// An invalid linked-region description.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegionError {
    /// A region must contain at least one block.
    Empty,
    /// The compact dispatcher reserves one 16-bit table index as its missing-PC sentinel.
    TooManyBlocks(usize),
    /// Two imports were supplied for the same guest program counter.
    DuplicatePc(u32),
}

impl fmt::Display for RegionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("region contains no blocks"),
            Self::TooManyBlocks(count) => {
                write!(formatter, "region contains too many blocks ({count})")
            }
            Self::DuplicatePc(pc) => write!(formatter, "region contains duplicate PC 0x{pc:08x}"),
        }
    }
}

impl std::error::Error for RegionError {}

#[derive(Clone, Copy)]
struct IndexedBlock {
    pc: u32,
    maximum_cycles: u16,
    table_index: u16,
}

const MISSING_TABLE_INDEX: u16 = u16::MAX;

/// Emits an expression that returns `(maximum_cycles << 16) | table_index` for `PC`, or the
/// reserved missing-table index when the PC is outside the region. The input is sorted by the
/// unsigned guest PC, so the generated decision tree does O(log n) comparisons instead of
/// scanning every block on every dispatch.
fn emit_dispatch_target(body: &mut Function, blocks: &[IndexedBlock], pc_local: u32) {
    if blocks.len() == 1 {
        let block = blocks[0];
        let packed = u32::from(block.maximum_cycles) << 16 | u32::from(block.table_index);
        body.instruction(&Instruction::LocalGet(pc_local));
        body.instruction(&Instruction::I32Const(block.pc as i32));
        body.instruction(&Instruction::I32Eq);
        body.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
        body.instruction(&Instruction::I32Const(packed as i32));
        body.instruction(&Instruction::Else);
        body.instruction(&Instruction::I32Const(i32::from(MISSING_TABLE_INDEX)));
        body.instruction(&Instruction::End);
        return;
    }

    let middle = blocks.len() / 2;
    body.instruction(&Instruction::LocalGet(pc_local));
    body.instruction(&Instruction::I32Const(blocks[middle].pc as i32));
    body.instruction(&Instruction::I32LtU);
    body.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
    emit_dispatch_target(body, &blocks[..middle], pc_local);
    body.instruction(&Instruction::Else);
    emit_dispatch_target(body, &blocks[middle..], pc_local);
    body.instruction(&Instruction::End);
}

/// Links compiled block functions behind a budgeted WebAssembly-side PC dispatcher.
///
/// The exported function has this signature:
///
/// ```text
/// run(ctx, cpu, fastmem, pc_offset, control, cycle_budget, block_budget)
///     -> (instructions, cycles, blocks)
/// ```
///
/// A block is entered only when its maximum cycle cost fits in the remaining budget. Execution
/// returns when the next PC is outside the region or either budget is exhausted.
pub fn link_region(blocks: &[RegionBlock]) -> Result<Vec<u8>, RegionError> {
    if blocks.is_empty() {
        return Err(RegionError::Empty);
    }
    if blocks.len() > usize::from(u16::MAX) {
        return Err(RegionError::TooManyBlocks(blocks.len()));
    }
    let mut pcs = HashSet::with_capacity(blocks.len());
    for block in blocks {
        if !pcs.insert(block.pc) {
            return Err(RegionError::DuplicatePc(block.pc));
        }
    }
    let mut indexed_blocks = blocks
        .iter()
        .enumerate()
        .map(|(index, block)| IndexedBlock {
            pc: block.pc,
            maximum_cycles: block.maximum_cycles,
            table_index: index as u16,
        })
        .collect::<Vec<_>>();
    indexed_blocks.sort_unstable_by_key(|block| block.pc);

    let mut types = TypeSection::new();
    types
        .ty()
        .function([ValType::I32, ValType::I32, ValType::I32], [ValType::I32]);
    types.ty().function(
        [
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
            ValType::I32,
        ],
        [ValType::I32, ValType::I32, ValType::I32],
    );

    let mut imports = ImportSection::new();
    imports.import(
        IMPORT_MODULE,
        MEMORY_IMPORT,
        EntityType::Memory(MemoryType {
            minimum: 1,
            maximum: None,
            memory64: false,
            shared: false,
            page_size_log2: None,
        }),
    );
    for index in 0..blocks.len() {
        imports.import(
            BLOCK_IMPORT_MODULE,
            &format!("b{index}"),
            EntityType::Function(0),
        );
    }

    let mut functions = FunctionSection::new();
    functions.function(1);

    let mut tables = TableSection::new();
    tables.table(TableType {
        element_type: RefType::FUNCREF,
        table64: false,
        minimum: blocks.len() as u64,
        maximum: Some(blocks.len() as u64),
        shared: false,
    });

    let mut exports = ExportSection::new();
    exports.export(REGION_RUN_EXPORT, ExportKind::Func, blocks.len() as u32);

    let function_indices = (0..blocks.len() as u32).collect::<Vec<_>>();
    let mut elements = ElementSection::new();
    elements.active(
        None,
        &ConstExpr::i32_const(0),
        Elements::Functions(Cow::Owned(function_indices)),
    );

    // Parameters 0..=6 are ctx, cpu, fastmem, pc_offset, control, cycle_budget, and block_budget.
    // The two control words are the current region-cycle offset and a hook-requested exit flag.
    // Locals 7..=12 are result, instructions, cycles, blocks, pc, and packed dispatch target.
    const RESULT: u32 = 7;
    const INSTRUCTIONS: u32 = 8;
    const CYCLES: u32 = 9;
    const BLOCKS: u32 = 10;
    const PC: u32 = 11;
    const TARGET: u32 = 12;
    let mut body = Function::new([(6, ValType::I32)]);

    body.instruction(&Instruction::Block(BlockType::Empty));
    body.instruction(&Instruction::Loop(BlockType::Empty));

    body.instruction(&Instruction::LocalGet(BLOCKS));
    body.instruction(&Instruction::LocalGet(6));
    body.instruction(&Instruction::I32GeU);
    body.instruction(&Instruction::BrIf(1));

    body.instruction(&Instruction::LocalGet(1));
    body.instruction(&Instruction::LocalGet(3));
    body.instruction(&Instruction::I32Add);
    body.instruction(&Instruction::I32Load(MemArg {
        offset: 0,
        align: 2,
        memory_index: 0,
    }));
    body.instruction(&Instruction::LocalSet(PC));

    emit_dispatch_target(&mut body, &indexed_blocks, PC);
    body.instruction(&Instruction::LocalSet(TARGET));

    body.instruction(&Instruction::LocalGet(TARGET));
    body.instruction(&Instruction::I32Const(i32::from(MISSING_TABLE_INDEX)));
    body.instruction(&Instruction::I32And);
    body.instruction(&Instruction::I32Const(i32::from(MISSING_TABLE_INDEX)));
    body.instruction(&Instruction::I32Eq);
    body.instruction(&Instruction::BrIf(1));

    body.instruction(&Instruction::LocalGet(CYCLES));
    body.instruction(&Instruction::LocalGet(TARGET));
    body.instruction(&Instruction::I32Const(16));
    body.instruction(&Instruction::I32ShrU);
    body.instruction(&Instruction::I32Add);
    body.instruction(&Instruction::LocalGet(5));
    body.instruction(&Instruction::I32GtU);
    body.instruction(&Instruction::BrIf(1));

    body.instruction(&Instruction::LocalGet(4));
    body.instruction(&Instruction::LocalGet(CYCLES));
    body.instruction(&Instruction::I32Store(MemArg {
        offset: 0,
        align: 2,
        memory_index: 0,
    }));

    body.instruction(&Instruction::LocalGet(0));
    body.instruction(&Instruction::LocalGet(1));
    body.instruction(&Instruction::LocalGet(2));
    body.instruction(&Instruction::LocalGet(TARGET));
    body.instruction(&Instruction::I32Const(i32::from(MISSING_TABLE_INDEX)));
    body.instruction(&Instruction::I32And);
    body.instruction(&Instruction::CallIndirect {
        type_index: 0,
        table_index: 0,
    });
    body.instruction(&Instruction::LocalSet(RESULT));

    body.instruction(&Instruction::LocalGet(INSTRUCTIONS));
    body.instruction(&Instruction::LocalGet(RESULT));
    body.instruction(&Instruction::I32Const(0xffff));
    body.instruction(&Instruction::I32And);
    body.instruction(&Instruction::I32Add);
    body.instruction(&Instruction::LocalSet(INSTRUCTIONS));

    body.instruction(&Instruction::LocalGet(CYCLES));
    body.instruction(&Instruction::LocalGet(RESULT));
    body.instruction(&Instruction::I32Const(16));
    body.instruction(&Instruction::I32ShrU);
    body.instruction(&Instruction::I32Add);
    body.instruction(&Instruction::LocalSet(CYCLES));

    body.instruction(&Instruction::LocalGet(BLOCKS));
    body.instruction(&Instruction::I32Const(1));
    body.instruction(&Instruction::I32Add);
    body.instruction(&Instruction::LocalSet(BLOCKS));

    body.instruction(&Instruction::LocalGet(4));
    body.instruction(&Instruction::I32Load(MemArg {
        offset: 4,
        align: 2,
        memory_index: 0,
    }));
    body.instruction(&Instruction::BrIf(1));
    body.instruction(&Instruction::Br(0));
    body.instruction(&Instruction::End);
    body.instruction(&Instruction::End);
    body.instruction(&Instruction::LocalGet(INSTRUCTIONS));
    body.instruction(&Instruction::LocalGet(CYCLES));
    body.instruction(&Instruction::LocalGet(BLOCKS));
    body.instruction(&Instruction::End);

    let mut code = CodeSection::new();
    code.function(&body);

    let mut module = Module::new();
    module.section(&types);
    module.section(&imports);
    module.section(&functions);
    module.section(&tables);
    module.section(&exports);
    module.section(&elements);
    module.section(&code);
    Ok(module.finish())
}
