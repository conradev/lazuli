//! Minimal raw-WebAssembly ABI for running the JIT compiler inside a browser.

use std::cell::RefCell;
use std::{mem, slice};

use gekko::disasm::{Extensions, Ins};

use crate::{Jit, RegionBlock, link_region};

#[derive(Default)]
struct Output {
    wasm: Vec<u8>,
    error: Vec<u8>,
    maximum_executed: u32,
    pattern: u32,
}

thread_local! {
    static OUTPUT: RefCell<Output> = RefCell::new(Output::default());
}

/// Allocates aligned input storage for a sequence of decoded PPC instruction words.
#[unsafe(no_mangle)]
pub extern "C" fn ppcwasmjit_alloc_words(word_count: u32) -> u32 {
    let mut words = Vec::<u32>::with_capacity(word_count as usize);
    let pointer = words.as_mut_ptr();
    mem::forget(words);
    pointer as usize as u32
}

/// Releases storage previously returned by ppcwasmjit_alloc_words.
///
/// # Safety
///
/// The pointer and word count must be the unchanged values from one live allocation.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ppcwasmjit_free_words(pointer: u32, word_count: u32) {
    if word_count == 0 {
        return;
    }

    // SAFETY: The caller promises this is the live allocation returned by the allocator, with
    // the same capacity and no initialized Rust elements.
    drop(unsafe {
        Vec::<u32>::from_raw_parts(pointer as usize as *mut u32, 0, word_count as usize)
    });
}

/// Compiles the supplied PPC words into one WebAssembly basic block.
///
/// Returns one on success and zero on failure. The result and error accessors remain valid until
/// the next compile call.
///
/// # Safety
///
/// The pointer must address word_count initialized u32 values in this module's linear memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ppcwasmjit_compile(pointer: u32, word_count: u32) -> u32 {
    // SAFETY: The caller promises the allocation contains word_count initialized words.
    let words =
        unsafe { slice::from_raw_parts(pointer as usize as *const u32, word_count as usize) };
    let instructions = words
        .iter()
        .copied()
        .map(|code| Ins::new(code, Extensions::gekko_broadway()));

    match Jit::with_slow_memory().build(instructions) {
        Ok(block) => {
            let maximum_executed = block.metadata().executed.pack();
            let pattern = block.metadata().pattern as u32;
            OUTPUT.with_borrow_mut(|output| {
                output.wasm = block.into_wasm();
                output.error.clear();
                output.maximum_executed = maximum_executed;
                output.pattern = pattern;
            });
            1
        }
        Err(error) => {
            OUTPUT.with_borrow_mut(|output| {
                output.wasm.clear();
                output.error = error.to_string().into_bytes();
                output.maximum_executed = 0;
                output.pattern = 0;
            });
            0
        }
    }
}

/// Links `(pc, packed maximum execution)` pairs into one budgeted WebAssembly region runner.
///
/// Returns one on success and zero on failure. The generated module is exposed through the same
/// output accessors as a compiled block.
///
/// # Safety
///
/// The pointer must address `block_count * 2` initialized u32 values in this module's memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ppcwasmjit_link_region(pointer: u32, block_count: u32) -> u32 {
    // SAFETY: The caller promises the allocation contains two initialized words per block.
    let words = unsafe {
        slice::from_raw_parts(
            pointer as usize as *const u32,
            block_count.saturating_mul(2) as usize,
        )
    };
    let blocks = words
        .chunks_exact(2)
        .map(|pair| RegionBlock {
            pc: pair[0],
            maximum_cycles: (pair[1] >> 16) as u16,
        })
        .collect::<Vec<_>>();

    match link_region(&blocks) {
        Ok(wasm) => {
            OUTPUT.with_borrow_mut(|output| {
                output.wasm = wasm;
                output.error.clear();
                output.maximum_executed = 0;
                output.pattern = 0;
            });
            1
        }
        Err(error) => {
            OUTPUT.with_borrow_mut(|output| {
                output.wasm.clear();
                output.error = error.to_string().into_bytes();
                output.maximum_executed = 0;
                output.pattern = 0;
            });
            0
        }
    }
}

/// Pointer to the most recently compiled WebAssembly block.
#[unsafe(no_mangle)]
pub extern "C" fn ppcwasmjit_output_pointer() -> u32 {
    OUTPUT.with_borrow(|output| output.wasm.as_ptr() as usize as u32)
}

/// Length of the most recently compiled WebAssembly block.
#[unsafe(no_mangle)]
pub extern "C" fn ppcwasmjit_output_length() -> u32 {
    OUTPUT.with_borrow(|output| output.wasm.len() as u32)
}

/// Maximum packed instruction/cycle count for the most recently compiled block.
#[unsafe(no_mangle)]
pub extern "C" fn ppcwasmjit_maximum_executed() -> u32 {
    OUTPUT.with_borrow(|output| output.maximum_executed)
}

/// Semantic pattern detected for the most recently compiled block.
#[unsafe(no_mangle)]
pub extern "C" fn ppcwasmjit_pattern() -> u32 {
    OUTPUT.with_borrow(|output| output.pattern)
}

/// Pointer to the most recent UTF-8 compilation error.
#[unsafe(no_mangle)]
pub extern "C" fn ppcwasmjit_error_pointer() -> u32 {
    OUTPUT.with_borrow(|output| output.error.as_ptr() as usize as u32)
}

/// Length of the most recent UTF-8 compilation error.
#[unsafe(no_mangle)]
pub extern "C" fn ppcwasmjit_error_length() -> u32 {
    OUTPUT.with_borrow(|output| output.error.len() as u32)
}
