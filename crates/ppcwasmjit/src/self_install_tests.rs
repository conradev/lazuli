use std::process::Command;

use gekko::Reg;
use gekko::disasm::{Extensions, Ins};
use lazuli_abi::{ResidentBlockInstallIdentity, ResidentInstallStatus};
use wasm_encoder::{
    BlockType, CodeSection, ConstExpr, EntityType, ExportKind, ExportSection, Function,
    FunctionSection, GlobalSection, GlobalType, HeapType, ImportSection, Instruction, Module,
    RefType, TableType, TypeSection, ValType,
};
use wasmparser::Validator;

use super::{
    DispatchReason, DispatcherConfig, Jit, RESIDENT_INSTALL_BEGIN_IMPORT,
    RESIDENT_INSTALL_COMMIT_IMPORT, build_resident_dispatcher,
};

fn instruction(word: u32) -> Ins {
    Ins::new(word, Extensions::gekko_broadway())
}

fn identity(
    request_id: u32,
    table_slot: u32,
    nonce: u64,
    token: u64,
) -> ResidentBlockInstallIdentity {
    ResidentBlockInstallIdentity {
        request_id,
        table_slot,
        slot_nonce_lo: nonce as u32,
        slot_nonce_hi: (nonce >> 32) as u32,
        address_space_generation_lo: 1,
        address_space_generation_hi: 0,
        install_token_lo: token as u32,
        install_token_hi: (token >> 32) as u32,
    }
}

fn identity_words(identity: ResidentBlockInstallIdentity) -> [u32; 8] {
    [
        identity.request_id,
        identity.table_slot,
        identity.slot_nonce_lo,
        identity.slot_nonce_hi,
        identity.address_space_generation_lo,
        identity.address_space_generation_hi,
        identity.install_token_lo,
        identity.install_token_hi,
    ]
}

fn emit_identity_match(body: &mut Function, selector: u32, identity: ResidentBlockInstallIdentity) {
    for (index, word) in identity_words(identity).into_iter().enumerate() {
        body.instruction(&Instruction::LocalGet(index as u32));
        body.instruction(&Instruction::I32Const(word as i32));
        body.instruction(&Instruction::I32Eq);
        if index != 0 {
            body.instruction(&Instruction::I32And);
        }
    }
    body.instruction(&Instruction::GlobalGet(0));
    body.instruction(&Instruction::I32Const(selector as i32));
    body.instruction(&Instruction::I32Eq);
    body.instruction(&Instruction::I32And);
}

fn authority_module(
    first: ResidentBlockInstallIdentity,
    second: ResidentBlockInstallIdentity,
    trapped: ResidentBlockInstallIdentity,
) -> Vec<u8> {
    let mut types = TypeSection::new();
    types.ty().function([ValType::I32; 8], [ValType::I32]);
    types.ty().function([], []);
    types
        .ty()
        .function([ValType::I32, ValType::I32], [ValType::I32]);

    let mut functions = FunctionSection::new();
    functions.function(0); // begin
    functions.function(0); // commit
    functions.function(1); // activate second
    functions.function(1); // activate trapped
    functions.function(2); // dependency validator

    let mut globals = GlobalSection::new();
    globals.global(
        GlobalType {
            val_type: ValType::I32,
            mutable: true,
            shared: false,
        },
        &ConstExpr::i32_const(0),
    );
    globals.global(
        GlobalType {
            val_type: ValType::I32,
            mutable: true,
            shared: false,
        },
        &ConstExpr::i32_const(0),
    );

    let mut exports = ExportSection::new();
    exports.export(RESIDENT_INSTALL_BEGIN_IMPORT, ExportKind::Func, 0);
    exports.export(RESIDENT_INSTALL_COMMIT_IMPORT, ExportKind::Func, 1);
    exports.export("activate_second", ExportKind::Func, 2);
    exports.export("activate_trapped", ExportKind::Func, 3);
    exports.export("validate_instruction_page_dependency", ExportKind::Func, 4);
    exports.export("commit_count", ExportKind::Global, 1);

    let mut code = CodeSection::new();
    for (success, increment_commits) in [
        (ResidentInstallStatus::Authorized, false),
        (ResidentInstallStatus::Committed, true),
    ] {
        let mut body = Function::new([]);
        emit_identity_match(&mut body, 0, first);
        emit_identity_match(&mut body, 1, second);
        body.instruction(&Instruction::I32Or);
        emit_identity_match(&mut body, 2, trapped);
        body.instruction(&Instruction::I32Or);
        body.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
        if increment_commits {
            body.instruction(&Instruction::GlobalGet(1));
            body.instruction(&Instruction::I32Const(1));
            body.instruction(&Instruction::I32Add);
            body.instruction(&Instruction::GlobalSet(1));
        }
        body.instruction(&Instruction::I32Const(success as i32));
        body.instruction(&Instruction::Else);
        body.instruction(&Instruction::I32Const(
            ResidentInstallStatus::IdentityMismatch as i32,
        ));
        body.instruction(&Instruction::End);
        body.instruction(&Instruction::End);
        code.function(&body);
    }

    let mut activate_second = Function::new([]);
    activate_second.instruction(&Instruction::I32Const(1));
    activate_second.instruction(&Instruction::GlobalSet(0));
    activate_second.instruction(&Instruction::End);
    code.function(&activate_second);

    let mut activate_trapped = Function::new([]);
    activate_trapped.instruction(&Instruction::I32Const(2));
    activate_trapped.instruction(&Instruction::GlobalSet(0));
    activate_trapped.instruction(&Instruction::End);
    code.function(&activate_trapped);

    let mut validate = Function::new([]);
    validate.instruction(&Instruction::I32Const(1));
    validate.instruction(&Instruction::End);
    code.function(&validate);

    let mut module = Module::new();
    module.section(&types);
    module.section(&functions);
    module.section(&globals);
    module.section(&exports);
    module.section(&code);
    module.finish()
}

fn wrong_signature_table_import() -> Vec<u8> {
    let mut types = TypeSection::new();
    types.ty().function([ValType::I64], [ValType::I64]);
    let mut imports = ImportSection::new();
    imports.import(
        "lazuli",
        "blocks",
        EntityType::Table(TableType {
            element_type: RefType {
                nullable: true,
                heap_type: HeapType::Concrete(0),
            },
            table64: false,
            minimum: 1,
            maximum: Some(lazuli_abi::memory::DISPATCH_SLOT_CAPACITY as u64),
            shared: false,
        }),
    );
    let mut module = Module::new();
    module.section(&types);
    module.section(&imports);
    module.finish()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn exact_modules_self_install_without_host_table_writes_and_fail_closed() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is unavailable; skipping typed self-install runtime test");
        return;
    }

    let first = identity(1, 0, 0x1001, 0xa001);
    let second = identity(2, 0, 0x1002, 0xa002);
    let trapped = identity(3, 1, 0x1003, 0xa003);
    let mut mutated = second;
    mutated.install_token_hi ^= 1;

    let mut jit = Jit::new_resident();
    let first_block = jit
        .build_resident_installable([instruction(0x3863_0001)], first)
        .unwrap();
    let second_block = jit
        .build_resident_installable([instruction(0x3884_0001)], second)
        .unwrap();
    let mutated_block = jit
        .build_resident_installable([instruction(0x38a5_0001)], mutated)
        .unwrap();
    let trapped_block = jit
        .build_resident_installable_with_trap([instruction(0x38c6_0001)], trapped)
        .unwrap();
    let authority = authority_module(first, second, trapped);
    let wrong = wrong_signature_table_import();
    let dispatcher = build_resident_dispatcher(&DispatcherConfig::production()).unwrap();
    for module in [
        first_block.wasm(),
        second_block.wasm(),
        mutated_block.wasm(),
        trapped_block.wasm(),
        &authority,
        &wrong,
        &dispatcher,
    ] {
        Validator::new().validate_all(module).unwrap();
    }

    let script = r#"
const [dispatcherHex, authorityHex, firstHex, secondHex, mutatedHex, trappedHex, wrongHex,
       pcOffset, metadataMiss, authorized, committed, identityMismatch] = process.argv.slice(1);
const decode = value => Buffer.from(value, "hex");
const memory = new WebAssembly.Memory({ initial: 720, maximum: 2048 });
const authority = new WebAssembly.Instance(new WebAssembly.Module(decode(authorityHex)), {}).exports;
const dispatcher = new WebAssembly.Instance(new WebAssembly.Module(decode(dispatcherHex)), {
  lazuli: {
    memory,
    validate_instruction_page_dependency: authority.validate_instruction_page_dependency,
  },
}).exports;
let hostTableSets = 0;
function instantiate(hex) {
  return new WebAssembly.Instance(new WebAssembly.Module(decode(hex)), {
    lazuli: {
      memory,
      begin_resident_block_install: authority.begin_resident_block_install,
      commit_resident_block_install: authority.commit_resident_block_install,
      blocks: dispatcher.blocks,
    },
  }).exports;
}
const first = instantiate(firstHex);
if ((first.install() >>> 0) !== (Number(committed) >>> 0)) throw new Error("first commit failed");
if (dispatcher.blocks.get(0) !== first.run) throw new Error("first block did not install itself");

authority.activate_second();
const second = instantiate(secondHex);
if ((second.install() >>> 0) !== (Number(committed) >>> 0)) throw new Error("second commit failed");
if (dispatcher.blocks.get(0) !== second.run) throw new Error("second block did not replace first");
if ((first.install() >>> 0) !== (Number(identityMismatch) >>> 0)) {
  throw new Error("delayed first module was not rejected");
}
if (dispatcher.blocks.get(0) !== second.run) throw new Error("delayed module overwrote accepted occupant");

const mutated = instantiate(mutatedHex);
if ((mutated.install() >>> 0) !== (Number(identityMismatch) >>> 0)) {
  throw new Error("mutated install token was not rejected");
}
if (dispatcher.blocks.get(0) !== second.run) throw new Error("mutated module poisoned slot zero");

authority.activate_trapped();
const trapped = instantiate(trappedHex);
let trappedExactly = false;
try { trapped.install(); } catch (error) { trappedExactly = error instanceof WebAssembly.RuntimeError; }
if (!trappedExactly) throw new Error("fault-injected installer did not trap after table.set");
if (dispatcher.blocks.get(1) !== trapped.run) throw new Error("trap did not occur after table.set");
if (authority.commit_count.value !== 2) throw new Error("trap reached commit publication");

const view = new DataView(memory.buffer);
const cpu = 0x1000;
const control = 0x2000;
view.setUint32(cpu + Number(pcOffset), 0x80002000, true);
const result = dispatcher.run(0, cpu, 0x3000, Number(pcOffset), control, 1, 0, 100n, 1);
if (result[3] !== Number(metadataMiss)) {
  throw new Error(`unpublished trapped slot escaped as reason ${result[3]}`);
}

let wrongRejected = false;
try {
  new WebAssembly.Instance(new WebAssembly.Module(decode(wrongHex)), {
    lazuli: { blocks: dispatcher.blocks },
  });
} catch (error) {
  wrongRejected = error instanceof WebAssembly.LinkError;
}
if (!wrongRejected) throw new Error("wrong-signature table import was accepted");
if (dispatcher.blocks.get(1) !== trapped.run) throw new Error("wrong signature changed typed table");
if (hostTableSets !== 0) throw new Error("host unexpectedly wrote the table");
process.stdout.write(JSON.stringify({ hostTableSets, commitCount: authority.commit_count.value }));
"#;

    let output = Command::new("node")
        .args([
            "--input-type=module",
            "--eval",
            script,
            &hex(&dispatcher),
            &hex(&authority),
            &hex(first_block.wasm()),
            &hex(second_block.wasm()),
            &hex(mutated_block.wasm()),
            &hex(trapped_block.wasm()),
            &hex(&wrong),
            &Reg::PC.offset().to_string(),
            &(DispatchReason::MetadataMiss as u32).to_string(),
            &(ResidentInstallStatus::Authorized as u32).to_string(),
            &(ResidentInstallStatus::Committed as u32).to_string(),
            &(ResidentInstallStatus::IdentityMismatch as u32).to_string(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "node failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        r#"{"hostTableSets":0,"commitCount":2}"#,
    );
}
