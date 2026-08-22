use std::env;

use lazuli_abi::memory::{
    LEGACY_MEMORY_INITIAL_PAGES, LEGACY_MEMORY_MAXIMUM_PAGES, RUNTIME_BASE, WASM_PAGE_BYTES,
};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32") {
        return;
    }

    // This module is a peer of the generated PPC blocks, not of the browser JIT compiler. It
    // imports the one machine memory so MEM1, IPL, and ARAM stay zero-copy. Rust's wasm allocator
    // grows from the current memory end, so the host bootstraps at 45 MiB, initializes exactly
    // once, then grows the same memory to its fixed 48 MiB maximum before creating host views.
    println!("cargo:rustc-link-arg=--import-memory=lazuli,memory");
    println!(
        "cargo:rustc-link-arg=--initial-memory={}",
        LEGACY_MEMORY_INITIAL_PAGES * WASM_PAGE_BYTES
    );
    println!(
        "cargo:rustc-link-arg=--max-memory={}",
        LEGACY_MEMORY_MAXIMUM_PAGES * WASM_PAGE_BYTES
    );
    println!("cargo:rustc-link-arg=--global-base={RUNTIME_BASE}");
    println!("cargo:rustc-link-arg=--no-stack-first");
    println!("cargo:rustc-link-arg=-zstack-size=262144");
}
