//! Validates the feature-only game-fidelity exports on an actual browser-machine Wasm artifact.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::{env, fs};

use wasmparser::{ExternalKind, FuncType, Parser, Payload, TypeRef, ValType, Validator};

const EXPORTS: [&str; 6] = [
    "core_game_fidelity_bytes",
    "core_game_fidelity_phase",
    "core_game_fidelity_requested_buttons",
    "core_game_fidelity_requested_stick_xy_cxy",
    "core_game_fidelity_requested_trigger_lrab",
    "core_game_fidelity_snapshot",
];

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args().skip(1);
    let mode = arguments
        .next()
        .ok_or("usage: game_fidelity_wasm_contract <enabled|disabled> <browser_machine.wasm>")?;
    let path = arguments
        .next()
        .ok_or("usage: game_fidelity_wasm_contract <enabled|disabled> <browser_machine.wasm>")?;
    if arguments.next().is_some() || !matches!(mode.as_str(), "enabled" | "disabled") {
        return Err(
            "usage: game_fidelity_wasm_contract <enabled|disabled> <browser_machine.wasm>".into(),
        );
    }

    let bytes = fs::read(path)?;
    Validator::new().validate_all(&bytes)?;
    let mut types = Vec::<FuncType>::new();
    let mut function_types = Vec::<u32>::new();
    let mut fidelity_exports = BTreeMap::<String, (ExternalKind, u32)>::new();
    for payload in Parser::new(0).parse_all(&bytes) {
        match payload? {
            Payload::TypeSection(section) => {
                for function_type in section.into_iter_err_on_gc_types() {
                    types.push(function_type?);
                }
            }
            Payload::ImportSection(section) => {
                for import in section.into_imports() {
                    if let TypeRef::Func(type_index) = import?.ty {
                        function_types.push(type_index);
                    }
                }
            }
            Payload::FunctionSection(section) => {
                for type_index in section {
                    function_types.push(type_index?);
                }
            }
            Payload::ExportSection(section) => {
                for export in section {
                    let export = export?;
                    if export.name.starts_with("core_game_fidelity_") {
                        fidelity_exports
                            .insert(export.name.to_owned(), (export.kind, export.index));
                    }
                }
            }
            _ => {}
        }
    }

    let expected = EXPORTS
        .into_iter()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let actual = fidelity_exports.keys().cloned().collect::<BTreeSet<_>>();
    if mode == "disabled" {
        if !actual.is_empty() {
            return Err(
                format!("default artifact exposed feature-only exports: {actual:?}").into(),
            );
        }
        return Ok(());
    }
    if actual != expected {
        return Err(format!("game-fidelity export set drifted: {actual:?}").into());
    }
    for name in expected {
        let (kind, function_index) = fidelity_exports[&name];
        if kind != ExternalKind::Func {
            return Err(format!("{name} is not a function export").into());
        }
        let type_index = *function_types
            .get(function_index as usize)
            .ok_or_else(|| format!("{name} function index is out of bounds"))?;
        let function_type = types
            .get(type_index as usize)
            .ok_or_else(|| format!("{name} type index is out of bounds"))?;
        if !function_type.params().is_empty() || function_type.results() != [ValType::I32] {
            return Err(format!("{name} must have the exact () -> i32 ABI").into());
        }
    }
    Ok(())
}
