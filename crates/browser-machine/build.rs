use std::env;

use lazuli_abi::memory::{
    RESIDENT_MEMORY_INITIAL_PAGES, RESIDENT_MEMORY_MAXIMUM_PAGES, RUNTIME_BASE, WASM_PAGE_BYTES,
};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32") {
        return;
    }

    // The core and every lowered block share one browser-owned memory. Architected windows live
    // below RUNTIME_BASE; Rust's stack, statics, and allocator are confined above it.
    println!("cargo:rustc-link-arg=--import-memory=lazuli,memory");
    println!(
        "cargo:rustc-link-arg=--initial-memory={}",
        RESIDENT_MEMORY_INITIAL_PAGES * WASM_PAGE_BYTES
    );
    println!(
        "cargo:rustc-link-arg=--max-memory={}",
        RESIDENT_MEMORY_MAXIMUM_PAGES * WASM_PAGE_BYTES
    );
    println!("cargo:rustc-link-arg=--global-base={RUNTIME_BASE}");
    println!("cargo:rustc-link-arg=--no-stack-first");
    println!("cargo:rustc-link-arg=-zstack-size=262144");
}
