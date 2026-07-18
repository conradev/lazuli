//! Generates a self-contained browser harness for the complex DOL fixture.

use std::path::PathBuf;
use std::{env, fs};

use gekko::{GPR, Reg, SPR};

#[path = "../tests/support/dol_fixture.rs"]
mod dol_fixture;

use dol_fixture::{
    CONTINUATION_PC, ENTRY_POINT, EXPECTED_INSTRUCTIONS, HALT_PC, INITIAL_STACK_POINTER,
    LOOP_COUNT, LOOP_PC, PHYSICAL_RESULT_OFFSET, PHYSICAL_STACK_FRAME_OFFSET, RESULT_WORDS,
    WORKER_PC, bytes,
};

const MEMORY_PAGES: usize = 8;
const CPU_PTR: usize = 0x1000;
const FASTMEM_LUT_PTR: usize = 0x1_0000;
const RAM_PTR: usize = 0x4_0000;
const FASTMEM_PAGE_SHIFT: u32 = 17;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn main() {
    let mut arguments = env::args_os().skip(1);
    let output = arguments
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/ppcwasmjit-browser-dol/index.html"));
    let compiler_path = arguments
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/wasm32-unknown-unknown/release/ppcwasmjit.wasm"));
    let compiler_wasm = fs::read(&compiler_path).unwrap_or_else(|error| {
        panic!(
            "failed to read browser JIT compiler {}: {error}",
            compiler_path.display()
        )
    });
    let dol = bytes();

    let expected_words = RESULT_WORDS
        .into_iter()
        .map(|word| word.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let html = TEMPLATE
        .replace("__DOL__", &hex(&dol))
        .replace("__COMPILER_WASM__", &hex(&compiler_wasm))
        .replace("__MEMORY_PAGES__", &MEMORY_PAGES.to_string())
        .replace("__CPU_PTR__", &CPU_PTR.to_string())
        .replace("__FASTMEM_PTR__", &FASTMEM_LUT_PTR.to_string())
        .replace("__RAM_PTR__", &RAM_PTR.to_string())
        .replace("__FASTMEM_PAGE_SHIFT__", &FASTMEM_PAGE_SHIFT.to_string())
        .replace("__ENTRY_PC__", &ENTRY_POINT.to_string())
        .replace("__HALT_PC__", &HALT_PC.to_string())
        .replace("__WORKER_PC__", &WORKER_PC.to_string())
        .replace("__LOOP_PC__", &LOOP_PC.to_string())
        .replace("__CONTINUATION_PC__", &CONTINUATION_PC.to_string())
        .replace("__LOOP_COUNT__", &LOOP_COUNT.to_string())
        .replace(
            "__EXPECTED_INSTRUCTIONS__",
            &EXPECTED_INSTRUCTIONS.to_string(),
        )
        .replace("__RESULT_OFFSET__", &PHYSICAL_RESULT_OFFSET.to_string())
        .replace("__STACK_OFFSET__", &PHYSICAL_STACK_FRAME_OFFSET.to_string())
        .replace("__EXPECTED_WORDS__", &expected_words)
        .replace("__INITIAL_SP__", &INITIAL_STACK_POINTER.to_string())
        .replace("__PC_OFFSET__", &Reg::PC.offset().to_string())
        .replace("__R1_OFFSET__", &GPR::R1.offset().to_string())
        .replace("__R4_OFFSET__", &GPR::R4.offset().to_string())
        .replace("__R6_OFFSET__", &GPR::R6.offset().to_string())
        .replace("__R7_OFFSET__", &GPR::R7.offset().to_string())
        .replace("__LR_OFFSET__", &SPR::LR.offset().to_string());

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).expect("failed to create browser harness directory");
    }
    fs::write(&output, html).expect("failed to write browser harness");
    println!("{}", output.display());
}

const TEMPLATE: &str = r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Lazuli DOL browser JIT test</title>
</head>
<body>
  <pre id="result" data-testid="browser-dol-result">RUNNING</pre>
  <script type="module">
    const output = document.querySelector("#result");
    const dol = decode("__DOL__");
    const compilerWasm = decode("__COMPILER_WASM__");
    const expectedWords = [__EXPECTED_WORDS__];
    const memory = new WebAssembly.Memory({ initial: __MEMORY_PAGES__ });
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    const cpu = __CPU_PTR__;
    const fastmem = __FASTMEM_PTR__;
    const ram = __RAM_PTR__;
    const pcOffset = __PC_OFFSET__;

    function decode(hex) {
      const result = new Uint8Array(hex.length / 2);
      for (let index = 0; index < result.length; index += 1) {
        result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      }
      return result;
    }

    function check(condition, message) {
      if (!condition) throw new Error(message);
    }

    function register(offset) {
      return view.getUint32(cpu + offset, true);
    }

    const dolView = new DataView(dol.buffer, dol.byteOffset, dol.byteLength);

    function dolU32(offset) {
      return dolView.getUint32(offset, false);
    }

    function physicalOffset(logical) {
      check(logical >= 0x80000000, "DOL address is outside the default BAT mapping");
      return logical - 0x80000000;
    }

    function loadSections(fileBase, targetBase, sizeBase, count) {
      for (let index = 0; index < count; index += 1) {
        const size = dolU32(sizeBase + index * 4);
        if (size === 0) continue;
        const fileOffset = dolU32(fileBase + index * 4);
        const target = dolU32(targetBase + index * 4);
        check(fileOffset + size <= dol.length, "DOL section extends past the file");
        bytes.set(dol.subarray(fileOffset, fileOffset + size), ram + physicalOffset(target));
      }
    }

    function compileBlock(compiler, inputPointer, pc) {
      const compilerView = new DataView(compiler.memory.buffer);
      for (let index = 0; index < 64; index += 1) {
        const code = view.getUint32(ram + physicalOffset(pc + index * 4), false);
        compilerView.setUint32(inputPointer + index * 4, code, true);
      }

      const succeeded = compiler.ppcwasmjit_compile(inputPointer, 64);
      if (succeeded !== 1) {
        const pointer = compiler.ppcwasmjit_error_pointer();
        const length = compiler.ppcwasmjit_error_length();
        const error = new TextDecoder().decode(
          new Uint8Array(compiler.memory.buffer, pointer, length)
        );
        throw new Error("browser JIT compilation failed: " + error);
      }

      const pointer = compiler.ppcwasmjit_output_pointer();
      const length = compiler.ppcwasmjit_output_length();
      check(length !== 0, "browser JIT returned an empty module");
      return {
        maximum: compiler.ppcwasmjit_maximum_executed() >>> 0,
        wasm: new Uint8Array(compiler.memory.buffer, pointer, length).slice(),
      };
    }

    try {
      bytes.fill(0xa5, ram);
      const bssTarget = dolU32(0xd8);
      const bssSize = dolU32(0xdc);
      bytes.fill(0, ram + physicalOffset(bssTarget), ram + physicalOffset(bssTarget) + bssSize);
      loadSections(0x00, 0x48, 0x90, 7);
      loadSections(0x1c, 0x64, 0xac, 11);
      const entry = dolU32(0xe0);
      check(entry === __ENTRY_PC__, "DOL entrypoint mismatch");
      view.setUint32(cpu + pcOffset, entry, true);
      const logicalPage = entry >>> __FASTMEM_PAGE_SHIFT__;
      view.setUint32(fastmem + logicalPage * 4, ram, true);

      const { instance: compilerInstance } = await WebAssembly.instantiate(compilerWasm, {});
      const compiler = compilerInstance.exports;
      check(compiler.memory instanceof WebAssembly.Memory, "compiler did not export memory");
      const inputPointer = compiler.ppcwasmjit_alloc_words(64);
      const blocks = new Map();
      const visits = [];
      let instructions = 0;
      let cycles = 0;
      let pc = entry;
      for (let step = 0; step < 64 && pc !== __HALT_PC__; step += 1) {
        let block = blocks.get(pc);
        if (block === undefined) {
          block = compileBlock(compiler, inputPointer, pc);
          const { instance } = await WebAssembly.instantiate(block.wasm, {
            lazuli: { memory },
          });
          block.instance = instance;
          blocks.set(pc, block);
        }

        visits.push(pc);
        const executed = block.instance.exports.run(0, cpu, fastmem) >>> 0;
        const blockInstructions = executed & 0xffff;
        const blockCycles = executed >>> 16;
        check(blockInstructions <= (block.maximum & 0xffff), "instruction metadata overflow");
        check(blockCycles <= (block.maximum >>> 16), "cycle metadata overflow");
        instructions += blockInstructions;
        cycles += blockCycles;
        pc = register(pcOffset);
      }
      compiler.ppcwasmjit_free_words(inputPointer, 64);

      check(pc === __HALT_PC__, "dispatcher did not reach the terminal PC");
      check(visits.length === __LOOP_COUNT__ + 2, "unexpected dispatch count");
      check(visits[0] === __ENTRY_PC__, "entry block was not first");
      check(visits[1] === __WORKER_PC__, "worker block was not second");
      check(visits.at(-1) === __CONTINUATION_PC__, "continuation block was not last");
      check(
        visits.slice(2, -1).every(value => value === __LOOP_PC__),
        "counted loop dispatched through an unexpected PC",
      );
      check(blocks.size === 4, "unexpected compiled block cache size");
      check(instructions === __EXPECTED_INSTRUCTIONS__, "unexpected instruction total");
      check(cycles >= instructions, "cycle total is smaller than instruction total");

      const results = expectedWords.map((_, index) =>
        view.getUint32(ram + __RESULT_OFFSET__ + index * 4, false)
      );
      check(
        results.every((value, index) => value === expectedWords[index]),
        "published DOL result words do not match",
      );
      check(register(__R1_OFFSET__) === __INITIAL_SP__, "stack pointer was not restored");
      check(register(__R4_OFFSET__) === expectedWords[0], "r4 mismatch");
      check(register(__R6_OFFSET__) === expectedWords[1], "r6 mismatch");
      check(register(__R7_OFFSET__) === expectedWords[2], "r7 mismatch");
      check(register(__LR_OFFSET__) === __CONTINUATION_PC__, "link register mismatch");
      const stack = Array.from(bytes.slice(ram + __STACK_OFFSET__, ram + __STACK_OFFSET__ + 8))
        .map(value => value.toString(16).padStart(2, "0"))
        .join("");
      check(stack === "800030001fa50020", "stack frame bytes mismatch");

      const report = {
        status: "pass",
        runtime: navigator.userAgent,
        jit: "PPC to CLIF to Wasm compiled inside the browser",
        dolBytes: dol.length,
        compilerWasmBytes: compilerWasm.length,
        instructions,
        cycles,
        dispatches: visits.length,
        compiledBlocks: blocks.size,
        takenLoopBranches: __LOOP_COUNT__ - 1,
        untakenLoopBranches: 1,
        results,
      };
      document.body.dataset.status = "pass";
      output.textContent = JSON.stringify(report, null, 2);
      console.log("BROWSER_DOL_PASS", report);
    } catch (error) {
      document.body.dataset.status = "fail";
      output.textContent = String(error?.stack ?? error);
      console.error("BROWSER_DOL_FAIL", error);
    }
  </script>
</body>
</html>
"##;
