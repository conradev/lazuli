use std::path::PathBuf;
use std::{env, fs};

fn main() {
    let output = env::args_os().nth(1).map_or_else(
        || panic!("usage: core_run_coordinator <output.wasm>"),
        PathBuf::from,
    );
    let bytes = browser_machine::core_run::build_core_run_coordinator();
    fs::write(&output, bytes).unwrap_or_else(|error| {
        panic!("failed to write coordinator {}: {error}", output.display())
    });
}
