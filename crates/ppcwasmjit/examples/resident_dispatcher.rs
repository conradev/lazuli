//! Writes the production Rust-authored resident dispatcher WebAssembly artifact.

use std::path::PathBuf;
use std::{env, fs};

use ppcwasmjit::{DispatcherConfig, build_resident_dispatcher};
use wasmparser::Validator;

fn main() {
    let output = env::args_os().nth(1).map_or_else(
        || panic!("usage: resident_dispatcher <output.wasm>"),
        PathBuf::from,
    );
    let bytes = build_resident_dispatcher(&DispatcherConfig::production())
        .expect("failed to build production resident dispatcher");
    Validator::new()
        .validate_all(&bytes)
        .expect("production resident dispatcher failed WebAssembly validation");
    fs::write(&output, bytes).unwrap_or_else(|error| {
        panic!(
            "failed to write resident dispatcher {}: {error}",
            output.display()
        )
    });
}
