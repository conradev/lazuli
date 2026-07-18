mod support;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::process::{Command, Stdio};

use disks::binrw::BinRead;
use disks::dol::Dol;
use gekko::disasm::{Extensions, Ins};
use gekko::{GPR, Reg, SPR};
use ppcwasmjit::Jit;
use support::dol_fixture::{
    CONTINUATION_PC, ENTRY_POINT, EXPECTED_INSTRUCTIONS, HALT_PC, INITIAL_STACK_POINTER,
    LOOP_COUNT, LOOP_PC, PHYSICAL_RESULT_OFFSET, PHYSICAL_STACK_FRAME_OFFSET, RESULT_SIZE,
    RESULT_WORDS, WORKER_PC, bytes,
};
use wasmparser::Validator;

const WASM_PAGE_SIZE: usize = 64 * 1024;
const MEMORY_PAGES: usize = 8;
const CPU_PTR: usize = 0x1000;
const FASTMEM_LUT_PTR: usize = 0x1_0000;
const RAM_PTR: usize = 0x4_0000;
const FASTMEM_PAGE_SHIFT: u32 = 17;

fn physical_offset(logical: u32) -> usize {
    logical
        .checked_sub(0x8000_0000)
        .expect("fixture address is outside the default BAT mapping") as usize
}

fn put_u32_le(memory: &mut [u8], offset: usize, value: u32) {
    memory[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn load_dol(dol: &Dol) -> Vec<u8> {
    let mut memory = vec![0; MEMORY_PAGES * WASM_PAGE_SIZE];
    memory[RAM_PTR..].fill(0xa5);

    let bss = RAM_PTR + physical_offset(dol.header.bss_target);
    memory[bss..bss + dol.header.bss_size as usize].fill(0);
    for section in dol.text_sections().chain(dol.data_sections()) {
        let target = RAM_PTR + physical_offset(section.target);
        memory[target..target + section.content.len()].copy_from_slice(section.content);
    }

    put_u32_le(&mut memory, CPU_PTR + Reg::PC.offset(), dol.entrypoint());

    // The fixture lives entirely in effective page 0x4000. Entries are little-endian Wasm linear
    // memory offsets; guest text and data at the pointed-to page remain big-endian.
    let logical_page = dol.entrypoint() >> FASTMEM_PAGE_SHIFT;
    let lut_entry = FASTMEM_LUT_PTR + logical_page as usize * size_of::<u32>();
    put_u32_le(&mut memory, lut_entry, RAM_PTR as u32);

    memory
}

fn fetch(memory: &[u8], pc: u32) -> Ins {
    let address = RAM_PTR + physical_offset(pc);
    let code = u32::from_be_bytes(memory[address..address + 4].try_into().unwrap());
    Ins::new(code, Extensions::gekko_broadway())
}

fn compile_block(jit: &mut Jit, memory: &[u8], pc: u32) -> (u32, Vec<u8>) {
    let mut cursor = pc;
    let instructions = std::iter::from_fn(|| {
        let instruction = fetch(memory, cursor);
        cursor = cursor.wrapping_add(4);
        Some(instruction)
    });
    let block = jit
        .build(instructions.take(64))
        .expect("DOL block did not compile");
    Validator::new().validate_all(block.wasm()).unwrap();
    let executed = block.metadata().executed.pack();
    (executed, block.into_wasm())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn protocol_line(output: &mut impl BufRead) -> String {
    let mut line = String::new();
    let read = output
        .read_line(&mut line)
        .expect("failed to read from the WebAssembly runtime");
    assert_ne!(read, 0, "WebAssembly runtime closed its protocol");
    line.trim_end().to_owned()
}

#[test]
fn dol_runs_end_to_end_through_wasm_dispatcher() {
    let dol_bytes = bytes();
    let dol = Dol::read(&mut Cursor::new(&dol_bytes)).expect("fixture is not a valid DOL");
    let memory = load_dol(&dol);
    assert_eq!(
        &memory[RAM_PTR + PHYSICAL_RESULT_OFFSET..][..RESULT_SIZE],
        &[0; RESULT_SIZE],
        "DOL BSS was not zeroed before execution",
    );

    let script = r#"
import { createInterface } from "node:readline";
const [pages, cpuPtr, fmemPtr, pcOffset, r1Offset, r4Offset, r6Offset, r7Offset, lrOffset, resultPtr, stackPtr] = process.argv.slice(1).map(Number);
const memory = new WebAssembly.Memory({ initial: pages });
const view = new DataView(memory.buffer);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const input = lines[Symbol.asyncIterator]();
const init = await input.next();
if (init.done || !init.value.startsWith("INIT ")) throw new Error("missing memory image");
new Uint8Array(memory.buffer).set(Buffer.from(init.value.slice(5), "hex"));
const write = line => process.stdout.write(line + "\n");
write("READY " + view.getUint32(cpuPtr + pcOffset, true));

for await (const line of input) {
    const fields = line.split(" ");
    if (fields[0] === "BLOCK") {
        const pc = Number(fields[1]) >>> 0;
        const expectedExecuted = Number(fields[2]) >>> 0;
        const currentPc = view.getUint32(cpuPtr + pcOffset, true);
        if (currentPc !== pc) throw new Error("dispatch mismatch");
        const { instance } = await WebAssembly.instantiate(Buffer.from(fields[3], "hex"), {
            lazuli: { memory },
        });
        const executed = instance.exports.run(0, cpuPtr, fmemPtr) >>> 0;
        const nextPc = view.getUint32(cpuPtr + pcOffset, true);
        write("RESULT " + pc + " " + nextPc + " " + executed);
    } else if (fields[0] === "CHECK") {
        const pc = view.getUint32(cpuPtr + pcOffset, true);
        const results = [0, 4, 8, 12].map(offset => view.getUint32(resultPtr + offset, false));
        const r1 = view.getUint32(cpuPtr + r1Offset, true);
        const r4 = view.getUint32(cpuPtr + r4Offset, true);
        const r6 = view.getUint32(cpuPtr + r6Offset, true);
        const r7 = view.getUint32(cpuPtr + r7Offset, true);
        const lr = view.getUint32(cpuPtr + lrOffset, true);
        const stack = Buffer.from(new Uint8Array(memory.buffer, stackPtr, 8)).toString("hex");
        write("STATE " + [pc, ...results, r1, r4, r6, r7, lr, stack].join(" "));
    } else if (fields[0] === "QUIT") {
        break;
    } else {
        throw new Error("unknown protocol command: " + fields[0]);
    }
}
"#;

    let mut command = Command::new("node");
    command
        .args([
            "--input-type=module",
            "--eval",
            script,
            &MEMORY_PAGES.to_string(),
            &CPU_PTR.to_string(),
            &FASTMEM_LUT_PTR.to_string(),
            &Reg::PC.offset().to_string(),
            &GPR::R1.offset().to_string(),
            &GPR::R4.offset().to_string(),
            &GPR::R6.offset().to_string(),
            &GPR::R7.offset().to_string(),
            &SPR::LR.offset().to_string(),
            &(RAM_PTR + PHYSICAL_RESULT_OFFSET).to_string(),
            &(RAM_PTR + PHYSICAL_STACK_FRAME_OFFSET).to_string(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .expect("node is required for the DOL E2E test");
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());

    writeln!(input, "INIT {}", hex(&memory)).unwrap();
    input.flush().unwrap();
    let ready = protocol_line(&mut output);
    let ready = ready.split_whitespace().collect::<Vec<_>>();
    assert_eq!(ready[0], "READY");
    let mut pc = ready[1].parse::<u32>().unwrap();
    assert_eq!(pc, dol.entrypoint());

    // This is the compile-on-miss code cache: no worker or continuation addresses are supplied to
    // the compiler. Each next PC comes from the previously executed WebAssembly block.
    let mut jit = Jit::new();
    let mut cache = HashMap::<u32, (u32, Vec<u8>)>::new();
    let mut visits = Vec::new();
    let mut total_instructions = 0u16;
    let mut total_cycles = 0u16;
    for _ in 0..64 {
        if pc == HALT_PC {
            break;
        }

        let (expected_executed, wasm) = cache
            .entry(pc)
            .or_insert_with(|| compile_block(&mut jit, &memory, pc));
        visits.push(pc);
        writeln!(input, "BLOCK {pc} {expected_executed} {}", hex(wasm)).unwrap();
        input.flush().unwrap();

        let result = protocol_line(&mut output);
        let result = result.split_whitespace().collect::<Vec<_>>();
        assert_eq!(result[0], "RESULT");
        assert_eq!(result[1].parse::<u32>().unwrap(), pc);
        pc = result[2].parse::<u32>().unwrap();
        let executed = result[3].parse::<u32>().unwrap();
        assert!(
            executed as u16 <= *expected_executed as u16,
            "block exceeded its maximum instruction metadata",
        );
        assert!(
            (executed >> 16) as u16 <= (*expected_executed >> 16) as u16,
            "block exceeded its maximum cycle metadata",
        );
        total_instructions += executed as u16;
        total_cycles += (executed >> 16) as u16;
    }

    assert_eq!(pc, HALT_PC, "DOL dispatcher did not reach its terminal PC");
    assert_eq!(visits.len(), LOOP_COUNT as usize + 2);
    assert_eq!(visits[0], ENTRY_POINT);
    assert_eq!(visits[1], WORKER_PC);
    assert!(visits[2..visits.len() - 1].iter().all(|pc| *pc == LOOP_PC));
    assert_eq!(visits.last(), Some(&CONTINUATION_PC));
    assert_eq!(cache.len(), 4);
    assert_eq!(total_instructions, EXPECTED_INSTRUCTIONS);
    assert!(total_cycles >= total_instructions);

    writeln!(input, "CHECK").unwrap();
    input.flush().unwrap();
    let state = protocol_line(&mut output);
    let state = state.split_whitespace().collect::<Vec<_>>();
    assert_eq!(state[0], "STATE");
    assert_eq!(state[1].parse::<u32>().unwrap(), HALT_PC);
    for (field, expected) in state[2..6].iter().zip(RESULT_WORDS) {
        assert_eq!(field.parse::<u32>().unwrap(), expected);
    }
    assert_eq!(state[6].parse::<u32>().unwrap(), INITIAL_STACK_POINTER);
    assert_eq!(state[7].parse::<u32>().unwrap(), RESULT_WORDS[0]);
    assert_eq!(state[8].parse::<u32>().unwrap(), RESULT_WORDS[1]);
    assert_eq!(state[9].parse::<u32>().unwrap(), RESULT_WORDS[2]);
    assert_eq!(state[10].parse::<u32>().unwrap(), CONTINUATION_PC);
    assert_eq!(state[11], "800030001fa50020");

    writeln!(input, "QUIT").unwrap();
    input.flush().unwrap();
    drop(input);
    let status = child.wait().unwrap();
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(status.success(), "WebAssembly runtime failed:\n{stderr}");
}
