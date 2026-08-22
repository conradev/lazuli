use std::env;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32") {
        return;
    }

    // This module is a peer of the generated PPC blocks, not of the browser JIT compiler. It
    // imports the one machine memory so MEM1 and ARAM stay zero-copy. Rust's wasm allocator grows
    // from the current memory end, so the host bootstraps at 43 MiB, initializes exactly once,
    // then grows the same memory to its fixed 45 MiB maximum before creating JavaScript views.
    for argument in [
        "--import-memory=lazuli,memory",
        "--initial-memory=45088768",
        "--max-memory=47185920",
        "--global-base=44040192",
        "--no-stack-first",
        "-zstack-size=262144",
    ] {
        println!("cargo:rustc-link-arg={argument}");
    }
}
