//! WebAssembly-side staging for the ordered Gekko GX FIFO write hooks.

use wasm_encoder::{
    BlockType, CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection,
    ImportSection, Instruction, MemArg, MemoryType, Module, TypeSection, ValType,
};

use crate::{IMPORT_MODULE, MEMORY_IMPORT};

/// Import module containing the existing JavaScript slow-memory hooks.
pub const SLOW_HOOK_IMPORT_MODULE: &str = "lazuli_slow_hooks";
/// Import module containing the emergency staging-buffer drain callback.
pub const FIFO_RUNTIME_IMPORT_MODULE: &str = "lazuli_fifo";

const WRITE_I8: &str = "user_0_7";
const WRITE_I16: &str = "user_0_8";
const WRITE_I32: &str = "user_0_9";
const WRITE_I64: &str = "user_0_10";
const WRITE_QUANTIZED: &str = "user_0_12";
const FIFO_BASE: u32 = 0xcc00_8000;
const FIFO_BYTES: i32 = 0x20;

fn memarg() -> MemArg {
    MemArg {
        offset: 0,
        align: 0,
        memory_index: 0,
    }
}

fn absolute_load(body: &mut Function, address: u32) {
    body.instruction(&Instruction::I32Const(address as i32));
    body.instruction(&Instruction::I32Load(memarg()));
}

fn emit_data_address(body: &mut Function, data_address: u32, count_local: u32, offset: i32) {
    body.instruction(&Instruction::I32Const(data_address as i32));
    body.instruction(&Instruction::LocalGet(count_local));
    body.instruction(&Instruction::I32Add);
    if offset != 0 {
        body.instruction(&Instruction::I32Const(offset));
        body.instruction(&Instruction::I32Add);
    }
}

fn emit_i32_byte(
    body: &mut Function,
    data_address: u32,
    count_local: u32,
    offset: i32,
    shift: i32,
) {
    emit_data_address(body, data_address, count_local, offset);
    body.instruction(&Instruction::LocalGet(0));
    if shift != 0 {
        body.instruction(&Instruction::I32Const(shift));
        body.instruction(&Instruction::I32ShrU);
    }
    body.instruction(&Instruction::I32Store8(memarg()));
}

fn emit_i64_byte(
    body: &mut Function,
    data_address: u32,
    count_local: u32,
    offset: i32,
    shift: i64,
) {
    emit_data_address(body, data_address, count_local, offset);
    body.instruction(&Instruction::LocalGet(0));
    if shift != 0 {
        body.instruction(&Instruction::I64Const(shift));
        body.instruction(&Instruction::I64ShrU);
    }
    body.instruction(&Instruction::I32WrapI64);
    body.instruction(&Instruction::I32Store8(memarg()));
}

fn emit_fifo_test(body: &mut Function, address_local: u32) {
    body.instruction(&Instruction::LocalGet(address_local));
    body.instruction(&Instruction::I32Const(FIFO_BASE as i32));
    body.instruction(&Instruction::I32Sub);
    body.instruction(&Instruction::I32Const(FIFO_BYTES));
    body.instruction(&Instruction::I32LtU);
}

fn emit_clamped_unsigned(body: &mut Function, scaled_local: u32, stored_local: u32, maximum: i32) {
    body.instruction(&Instruction::LocalGet(scaled_local));
    body.instruction(&Instruction::I32TruncSatF64U);
    body.instruction(&Instruction::LocalSet(stored_local));
    body.instruction(&Instruction::I32Const(maximum));
    body.instruction(&Instruction::LocalGet(stored_local));
    body.instruction(&Instruction::LocalGet(stored_local));
    body.instruction(&Instruction::I32Const(maximum));
    body.instruction(&Instruction::I32GtU);
    body.instruction(&Instruction::Select);
}

fn emit_clamped_signed(
    body: &mut Function,
    scaled_local: u32,
    stored_local: u32,
    minimum: i32,
    maximum: i32,
) {
    body.instruction(&Instruction::LocalGet(scaled_local));
    body.instruction(&Instruction::I32TruncSatF64S);
    body.instruction(&Instruction::LocalSet(stored_local));
    body.instruction(&Instruction::I32Const(minimum));
    body.instruction(&Instruction::LocalGet(stored_local));
    body.instruction(&Instruction::LocalGet(stored_local));
    body.instruction(&Instruction::I32Const(minimum));
    body.instruction(&Instruction::I32LtS);
    body.instruction(&Instruction::Select);
    body.instruction(&Instruction::LocalSet(stored_local));
    body.instruction(&Instruction::I32Const(maximum));
    body.instruction(&Instruction::LocalGet(stored_local));
    body.instruction(&Instruction::LocalGet(stored_local));
    body.instruction(&Instruction::I32Const(maximum));
    body.instruction(&Instruction::I32GtS);
    body.instruction(&Instruction::Select);
}

/// Builds a small hook module that batches GX FIFO bytes in imported linear memory.
///
/// The four words at `metadata_address` hold pending bytes, staged stores, staged quantized
/// stores, and emergency drains. `data_address..data_address + capacity` is the bounded byte
/// staging area. Non-FIFO stores retain the original JavaScript slow-hook behavior.
pub fn hook_runtime(metadata_address: u32, data_address: u32, capacity: u32) -> Vec<u8> {
    assert!(capacity >= 8, "GX FIFO staging capacity is too small");
    assert!(
        data_address.checked_add(capacity).is_some(),
        "GX FIFO staging range wraps"
    );

    let count_address = metadata_address;
    let stores_address = metadata_address + 4;
    let quantized_stores_address = metadata_address + 8;
    let emergency_drains_address = metadata_address + 12;

    let mut types = TypeSection::new();
    // 0: integer stores, 1: i64 stores, 2: quantized stores, 3: flush,
    // 4: reserve, 5: commit, 6: append i32, 7: append i64.
    types
        .ty()
        .function([ValType::I32, ValType::I32, ValType::I32], [ValType::I32]);
    types
        .ty()
        .function([ValType::I32, ValType::I32, ValType::I64], [ValType::I32]);
    types.ty().function(
        [ValType::I32, ValType::I32, ValType::I32, ValType::F64],
        [ValType::I32],
    );
    types.ty().function([], []);
    types.ty().function([ValType::I32], [ValType::I32]);
    types.ty().function([ValType::I32, ValType::I32], []);
    types.ty().function([ValType::I32, ValType::I32], []);
    types.ty().function([ValType::I64, ValType::I32], []);

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
    for name in [WRITE_I8, WRITE_I16, WRITE_I32] {
        imports.import(SLOW_HOOK_IMPORT_MODULE, name, EntityType::Function(0));
    }
    imports.import(SLOW_HOOK_IMPORT_MODULE, WRITE_I64, EntityType::Function(1));
    imports.import(
        SLOW_HOOK_IMPORT_MODULE,
        WRITE_QUANTIZED,
        EntityType::Function(2),
    );
    imports.import(FIFO_RUNTIME_IMPORT_MODULE, "flush", EntityType::Function(3));

    let mut functions = FunctionSection::new();
    for type_index in [4, 5, 6, 6, 6, 7, 0, 0, 0, 1, 2] {
        functions.function(type_index);
    }

    // Function indices: imports 0..=5, then reserve=6, commit=7, append8=8,
    // append16=9, append32=10, append64=11, and wrappers=12..=16.
    const FLUSH: u32 = 5;
    const RESERVE: u32 = 6;
    const COMMIT: u32 = 7;
    const APPEND8: u32 = 8;
    const APPEND16: u32 = 9;
    const APPEND32: u32 = 10;
    const APPEND64: u32 = 11;

    let mut exports = ExportSection::new();
    exports.export(WRITE_I8, ExportKind::Func, 12);
    exports.export(WRITE_I16, ExportKind::Func, 13);
    exports.export(WRITE_I32, ExportKind::Func, 14);
    exports.export(WRITE_I64, ExportKind::Func, 15);
    exports.export(WRITE_QUANTIZED, ExportKind::Func, 16);

    let mut code = CodeSection::new();

    // reserve(size) -> old pending byte count, draining only on bounded overflow.
    let mut reserve = Function::new([(1, ValType::I32)]);
    absolute_load(&mut reserve, count_address);
    reserve.instruction(&Instruction::LocalTee(1));
    reserve.instruction(&Instruction::LocalGet(0));
    reserve.instruction(&Instruction::I32Add);
    reserve.instruction(&Instruction::I32Const(capacity as i32));
    reserve.instruction(&Instruction::I32GtU);
    reserve.instruction(&Instruction::If(BlockType::Empty));
    reserve.instruction(&Instruction::Call(FLUSH));
    reserve.instruction(&Instruction::I32Const(emergency_drains_address as i32));
    absolute_load(&mut reserve, emergency_drains_address);
    reserve.instruction(&Instruction::I32Const(1));
    reserve.instruction(&Instruction::I32Add);
    reserve.instruction(&Instruction::I32Store(memarg()));
    absolute_load(&mut reserve, count_address);
    reserve.instruction(&Instruction::LocalSet(1));
    reserve.instruction(&Instruction::End);
    reserve.instruction(&Instruction::LocalGet(1));
    reserve.instruction(&Instruction::End);
    code.function(&reserve);

    // commit(size, quantized): advance the byte count and diagnostic store counters.
    let mut commit = Function::new([]);
    commit.instruction(&Instruction::I32Const(count_address as i32));
    absolute_load(&mut commit, count_address);
    commit.instruction(&Instruction::LocalGet(0));
    commit.instruction(&Instruction::I32Add);
    commit.instruction(&Instruction::I32Store(memarg()));
    commit.instruction(&Instruction::I32Const(stores_address as i32));
    absolute_load(&mut commit, stores_address);
    commit.instruction(&Instruction::I32Const(1));
    commit.instruction(&Instruction::I32Add);
    commit.instruction(&Instruction::I32Store(memarg()));
    commit.instruction(&Instruction::LocalGet(1));
    commit.instruction(&Instruction::If(BlockType::Empty));
    commit.instruction(&Instruction::I32Const(quantized_stores_address as i32));
    absolute_load(&mut commit, quantized_stores_address);
    commit.instruction(&Instruction::I32Const(1));
    commit.instruction(&Instruction::I32Add);
    commit.instruction(&Instruction::I32Store(memarg()));
    commit.instruction(&Instruction::End);
    commit.instruction(&Instruction::End);
    code.function(&commit);

    for (size, shifts) in [(1_i32, vec![0]), (2, vec![8, 0]), (4, vec![24, 16, 8, 0])] {
        let mut append = Function::new([(1, ValType::I32)]);
        append.instruction(&Instruction::I32Const(size));
        append.instruction(&Instruction::Call(RESERVE));
        append.instruction(&Instruction::LocalSet(2));
        for (offset, shift) in shifts.into_iter().enumerate() {
            emit_i32_byte(&mut append, data_address, 2, offset as i32, shift);
        }
        append.instruction(&Instruction::I32Const(size));
        append.instruction(&Instruction::LocalGet(1));
        append.instruction(&Instruction::Call(COMMIT));
        append.instruction(&Instruction::End);
        code.function(&append);
    }

    let mut append64 = Function::new([(1, ValType::I32)]);
    append64.instruction(&Instruction::I32Const(8));
    append64.instruction(&Instruction::Call(RESERVE));
    append64.instruction(&Instruction::LocalSet(2));
    for (offset, shift) in [56_i64, 48, 40, 32, 24, 16, 8, 0].into_iter().enumerate() {
        emit_i64_byte(&mut append64, data_address, 2, offset as i32, shift);
    }
    append64.instruction(&Instruction::I32Const(8));
    append64.instruction(&Instruction::LocalGet(1));
    append64.instruction(&Instruction::Call(COMMIT));
    append64.instruction(&Instruction::End);
    code.function(&append64);

    for (slow_index, append_index) in [(0_u32, APPEND8), (1, APPEND16), (2, APPEND32)] {
        let mut wrapper = Function::new([]);
        emit_fifo_test(&mut wrapper, 1);
        wrapper.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
        wrapper.instruction(&Instruction::LocalGet(2));
        wrapper.instruction(&Instruction::I32Const(0));
        wrapper.instruction(&Instruction::Call(append_index));
        wrapper.instruction(&Instruction::I32Const(1));
        wrapper.instruction(&Instruction::Else);
        wrapper.instruction(&Instruction::LocalGet(0));
        wrapper.instruction(&Instruction::LocalGet(1));
        wrapper.instruction(&Instruction::LocalGet(2));
        wrapper.instruction(&Instruction::Call(slow_index));
        wrapper.instruction(&Instruction::End);
        wrapper.instruction(&Instruction::End);
        code.function(&wrapper);
    }

    let mut write64 = Function::new([]);
    emit_fifo_test(&mut write64, 1);
    write64.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
    write64.instruction(&Instruction::LocalGet(2));
    write64.instruction(&Instruction::I32Const(0));
    write64.instruction(&Instruction::Call(APPEND64));
    write64.instruction(&Instruction::I32Const(1));
    write64.instruction(&Instruction::Else);
    write64.instruction(&Instruction::LocalGet(0));
    write64.instruction(&Instruction::LocalGet(1));
    write64.instruction(&Instruction::LocalGet(2));
    write64.instruction(&Instruction::Call(3));
    write64.instruction(&Instruction::End);
    write64.instruction(&Instruction::End);
    code.function(&write64);

    // write_quantized(ctx, address, gqr, value): perform the same saturating conversion as
    // ppcjit's mapped fast path, then append the resulting big-endian bytes.
    // Locals 4..=7 are type, signed scale, scaled f64, and converted i32.
    let mut quantized = Function::new([(2, ValType::I32), (1, ValType::F64), (1, ValType::I32)]);
    emit_fifo_test(&mut quantized, 1);
    quantized.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
    quantized.instruction(&Instruction::LocalGet(2));
    quantized.instruction(&Instruction::I32Const(7));
    quantized.instruction(&Instruction::I32And);
    quantized.instruction(&Instruction::LocalSet(4));
    quantized.instruction(&Instruction::LocalGet(2));
    quantized.instruction(&Instruction::I32Const(8));
    quantized.instruction(&Instruction::I32ShrU);
    quantized.instruction(&Instruction::I32Const(26));
    quantized.instruction(&Instruction::I32Shl);
    quantized.instruction(&Instruction::I32Const(26));
    quantized.instruction(&Instruction::I32ShrS);
    quantized.instruction(&Instruction::LocalSet(5));
    quantized.instruction(&Instruction::LocalGet(3));
    quantized.instruction(&Instruction::I32Const(1023));
    quantized.instruction(&Instruction::LocalGet(5));
    quantized.instruction(&Instruction::I32Add);
    quantized.instruction(&Instruction::I64ExtendI32S);
    quantized.instruction(&Instruction::I64Const(52));
    quantized.instruction(&Instruction::I64Shl);
    quantized.instruction(&Instruction::F64ReinterpretI64);
    quantized.instruction(&Instruction::F64Mul);
    quantized.instruction(&Instruction::LocalSet(6));

    quantized.instruction(&Instruction::LocalGet(4));
    quantized.instruction(&Instruction::I32Eqz);
    quantized.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
    quantized.instruction(&Instruction::LocalGet(3));
    quantized.instruction(&Instruction::F32DemoteF64);
    quantized.instruction(&Instruction::I32ReinterpretF32);
    quantized.instruction(&Instruction::I32Const(1));
    quantized.instruction(&Instruction::Call(APPEND32));
    quantized.instruction(&Instruction::I32Const(4));
    quantized.instruction(&Instruction::Else);

    quantized.instruction(&Instruction::LocalGet(4));
    quantized.instruction(&Instruction::I32Const(4));
    quantized.instruction(&Instruction::I32Eq);
    quantized.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
    emit_clamped_unsigned(&mut quantized, 6, 7, 255);
    quantized.instruction(&Instruction::I32Const(1));
    quantized.instruction(&Instruction::Call(APPEND8));
    quantized.instruction(&Instruction::I32Const(1));
    quantized.instruction(&Instruction::Else);

    quantized.instruction(&Instruction::LocalGet(4));
    quantized.instruction(&Instruction::I32Const(5));
    quantized.instruction(&Instruction::I32Eq);
    quantized.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
    emit_clamped_unsigned(&mut quantized, 6, 7, 65_535);
    quantized.instruction(&Instruction::I32Const(1));
    quantized.instruction(&Instruction::Call(APPEND16));
    quantized.instruction(&Instruction::I32Const(2));
    quantized.instruction(&Instruction::Else);

    quantized.instruction(&Instruction::LocalGet(4));
    quantized.instruction(&Instruction::I32Const(6));
    quantized.instruction(&Instruction::I32Eq);
    quantized.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
    emit_clamped_signed(&mut quantized, 6, 7, -128, 127);
    quantized.instruction(&Instruction::I32Const(1));
    quantized.instruction(&Instruction::Call(APPEND8));
    quantized.instruction(&Instruction::I32Const(1));
    quantized.instruction(&Instruction::Else);

    quantized.instruction(&Instruction::LocalGet(4));
    quantized.instruction(&Instruction::I32Const(7));
    quantized.instruction(&Instruction::I32Eq);
    quantized.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
    emit_clamped_signed(&mut quantized, 6, 7, -32_768, 32_767);
    quantized.instruction(&Instruction::I32Const(1));
    quantized.instruction(&Instruction::Call(APPEND16));
    quantized.instruction(&Instruction::I32Const(2));
    quantized.instruction(&Instruction::Else);
    quantized.instruction(&Instruction::I32Const(0));
    quantized.instruction(&Instruction::End);
    quantized.instruction(&Instruction::End);
    quantized.instruction(&Instruction::End);
    quantized.instruction(&Instruction::End);
    quantized.instruction(&Instruction::End);
    quantized.instruction(&Instruction::Else);
    quantized.instruction(&Instruction::LocalGet(0));
    quantized.instruction(&Instruction::LocalGet(1));
    quantized.instruction(&Instruction::LocalGet(2));
    quantized.instruction(&Instruction::LocalGet(3));
    quantized.instruction(&Instruction::Call(4));
    quantized.instruction(&Instruction::End);
    quantized.instruction(&Instruction::End);
    code.function(&quantized);

    let mut module = Module::new();
    module.section(&types);
    module.section(&imports);
    module.section(&functions);
    module.section(&exports);
    module.section(&code);
    module.finish()
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use wasmparser::Validator;

    use super::hook_runtime;

    #[test]
    fn generated_hook_runtime_is_valid_wasm() {
        let module = hook_runtime(0x1000, 0x1100, 0x1000);
        Validator::new().validate_all(&module).unwrap();
    }

    #[test]
    fn generated_hook_runtime_preserves_fifo_byte_order_and_quantization() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
            return;
        }

        let module = hook_runtime(0x100, 0x200, 0x100);
        let module = module
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let script = r#"
const wasm = Buffer.from(process.argv[1], "hex");
const memory = new WebAssembly.Memory({ initial: 1 });
const view = new DataView(memory.buffer);
let slowCalls = 0;
const slow = {
  user_0_7() { slowCalls += 1; return 1; },
  user_0_8() { slowCalls += 1; return 1; },
  user_0_9() { slowCalls += 1; return 1; },
  user_0_10() { slowCalls += 1; return 1; },
  user_0_12() { slowCalls += 1; return 4; },
};
const { instance } = await WebAssembly.instantiate(wasm, {
  lazuli: { memory },
  lazuli_slow_hooks: slow,
  lazuli_fifo: { flush() { throw new Error("unexpected overflow flush"); } },
});
const fifo = 0xcc008000;
instance.exports.user_0_7(0, fifo, 0x12);
instance.exports.user_0_8(0, fifo, 0x3456);
instance.exports.user_0_9(0, fifo, 0x789abcde);
instance.exports.user_0_10(0, fifo, 0x0123456789abcdefn);
instance.exports.user_0_12(0, fifo, 0, 1.5);
instance.exports.user_0_12(0, fifo, 4, 300);
instance.exports.user_0_12(0, fifo, 5, 0x1234);
instance.exports.user_0_12(0, fifo, 6, -5);
instance.exports.user_0_12(0, fifo, 7, -2);
const count = view.getUint32(0x100, true);
const stores = view.getUint32(0x104, true);
const quantized = view.getUint32(0x108, true);
const bytes = Buffer.from(new Uint8Array(memory.buffer, 0x200, count)).toString("hex");
const expected = "123456789abcde0123456789abcdef3fc00000ff1234fbfffe";
if (bytes !== expected) throw new Error("bad FIFO bytes: " + bytes);
if (count !== 25 || stores !== 9 || quantized !== 5) {
  throw new Error(`bad counters: ${count}/${stores}/${quantized}`);
}
instance.exports.user_0_9(0, 0x80000000, 0xfeedbeef);
if (slowCalls !== 1) throw new Error("non-FIFO store did not use slow hook");
"#;
        let output = Command::new("node")
            .args(["--input-type=module", "--eval", script, &module])
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
    fn generated_hook_runtime_flushes_only_on_overflow_and_preserves_repeated_drains() {
        if Command::new("node").arg("--version").output().is_err() {
            eprintln!("node is unavailable; skipping WebAssembly runtime smoke test");
            return;
        }

        let module = hook_runtime(0x100, 0x200, 8);
        let module = module
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let script = r#"
const wasm = Buffer.from(process.argv[1], "hex");
const memory = new WebAssembly.Memory({ initial: 1 });
const view = new DataView(memory.buffer);
const metadata = 0x100;
const data = 0x200;
const drains = [];
function flush() {
  const count = view.getUint32(metadata, true);
  const stores = view.getUint32(metadata + 4, true);
  const quantized = view.getUint32(metadata + 8, true);
  drains.push({
    bytes: Buffer.from(new Uint8Array(memory.buffer, data, count)).toString("hex"),
    count,
    stores,
    quantized,
  });
  view.setUint32(metadata, 0, true);
  view.setUint32(metadata + 4, 0, true);
  view.setUint32(metadata + 8, 0, true);
}
const unexpectedSlowHook = () => { throw new Error("unexpected slow hook"); };
const slow = {
  user_0_7: unexpectedSlowHook,
  user_0_8: unexpectedSlowHook,
  user_0_9: unexpectedSlowHook,
  user_0_10: unexpectedSlowHook,
  user_0_12: unexpectedSlowHook,
};
const { instance } = await WebAssembly.instantiate(wasm, {
  lazuli: { memory },
  lazuli_slow_hooks: slow,
  lazuli_fifo: { flush },
});
const fifo = 0xcc008000;

instance.exports.user_0_9(0, fifo, 0x01020304);
instance.exports.user_0_9(0, fifo, 0x05060708);
if (drains.length !== 0) throw new Error("exact-capacity writes flushed");
if (
  view.getUint32(metadata, true) !== 8
  || view.getUint32(metadata + 4, true) !== 2
  || view.getUint32(metadata + 8, true) !== 0
  || view.getUint32(metadata + 12, true) !== 0
) {
  throw new Error("bad exact-capacity metadata");
}

instance.exports.user_0_7(0, fifo, 0x09);
if (drains.length !== 1 || drains[0].bytes !== "0102030405060708") {
  throw new Error("capacity-plus-one did not flush synchronously");
}
if (
  view.getUint32(metadata, true) !== 1
  || view.getUint8(data) !== 0x09
  || view.getUint32(metadata + 4, true) !== 1
  || view.getUint32(metadata + 12, true) !== 1
) {
  throw new Error("bad metadata after first overflow");
}

instance.exports.user_0_10(0, fifo, 0x0a0b0c0d0e0f1011n);
instance.exports.user_0_12(0, fifo, 4, 0x12);
for (let byte = 0x13; byte <= 0x19; byte += 1) {
  instance.exports.user_0_7(0, fifo, byte);
}
instance.exports.user_0_8(0, fifo, 0x1a1b);
if (drains.length !== 4) throw new Error(`expected four emergency drains, got ${drains.length}`);
if (view.getUint32(metadata + 12, true) !== 4) {
  throw new Error("emergency drain metadata did not accumulate");
}
flush();

const expectedDrains = [
  { bytes: "0102030405060708", count: 8, stores: 2, quantized: 0 },
  { bytes: "09", count: 1, stores: 1, quantized: 0 },
  { bytes: "0a0b0c0d0e0f1011", count: 8, stores: 1, quantized: 0 },
  { bytes: "1213141516171819", count: 8, stores: 8, quantized: 1 },
  { bytes: "1a1b", count: 2, stores: 1, quantized: 0 },
];
if (JSON.stringify(drains) !== JSON.stringify(expectedDrains)) {
  throw new Error(`bad drain sequence: ${JSON.stringify(drains)}`);
}
const bytes = drains.map(drain => drain.bytes).join("");
const expectedBytes = Array.from(
  { length: 0x1b },
  (_unused, index) => (index + 1).toString(16).padStart(2, "0"),
).join("");
if (bytes !== expectedBytes) throw new Error(`bad repeated-flush byte order: ${bytes}`);
const totals = drains.reduce((result, drain) => ({
  count: result.count + drain.count,
  stores: result.stores + drain.stores,
  quantized: result.quantized + drain.quantized,
}), { count: 0, stores: 0, quantized: 0 });
if (totals.count !== 27 || totals.stores !== 13 || totals.quantized !== 1) {
  throw new Error(`bad repeated-flush counters: ${JSON.stringify(totals)}`);
}
if (
  view.getUint32(metadata, true) !== 0
  || view.getUint32(metadata + 4, true) !== 0
  || view.getUint32(metadata + 8, true) !== 0
  || view.getUint32(metadata + 12, true) !== 4
) {
  throw new Error("draining reset store metadata or lost emergency drain metadata");
}
"#;
        let output = Command::new("node")
            .args(["--input-type=module", "--eval", script, &module])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "node failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
}
