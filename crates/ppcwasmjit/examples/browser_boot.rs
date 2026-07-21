//! Generates an instrumented browser-only disc bring-up harness.

use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::{env, fs};

use disks::binrw::BinRead;
use disks::cso::{Cso, CsoReader};
use disks::iso;
use gekko::{GPR, Reg, SPR};
use ppcwasmjit::gx_fifo_hook_runtime;

const MEMORY_PAGES: usize = 416;
const CPU_PTR: usize = 0x1000;
const FASTMEM_LUT_PTR: usize = 0x1_0000;
const RAM_PTR: usize = 0x10_0000;
const RAM_SIZE: usize = 0x0180_0000;
const MMIO_PTR: usize = RAM_PTR + RAM_SIZE;
const MMIO_SIZE: usize = 1 << FASTMEM_PAGE_SHIFT;
const LOCKED_CACHE_PTR: usize = MMIO_PTR + MMIO_SIZE;
const LOCKED_CACHE_SIZE: usize = 16 * 1024;
const GX_FIFO_STAGING_META_PTR: usize = LOCKED_CACHE_PTR + LOCKED_CACHE_SIZE;
const GX_FIFO_STAGING_DATA_PTR: usize = GX_FIFO_STAGING_META_PTR + 16;
const GX_FIFO_STAGING_CAPACITY: usize = 256 * 1024;
const FASTMEM_PAGE_SHIFT: u32 = 17;
const FASTMEM_LUT_COUNT: usize = 1 << 15;
const DISC_BI2_OFFSET: u64 = 0x440;
const DISC_BI2_SIZE: usize = 0x2000;
const DISC_SOURCE_RUNTIME: &str = include_str!("browser_disc_source.mjs");

trait ReadSeek: Read + Seek {}

impl<T: Read + Seek> ReadSeek for T {}

struct DiscBootInfo {
    audio_streaming: u8,
    bi2: Vec<u8>,
    disc_id: u8,
    filesystem: Vec<u8>,
    filesystem_max_size: u32,
    game_code: u32,
    game_identifier: String,
    game_label: String,
    maker_code: u16,
    stream_buffer_size: u8,
    tv_mode: u32,
    version: u8,
}

impl DiscBootInfo {
    fn empty() -> Self {
        Self {
            audio_streaming: 0,
            bi2: Vec::new(),
            disc_id: 0,
            filesystem: Vec::new(),
            filesystem_max_size: 0x24,
            game_code: 0,
            game_identifier: "selected-disc".to_owned(),
            game_label: "Selected disc".to_owned(),
            maker_code: 0,
            stream_buffer_size: 0,
            tv_mode: 0,
            version: 0,
        }
    }

    fn standalone(dol_path: &PathBuf) -> Self {
        let name = dol_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("standalone DOL")
            .to_owned();
        Self {
            audio_streaming: 0,
            bi2: Vec::new(),
            disc_id: 0,
            filesystem: Vec::new(),
            filesystem_max_size: 0x24,
            game_code: 0,
            game_identifier: "standalone-dol".to_owned(),
            game_label: name,
            maker_code: 0,
            stream_buffer_size: 0,
            tv_mode: 0,
            version: 0,
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn js_string(value: &str) -> String {
    format!("{value:?}")
}

fn open_disc(path: &PathBuf) -> Box<dyn ReadSeek> {
    let file = fs::File::open(path)
        .unwrap_or_else(|error| panic!("failed to open disc {}: {error}", path.display()));
    let mut reader = BufReader::new(file);
    let mut magic = [0; 4];
    reader
        .read_exact(&mut magic)
        .unwrap_or_else(|error| panic!("failed to read disc magic {}: {error}", path.display()));
    reader
        .seek(SeekFrom::Start(0))
        .unwrap_or_else(|error| panic!("failed to rewind disc {}: {error}", path.display()));
    if &magic == b"CISO" {
        let cso = Cso::new(reader)
            .unwrap_or_else(|error| panic!("failed to parse CISO {}: {error}", path.display()));
        Box::new(CsoReader::new(cso))
    } else {
        Box::new(reader)
    }
}

fn read_disc_boot_info(path: &PathBuf) -> DiscBootInfo {
    let mut reader = open_disc(path);
    let header = iso::Header::read_be(&mut reader)
        .unwrap_or_else(|error| panic!("failed to parse disc header {}: {error}", path.display()));
    assert!(
        header.filesystem_size >= 12,
        "disc FST is too small in {}",
        path.display()
    );
    reader
        .seek(SeekFrom::Start(DISC_BI2_OFFSET))
        .unwrap_or_else(|error| panic!("failed to seek disc BI2 {}: {error}", path.display()));
    let mut bi2 = vec![0; DISC_BI2_SIZE];
    reader
        .read_exact(&mut bi2)
        .unwrap_or_else(|error| panic!("failed to read disc BI2 {}: {error}", path.display()));
    reader
        .seek(SeekFrom::Start(header.filesystem_offset as u64))
        .unwrap_or_else(|error| panic!("failed to seek disc FST {}: {error}", path.display()));
    let mut filesystem = vec![0; header.filesystem_size as usize];
    reader
        .read_exact(&mut filesystem)
        .unwrap_or_else(|error| panic!("failed to read disc FST {}: {error}", path.display()));

    let game_code = header.meta.game_code();
    let game_code_text = header
        .meta
        .game_code_str()
        .unwrap_or_else(|| format!("{game_code:08X}"));
    let maker_text = String::from_utf8_lossy(&header.meta.maker_code.to_be_bytes()).into_owned();
    let game_identifier = format!("{game_code_text}{maker_text}");
    let title = header.meta.game_name.to_string();
    let game_label = if title.is_empty() {
        format!("{game_identifier} Rev.{:02}", header.meta.version)
    } else {
        format!("{title} ({game_identifier} Rev.{:02})", header.meta.version)
    };

    DiscBootInfo {
        audio_streaming: header.meta.audio_streaming,
        bi2,
        disc_id: header.meta.disk_id,
        filesystem,
        filesystem_max_size: header.max_filesystem_size.max(header.filesystem_size),
        game_code,
        game_identifier,
        game_label,
        maker_code: header.meta.maker_code,
        stream_buffer_size: header.meta.stream_buffer_size,
        tv_mode: u32::from(header.meta.country_code == b'P'),
        version: header.meta.version,
    }
}

fn copy_browser_asset(source: &PathBuf, destination: &PathBuf, label: &str) {
    if source == destination {
        assert!(source.is_file(), "missing {label} {}", source.display());
        return;
    }
    let unchanged = fs::metadata(source).ok().and_then(|source_metadata| {
        fs::metadata(destination).ok().map(|destination_metadata| {
            source_metadata.len() == destination_metadata.len()
                && source_metadata.modified().ok() == destination_metadata.modified().ok()
        })
    }) == Some(true);
    if unchanged {
        return;
    }
    fs::copy(source, destination).unwrap_or_else(|error| {
        panic!(
            "failed to copy {label} {} to {}: {error}",
            source.display(),
            destination.display()
        )
    });
}

fn main() {
    let mut arguments = env::args_os().skip(1);
    let output = arguments
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/ppcwasmjit-browser-boot/index.html"));
    let compiler_path = arguments
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/wasm32-unknown-unknown/release/ppcwasmjit.wasm"));
    let dol_path = arguments.next().map(PathBuf::from);
    let disc_path = arguments.next().map(PathBuf::from);
    let has_boot_asset = dol_path.is_some();
    let has_disc = disc_path.is_some();
    let disc = match (&disc_path, &dol_path) {
        (Some(path), _) => read_disc_boot_info(path),
        (None, Some(path)) => DiscBootInfo::standalone(path),
        (None, None) => DiscBootInfo::empty(),
    };
    let gpr_offsets = (0_u8..32)
        .map(|index| GPR::new(index).offset().to_string())
        .collect::<Vec<_>>()
        .join(",");
    let gx_fifo_runtime = gx_fifo_hook_runtime(
        GX_FIFO_STAGING_META_PTR as u32,
        GX_FIFO_STAGING_DATA_PTR as u32,
        GX_FIFO_STAGING_CAPACITY as u32,
    );

    let output_directory = output
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&output_directory).expect("failed to create browser harness directory");
    let compiler_output = output_directory.join("ppcwasmjit.wasm");
    copy_browser_asset(&compiler_path, &compiler_output, "browser JIT compiler");
    if let Some(dol_path) = &dol_path {
        let dol_output = output_directory.join("boot.dol");
        copy_browser_asset(dol_path, &dol_output, "boot DOL");
    }

    let dol_name = dol_path.as_ref().map_or_else(
        || "selected disc".to_owned(),
        |path| path.display().to_string(),
    );

    let html = TEMPLATE
        .replace("__DISC_SOURCE_RUNTIME__", DISC_SOURCE_RUNTIME)
        .replace(
            "__HAS_BOOT_ASSET__",
            if has_boot_asset { "true" } else { "false" },
        )
        .replace("__HAS_DISC__", if has_disc { "true" } else { "false" })
        .replace("__BI2__", &hex(&disc.bi2))
        .replace("__FST__", &hex(&disc.filesystem))
        .replace("__FST_MAX_SIZE__", &disc.filesystem_max_size.to_string())
        .replace("__GPR_OFFSETS__", &gpr_offsets)
        .replace("__DOL_NAME__", &js_string(&dol_name))
        .replace("__GAME_LABEL__", &js_string(&disc.game_label))
        .replace("__GAME_IDENTIFIER__", &js_string(&disc.game_identifier))
        .replace("__GAME_CODE__", &disc.game_code.to_string())
        .replace("__MAKER_CODE__", &disc.maker_code.to_string())
        .replace("__DISC_ID__", &disc.disc_id.to_string())
        .replace("__DISC_VERSION__", &disc.version.to_string())
        .replace("__AUDIO_STREAMING__", &disc.audio_streaming.to_string())
        .replace(
            "__STREAM_BUFFER_SIZE__",
            &disc.stream_buffer_size.to_string(),
        )
        .replace("__TV_MODE__", &disc.tv_mode.to_string())
        .replace("__MEMORY_PAGES__", &MEMORY_PAGES.to_string())
        .replace("__CPU_PTR__", &CPU_PTR.to_string())
        .replace("__FASTMEM_PTR__", &FASTMEM_LUT_PTR.to_string())
        .replace("__RAM_PTR__", &RAM_PTR.to_string())
        .replace("__RAM_SIZE__", &RAM_SIZE.to_string())
        .replace("__MMIO_PTR__", &MMIO_PTR.to_string())
        .replace("__MMIO_SIZE__", &MMIO_SIZE.to_string())
        .replace("__LOCKED_CACHE_PTR__", &LOCKED_CACHE_PTR.to_string())
        .replace("__LOCKED_CACHE_SIZE__", &LOCKED_CACHE_SIZE.to_string())
        .replace("__GX_FIFO_HOOK_RUNTIME__", &hex(&gx_fifo_runtime))
        .replace(
            "__GX_FIFO_STAGING_META_PTR__",
            &GX_FIFO_STAGING_META_PTR.to_string(),
        )
        .replace(
            "__GX_FIFO_STAGING_DATA_PTR__",
            &GX_FIFO_STAGING_DATA_PTR.to_string(),
        )
        .replace(
            "__GX_FIFO_STAGING_CAPACITY__",
            &GX_FIFO_STAGING_CAPACITY.to_string(),
        )
        .replace("__FASTMEM_PAGE_SHIFT__", &FASTMEM_PAGE_SHIFT.to_string())
        .replace("__FASTMEM_LUT_COUNT__", &FASTMEM_LUT_COUNT.to_string())
        .replace("__PC_OFFSET__", &Reg::PC.offset().to_string())
        .replace("__CTR_OFFSET__", &SPR::CTR.offset().to_string())
        .replace("__MSR_OFFSET__", &Reg::MSR.offset().to_string())
        .replace("__LR_OFFSET__", &SPR::LR.offset().to_string())
        .replace("__DAR_OFFSET__", &SPR::DAR.offset().to_string())
        .replace("__SRR0_OFFSET__", &SPR::SRR0.offset().to_string())
        .replace("__SRR1_OFFSET__", &SPR::SRR1.offset().to_string())
        .replace("__DEC_OFFSET__", &SPR::DEC.offset().to_string())
        .replace("__TB_OFFSET__", &SPR::TBL.offset().to_string())
        .replace("__DMAU_OFFSET__", &SPR::DMAU.offset().to_string())
        .replace("__DMAL_OFFSET__", &SPR::DMAL.offset().to_string());

    fs::write(&output, html).expect("failed to write browser harness");
    println!("{}", output.display());
}

const TEMPLATE: &str = r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#111318">
  <title>Gekko</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0b0c0f;
      color: #f1f3f5;
      font-synthesis: none;
    }

    * { box-sizing: border-box; }

    body {
      min-width: 20rem;
      min-height: 100vh;
      margin: 0;
      background:
        radial-gradient(circle at top, rgba(88, 105, 140, 0.14), transparent 38rem),
        #0b0c0f;
    }

    button, input { font: inherit; }

    button, .button {
      min-height: 2.5rem;
      border: 1px solid #3b414b;
      border-radius: 0.55rem;
      padding: 0.5rem 0.85rem;
      background: #20242b;
      color: inherit;
      cursor: pointer;
    }

    button:hover, .button:hover { background: #2a3038; }
    button:focus-visible, .button:focus-visible, .disc-picker:focus-within,
    input:focus-visible, summary:focus-visible {
      outline: 2px solid #a8c7ff;
      outline-offset: 2px;
    }

    button.primary, .button.primary {
      border-color: #dbe7ff;
      background: #e5edff;
      color: #121722;
      font-weight: 650;
    }

    .shell {
      display: grid;
      width: min(100%, 74rem);
      min-height: 100vh;
      margin: 0 auto;
      padding: clamp(0.75rem, 2vw, 1.5rem);
      gap: 0.9rem;
      grid-template-rows: auto minmax(0, 1fr) auto auto auto;
    }

    .shell > * { min-width: 0; }

    .shell[data-surface="release"] {
      grid-template-rows: auto minmax(0, 1fr) auto auto;
    }

    header, .status-group, .source-actions, #runner-controls, #controller-controls,
    .advanced-grid, footer {
      display: flex;
      align-items: center;
      gap: 0.65rem;
    }

    header { min-width: 0; }

    h1 {
      margin: 0 auto 0 0;
      font-size: 1rem;
      font-weight: 680;
      letter-spacing: 0.04em;
    }

    .disc-picker {
      position: relative;
      overflow: hidden;
    }

    #disc-file {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      cursor: pointer;
    }

    #disc-status {
      overflow: hidden;
      max-width: min(32vw, 19rem);
      color: #aeb4be;
      font-size: 0.82rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .status-dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: #8f98a6;
      box-shadow: 0 0 0 0.2rem rgba(143, 152, 166, 0.12);
    }

    body[data-status="running"] .status-dot { background: #78dba9; }
    body[data-status="paused"] .status-dot { background: #f1c86b; }
    body[data-status="stopped"] .status-dot { background: #ef7d7d; }

    .stage {
      display: grid;
      min-height: 0;
      place-items: center;
      overflow: hidden;
      border: 1px solid #23272e;
      border-radius: 0.85rem;
      background: #000;
      box-shadow: 0 1rem 3.5rem rgba(0, 0, 0, 0.34);
    }

    #display {
      display: block;
      width: min(100%, calc((100vh - 12rem) * 4 / 3));
      max-height: calc(100vh - 12rem);
      aspect-ratio: 4 / 3;
      object-fit: contain;
      background: #000;
    }

    .play-controls {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 0.8rem;
    }

    .shell[data-surface="release"] .play-controls {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    #runner-controls, #controller-controls { flex-wrap: wrap; }
    #controller-controls { justify-content: center; }
    #controller-controls button { min-width: 2.75rem; }
    #controller-start { min-width: 4.5rem; }

    .key-help {
      margin: 0;
      color: #8f98a6;
      font-size: 0.75rem;
      text-align: center;
    }

    details {
      min-width: 0;
      overflow: hidden;
      border: 1px solid #292e36;
      border-radius: 0.65rem;
      background: rgba(20, 23, 28, 0.92);
    }

    summary {
      padding: 0.75rem;
      color: #c7ccd4;
      cursor: pointer;
      font-size: 0.85rem;
    }

    .details-body {
      min-width: 0;
      padding: 0 0.75rem 0.75rem;
    }
    .source-actions, .advanced-grid { flex-wrap: wrap; }

    input[type="url"], input[type="number"] {
      min-height: 2.5rem;
      border: 1px solid #3b414b;
      border-radius: 0.5rem;
      padding: 0.45rem 0.65rem;
      background: #0f1115;
      color: inherit;
    }

    input[type="url"] { flex: 1 1 18rem; }
    input[type="number"] { width: 9rem; }

    #result {
      width: 100%;
      max-width: 100%;
      overflow: auto;
      max-height: 24rem;
      margin: 0.75rem 0 0;
      border-top: 1px solid #292e36;
      padding: 0.75rem 0 0;
      color: #aeb7c4;
      font: 0.72rem/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    footer {
      justify-content: space-between;
      color: #747d8a;
      font-size: 0.72rem;
    }

    footer a { color: #aeb7c4; }

    .shell[data-surface="release"] {
      position: fixed;
      inset: 0;
      display: block;
      width: 100%;
      max-width: none;
      height: 100dvh;
      min-height: 0;
      padding: 0;
      overflow: hidden;
      background: #000;
      isolation: isolate;
    }

    .shell[data-surface="release"] header {
      position: absolute;
      z-index: 3;
      top: max(clamp(0.65rem, 2vw, 1.15rem), env(safe-area-inset-top));
      left: 50%;
      width: min(calc(100% - 2rem), 52rem);
      min-height: 3rem;
      border: 1px solid rgba(255, 255, 255, 0.13);
      border-radius: 999px;
      padding: 0.4rem 0.45rem 0.4rem 1rem;
      background: rgba(14, 15, 18, 0.76);
      box-shadow: 0 0.8rem 2.5rem rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(1rem) saturate(125%);
      transform: translateX(-50%);
      transition: top 180ms ease, width 180ms ease, transform 180ms ease;
    }

    .shell[data-surface="release"] h1 {
      color: #d9dde4;
      font-size: 0.76rem;
      font-weight: 620;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    .shell[data-surface="release"] .status-group { min-width: 0; }

    .shell[data-surface="release"] #runner-status {
      color: #d9dde4;
      font-size: 0.75rem;
    }

    .shell[data-surface="release"] #disc-status {
      max-width: min(36vw, 24rem);
      color: #8f98a6;
      font-size: 0.75rem;
    }

    .shell[data-surface="release"] .disc-picker {
      min-height: 2.15rem;
      border-color: rgba(255, 255, 255, 0.22);
      border-radius: 999px;
      padding: 0.35rem 0.85rem;
      background: #f1f3f5;
      color: #111318;
      font-size: 0.78rem;
      font-weight: 680;
    }

    body:not([data-status="waiting"]) .shell[data-surface="release"] header {
      right: max(clamp(0.65rem, 2vw, 1.15rem), env(safe-area-inset-right));
      left: auto;
      width: auto;
      min-height: 0;
      border: 0;
      padding: 0;
      background: transparent;
      box-shadow: none;
      backdrop-filter: none;
      transform: none;
    }

    body:not([data-status="waiting"]) .shell[data-surface="release"] header h1,
    body:not([data-status="waiting"]) .shell[data-surface="release"] .status-group {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    body:not([data-status="waiting"]) .shell[data-surface="release"] .disc-picker {
      border-color: rgba(255, 255, 255, 0.14);
      background: rgba(14, 15, 18, 0.64);
      color: #d9dde4;
      opacity: 0.56;
      backdrop-filter: blur(1rem) saturate(125%);
      transition: opacity 150ms ease, background 150ms ease;
    }

    body:not([data-status="waiting"]) .shell[data-surface="release"] .disc-picker:hover,
    body:not([data-status="waiting"]) .shell[data-surface="release"] .disc-picker:focus-within {
      background: rgba(14, 15, 18, 0.88);
      opacity: 1;
    }

    .shell[data-surface="release"] .stage {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 0;
      border-radius: 0;
      box-shadow: none;
    }

    .shell[data-surface="release"] #display {
      width: min(100vw, calc(100dvh * 4 / 3));
      height: auto;
      max-width: 100vw;
      max-height: 100dvh;
    }

    .shell[data-surface="release"] .play-controls {
      position: absolute;
      z-index: 3;
      bottom: max(clamp(0.7rem, 2vw, 1.15rem), env(safe-area-inset-bottom));
      left: 50%;
      display: block;
      width: max-content;
      max-width: calc(100% - 1rem);
      opacity: 0.72;
      transform: translateX(-50%);
      transition: opacity 150ms ease, transform 180ms ease;
    }

    .shell[data-surface="release"] .play-controls:hover,
    .shell[data-surface="release"] .play-controls:focus-within { opacity: 1; }

    .shell[data-surface="release"] #controller-controls {
      display: grid;
      grid-template-columns: repeat(3, 2.15rem) 0.35rem 2.65rem 2.65rem 4.25rem;
      grid-template-rows: repeat(3, 2.15rem);
      gap: 0.3rem;
      padding: 0.45rem;
      border: 1px solid rgba(255, 255, 255, 0.13);
      border-radius: 1rem;
      background: rgba(14, 15, 18, 0.76);
      box-shadow: 0 0.8rem 2.5rem rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(1rem) saturate(125%);
      user-select: none;
      touch-action: none;
      -webkit-tap-highlight-color: transparent;
      -webkit-touch-callout: none;
    }

    .shell[data-surface="release"] #controller-controls button {
      min-width: 0;
      min-height: 0;
      border-color: rgba(255, 255, 255, 0.16);
      border-radius: 50%;
      padding: 0;
      background: rgba(255, 255, 255, 0.08);
      color: #eef1f5;
      transition: background 80ms ease, transform 80ms ease;
    }

    .shell[data-surface="release"] #controller-controls button:active {
      background: rgba(255, 255, 255, 0.22);
      transform: scale(0.94);
    }

    .shell[data-surface="release"] #controller-left { grid-area: 2 / 1; }
    .shell[data-surface="release"] #controller-up { grid-area: 1 / 2; }
    .shell[data-surface="release"] #controller-down { grid-area: 3 / 2; }
    .shell[data-surface="release"] #controller-right { grid-area: 2 / 3; }

    .shell[data-surface="release"] #controller-a,
    .shell[data-surface="release"] #controller-b {
      align-self: center;
      height: 2.65rem;
      background: rgba(255, 255, 255, 0.14);
    }

    .shell[data-surface="release"] #controller-a { grid-area: 1 / 5 / 4 / 6; }
    .shell[data-surface="release"] #controller-b { grid-area: 1 / 6 / 4 / 7; }

    .shell[data-surface="release"] #controller-start {
      grid-area: 1 / 7 / 4 / 8;
      align-self: center;
      min-width: 0;
      height: 2.35rem;
      border-radius: 999px;
      color: #c9ced6;
      font-size: 0.75rem;
    }

    .shell[data-surface="release"] .key-help { display: none; }

    .shell[data-surface="release"] footer {
      position: absolute;
      z-index: 3;
      right: max(1rem, env(safe-area-inset-right));
      bottom: max(0.7rem, env(safe-area-inset-bottom));
      gap: 0.45rem;
      color: #737b87;
      font-size: 0;
      opacity: 0.54;
    }

    .shell[data-surface="release"] footer span { display: none; }
    .shell[data-surface="release"] footer a { font-size: 0.65rem; }

    body[data-status="waiting"] .shell[data-surface="release"] header {
      top: 50%;
      width: min(calc(100% - 2rem), 27rem);
      border-radius: 1.15rem;
      padding: 0.75rem;
      transform: translate(-50%, -50%);
    }

    body[data-status="waiting"] .shell[data-surface="release"] header h1 {
      margin: 0 auto;
      font-size: 0.82rem;
    }

    body[data-status="waiting"] .shell[data-surface="release"] .status-group { display: none; }

    body[data-status="waiting"] .shell[data-surface="release"] .disc-picker {
      min-width: 11rem;
      text-align: center;
    }

    body[data-status="waiting"] .shell[data-surface="release"] .play-controls {
      pointer-events: none;
      opacity: 0;
      transform: translate(-50%, 0.75rem);
    }

    @media (max-width: 48rem) {
      .shell { grid-template-rows: auto auto auto auto auto; }
      header { flex-wrap: wrap; }
      .status-group { order: 3; width: 100%; }
      #disc-status { max-width: calc(100vw - 4rem); }
      #display { width: 100%; max-height: none; }
      .play-controls { grid-template-columns: 1fr; }
      .shell[data-surface="release"] .play-controls { grid-template-columns: 1fr; }
      #runner-controls, #controller-controls { justify-content: center; }
      .key-help { display: none; }

      .shell[data-surface="release"] header {
        top: 0.5rem;
        width: calc(100% - 1rem);
        border-radius: 0.9rem;
        padding-left: 0.7rem;
        flex-wrap: nowrap;
      }

      .shell[data-surface="release"] h1 { display: none; }
      .shell[data-surface="release"] .status-group { width: auto; }
      .shell[data-surface="release"] #disc-status { max-width: 34vw; }
      .shell[data-surface="release"] footer { display: none; }

      body[data-status="waiting"] .shell[data-surface="release"] header {
        top: 50%;
        width: min(calc(100% - 2rem), 24rem);
        flex-wrap: wrap;
      }

      body[data-status="waiting"] .shell[data-surface="release"] header h1 {
        display: block;
        width: 100%;
      }
    }

    @media (hover: none) {
      .shell[data-surface="release"] .play-controls { opacity: 0.9; }
    }
  </style>
</head>
<body>
  <main class="shell" data-surface="debug">
    <header>
      <h1>Gekko</h1>
      <div class="status-group" aria-live="polite">
        <span class="status-dot" aria-hidden="true"></span>
        <span id="runner-status">starting</span>
        <span aria-hidden="true">·</span>
        <span id="disc-status">ready</span>
      </div>
      <label class="button primary disc-picker">
        Open ISO or CISO
        <input id="disc-file" type="file" aria-label="Open ISO or CISO" accept=".iso,.ciso,.cso,application/octet-stream">
      </label>
    </header>

    <div class="stage">
      <canvas id="display" data-testid="game-display" width="640" height="480">
        WebGPU support is required.
      </canvas>
    </div>

    <div class="play-controls">
      <!-- LAZULI DEBUG UI START -->
      <div id="runner-controls">
        <button id="pause-runner" type="button">Pause</button>
        <button id="resume-runner" type="button">Resume</button>
      </div>
      <!-- LAZULI DEBUG UI END -->
      <div id="controller-controls" aria-label="Controller">
        <button id="controller-left" type="button" aria-label="Left">←</button>
        <button id="controller-up" type="button" aria-label="Up">↑</button>
        <button id="controller-down" type="button" aria-label="Down">↓</button>
        <button id="controller-right" type="button" aria-label="Right">→</button>
        <button id="controller-a" type="button">A</button>
        <button id="controller-b" type="button">B</button>
        <button id="controller-start" type="button">Start</button>
      </div>
      <p class="key-help">Arrows · Z / X · Enter</p>
    </div>

    <!-- LAZULI DEBUG UI START -->
    <details id="diagnostics">
      <summary>Options and diagnostics</summary>
      <div class="details-body">
        <div id="disc-controls" class="source-actions">
          <input id="disc-url" type="url" inputmode="url" aria-label="Network source URL" placeholder="https://example.net/archive.ciso">
          <button id="load-disc-url" type="button">Open URL</button>
        </div>
        <div class="advanced-grid">
          <input id="extend-cycles" type="number" aria-label="Additional cycles" min="1" step="100000000" value="100000000">
          <input id="extend-dispatches" type="number" aria-label="Additional dispatches" min="1" step="1000000" placeholder="auto dispatches">
          <button id="extend-runner" type="button">Extend limits</button>
          <input id="runner-rest-ms" type="number" aria-label="Rest milliseconds" min="0" max="1000" step="1" value="0">
          <button id="apply-throttle" type="button">Apply rest</button>
          <input id="runner-render-every" type="number" aria-label="Render interval" min="1" max="1000" step="1" value="1">
          <button id="apply-presentation" type="button">Apply render interval</button>
          <button id="snapshot-runner" type="button">Snapshot</button>
          <button id="stop-runner" type="button">Stop</button>
        </div>
        <pre id="result" data-testid="browser-boot-result">RUNNING</pre>
      </div>
    </details>
    <!-- LAZULI DEBUG UI END -->

    <footer>
      <span>Runs locally in this browser</span>
      <a href="https://github.com/conradev/lazuli" target="_blank" rel="source noopener">Source</a>
    </footer>
  </main>
  <script id="runner-source" type="text/plain">
    const statusDataset = new Proxy({}, {
      set(target, name, value) {
        const text = String(value);
        target[name] = text;
        postMessage({ type: "dataset", name, value: text });
        return true;
      },
    });
    const output = {
      set textContent(value) {
        postMessage({ type: "finish", text: String(value) });
      },
    };
    let controllerSequence = 0;
    let controllerAppliedSequence = 0;
    let runnerPaused = false;
    let runnerStopRequested = false;
    let runnerSnapshotRequested = false;
    let runnerResume = null;
    let rendererFrameSequence = 0;
    const rendererFramesInFlight = new Set();
    let rendererBackpressureResume = null;
    let rendererBackpressureWaits = 0;
    let rendererFramesAcknowledged = 0;
    let rendererFrameFailures = 0;
    let rendererFrameHighWater = 0;
    let rendererFrameResultMisses = 0;
    let rendererFailure = null;
    let cycleLimit = Number.POSITIVE_INFINITY;
    let dispatchLimit = Number.POSITIVE_INFINITY;
    let cycles = 0;
    let dispatches = 0;
    let controllerState = {
      buttons: 0,
      stickX: 0x80,
      stickY: 0x80,
      cStickX: 0x80,
      cStickY: 0x80,
      triggerL: 0,
      triggerR: 0,
      analogA: 0,
      analogB: 0,
    };
    const controllerQueue = [];
    const controllerQueueCapacity = 64;
    let controllerQueueHighWater = 0;
    let controllerQueueCoalesces = 0;
    let controllerQueueOverflows = 0;
    let serialLastPollSignature = null;
    let serialLastPolledButtons = 0;
    let serialLastPolledSequence = 0;
    let serialLastRespondedChannels = 0;
    let serialLastPublishedChannels = 0;
    let serialLastUpdatedChannels = 0;
    let serialLastEnabledChannels = 0;
    const cpStatusReadIdle = 0x0004;
    const cpStatusCommandIdle = 0x0008;
    const diBreakRequest = 0x00000001;
    const diInterruptMasks = 0x0000002a;
    const diInterruptStatuses = 0x00000054;
    const diDeviceErrorInterrupt = 0x00000004;
    const diTransferInterrupt = 0x00000010;
    const diMinimumCommandLatencyCycles = 145800;
    const diErrorInvalidCommand = 0x00052000;
    const diErrorNoAudioBuffer = 0x00052001;
    const diErrorInvalidAudioCommand = 0x00052401;
    const piDiskInterruptCause = 0x00000004;
    const siTransferStart = 0x00000001;
    const siReadStatusInterruptMask = 0x08000000;
    const siReadStatusInterrupt = 0x10000000;
    const siCommunicationError = 0x20000000;
    const siTransferInterruptMask = 0x40000000;
    const siTransferInterrupt = 0x80000000;
    const siStatusInputReadyMask = 0x20202020;
    const siStatusErrorWriteOneToClear = 0x0f0f0f0f;
    const siStatusWriteStatusMask = 0x10101010;
    const siStatusWrite = 0x80000000;
    const piSerialInterruptCause = 0x00000008;
    const padUseOrigin = 0x0080;
    const serialTransferOutcome = Object.freeze({
      success: 0,
      noResponse: 1,
      protocolError: 2,
    });
    const serialTransferOutcomeNames = Object.freeze([
      "success",
      "no-response",
      "protocol-error",
    ]);
    const serialNoResponseByChannel = [0, 0, 0, 0];
    const serialPeriodicNoResponseByChannel = [0, 0, 0, 0];
    const serialNoResponseAcknowledgedByChannel = [0, 0, 0, 0];
    const serialControllerModes = [3, 3, 3, 3];
    const serialControllerRumble = [false, false, false, false];
    const serialOutputCommandsByChannel = [0, 0, 0, 0];
    let serialUnknownOutputCommands = 0;
    let serialTransferInterruptAcknowledgements = 0;
    let serialLastTransfer = null;
    let serialPollCatchUpBatches = 0;
    let serialPollCatchUpPolls = 0;
    let serialPollMaxBatch = 0;
    let serialPollMaxLateness = 0;
    const serialPollTrace = [];
    let serialInterruptLevelActive = false;
    let serialInterruptLevelChanges = 0;
    let serialInterruptLevelReason = null;
    function enqueueControllerState(message) {
      if (message.sequence <= controllerSequence) return;
      controllerSequence = message.sequence;
      const queued = {
        sequence: message.sequence,
        state: message.state,
      };
      const previous = controllerQueue.at(-1);
      if (previous !== undefined && previous.state.buttons === queued.state.buttons) {
        controllerQueue[controllerQueue.length - 1] = queued;
        controllerQueueCoalesces += 1;
      } else if (
        controllerQueue.length === 0
        && controllerState.buttons === queued.state.buttons
      ) {
        controllerState = queued.state;
        controllerAppliedSequence = queued.sequence;
        controllerQueueCoalesces += 1;
      } else if (controllerQueue.length < controllerQueueCapacity) {
        controllerQueue.push(queued);
        controllerQueueHighWater = Math.max(
          controllerQueueHighWater,
          controllerQueue.length
        );
      } else {
        // Button-edge ordering is a correctness boundary. Surface bounded
        // queue exhaustion instead of silently merging or dropping input.
        controllerQueueOverflows += 1;
        runnerStopRequested = true;
        runnerPaused = false;
        runnerSnapshotRequested = true;
        statusDataset.controllerQueue = "overflow";
      }
    }
    addEventListener("message", event => {
      const message = event.data;
      if (message?.type === "controller") {
        enqueueControllerState(message);
      } else if (
        message?.type === "renderer-frame-complete"
        || message?.type === "renderer-frame-failed"
      ) {
        completeRendererFrame(message);
      } else if (message?.type === "renderer-failed") {
        recordRendererFailure(message.error);
      } else if (message?.type === "run-control") {
        if (message.action === "pause") {
          runnerPaused = true;
          runnerSnapshotRequested = true;
        } else if (message.action === "resume") {
          runnerPaused = false;
          runnerResume?.();
        } else if (message.action === "extend") {
          const additionalCycles = Number(message.cycles);
          if (Number.isFinite(additionalCycles) && additionalCycles > 0) {
            const requestedDispatches = Number(message.dispatches);
            const observedDispatchesPerCycle = cycles > 0
              ? dispatches / cycles
              : 1 / 64;
            const automaticDispatches = Math.max(
              10_000,
              Math.ceil(additionalCycles * observedDispatchesPerCycle * 1.35)
            );
            const additionalDispatches = Number.isFinite(requestedDispatches)
              && requestedDispatches > 0
              ? Math.ceil(requestedDispatches)
              : automaticDispatches;
            cycleLimit = Number.isFinite(cycleLimit)
              ? Math.max(cycles + 1, cycleLimit + additionalCycles)
              : cycleLimit;
            dispatchLimit = Number.isFinite(dispatchLimit)
              ? Math.max(dispatches + 1, dispatchLimit + additionalDispatches)
              : dispatchLimit;
            statusDataset.cycleLimit = String(cycleLimit);
            statusDataset.dispatchLimit = String(dispatchLimit);
            runnerPaused = false;
            runnerResume?.();
          }
        } else if (message.action === "throttle") {
          const restMs = Number(message.restMs);
          if (Number.isFinite(restMs)) {
            runnerRestMs = Math.max(0, Math.min(1000, Math.floor(restMs)));
            statusDataset.restMs = String(runnerRestMs);
          }
        } else if (message.action === "presentation") {
          const renderEvery = Number(message.renderEvery);
          if (Number.isFinite(renderEvery)) {
            runnerRenderEvery = Math.max(1, Math.min(1000, Math.floor(renderEvery)));
            statusDataset.renderEvery = String(runnerRenderEvery);
          }
        } else if (message.action === "stop") {
          runnerStopRequested = true;
          runnerPaused = false;
          runnerResume?.();
          rendererBackpressureResume?.();
        } else if (message.action === "snapshot") {
          runnerSnapshotRequested = true;
        }
      }
    });

    function postRendererFrame(type, frame) {
      const rendererSequence = ++rendererFrameSequence;
      rendererFramesInFlight.add(rendererSequence);
      rendererFrameHighWater = Math.max(
        rendererFrameHighWater,
        rendererFramesInFlight.size
      );
      try {
        postMessage({ type, frame, rendererSequence });
      } catch (error) {
        rendererFramesInFlight.delete(rendererSequence);
        throw error;
      }
    }

    function completeRendererFrame(message) {
      const rendererSequence = Number(message.rendererSequence);
      if (
        !Number.isSafeInteger(rendererSequence)
        || !rendererFramesInFlight.delete(rendererSequence)
      ) {
        rendererFrameResultMisses += 1;
        return;
      }
      if (message.type === "renderer-frame-failed") {
        rendererFrameFailures += 1;
        recordRendererFailure(message.error);
      } else {
        rendererFramesAcknowledged += 1;
        if (rendererFramesInFlight.size === 0) rendererBackpressureResume?.();
      }
    }

    function recordRendererFailure(error) {
      if (rendererFailure === null) {
        rendererFailure = String(error || "WebGPU renderer failed");
      }
      rendererBackpressureResume?.();
    }

    function controllerPacketForPoll(channel = 0) {
      const queued = controllerQueue.shift();
      if (queued !== undefined) {
        controllerState = queued.state;
        controllerAppliedSequence = queued.sequence;
      }
      const rawButtons = controllerState.buttons & 0xffff;
      const buttons = (rawButtons | padUseOrigin) & 0xffff;
      const cStickX = controllerState.cStickX & 0xff;
      const cStickY = controllerState.cStickY & 0xff;
      const triggerL = controllerState.triggerL & 0xff;
      const triggerR = controllerState.triggerR & 0xff;
      const analogA = (controllerState.analogA ?? (
        (rawButtons & 0x0100) !== 0 ? 0xff : 0
      )) & 0xff;
      const analogB = (controllerState.analogB ?? (
        (rawButtons & 0x0200) !== 0 ? 0xff : 0
      )) & 0xff;
      const mode = serialControllerModes[channel] & 0xff;
      let low;
      if (mode === 0 || mode === 5 || mode === 6 || mode === 7) {
        low = [
          cStickX,
          cStickY,
          ((triggerL & 0xf0) | (triggerR >>> 4)) & 0xff,
          ((analogA & 0xf0) | (analogB >>> 4)) & 0xff,
        ];
      } else if (mode === 1) {
        low = [
          ((cStickX & 0xf0) | (cStickY >>> 4)) & 0xff,
          triggerL,
          triggerR,
          ((analogA & 0xf0) | (analogB >>> 4)) & 0xff,
        ];
      } else if (mode === 2) {
        low = [
          ((cStickX & 0xf0) | (cStickY >>> 4)) & 0xff,
          ((triggerL & 0xf0) | (triggerR >>> 4)) & 0xff,
          analogA,
          analogB,
        ];
      } else if (mode === 4) {
        low = [cStickX, cStickY, analogA, analogB];
      } else {
        // Mode 3 is the SDK default. Treat unsupported mode bytes as mode 3
        // rather than publishing an uninitialized low word.
        low = [cStickX, cStickY, triggerL, triggerR];
      }
      serialLastPolledButtons = rawButtons;
      serialLastPolledSequence = controllerAppliedSequence;
      return [
        buttons >>> 8,
        buttons,
        controllerState.stickX,
        controllerState.stickY,
        ...low,
      ];
    }

    function postControllerPollAcknowledgement(packet) {
      const buttons = ((packet[0] << 8) | packet[1]) & ~padUseOrigin;
      if (buttons !== 0) {
        globalThis.postMessage?.({
          type: "controller-poll",
          buttons,
          sequence: controllerAppliedSequence,
        });
      }
      return buttons;
    }
    __DISC_SOURCE_RUNTIME__

    async function fetchBinary(url, label) {
      const response = await fetch(url, { cache: "no-cache" });
      if (!response.ok) throw new Error(`${label} fetch failed: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }

    async function configuredDiscSource() {
      if (globalThis.discSourceConfig.kind !== "file-message") {
        return globalThis.discSourceConfig;
      }
      return new Promise((resolve, reject) => {
        const receive = event => {
          if (event.data?.type !== "disc-source-file") return;
          removeEventListener("message", receive);
          if (!(event.data.file instanceof Blob)) {
            reject(new Error("disc picker did not provide a file"));
            return;
          }
          resolve({ kind: "file", file: event.data.file });
        };
        addEventListener("message", receive);
      });
    }

    function createWeightedLruCache(maximumEntries, maximumWeight, weightOf) {
      const entries = new Map();
      let totalWeight = 0;
      let evictionCount = 0;

      function measuredWeight(value) {
        const weight = Number(weightOf(value));
        return Number.isFinite(weight) ? Math.max(0, weight) : 0;
      }

      function remove(key) {
        if (!entries.has(key)) return false;
        const value = entries.get(key);
        entries.delete(key);
        totalWeight -= measuredWeight(value);
        return true;
      }

      const cache = {
        clear() {
          entries.clear();
          totalWeight = 0;
          evictionCount = 0;
        },
        delete(key) {
          return remove(key);
        },
        get(key) {
          if (!entries.has(key)) return undefined;
          const value = entries.get(key);
          entries.delete(key);
          entries.set(key, value);
          return value;
        },
        set(key, value) {
          remove(key);
          entries.set(key, value);
          totalWeight += measuredWeight(value);
          while (entries.size > maximumEntries || totalWeight > maximumWeight) {
            remove(entries.keys().next().value);
            evictionCount += 1;
          }
          return cache;
        },
        get evictions() {
          return evictionCount;
        },
        get maximumWeight() {
          return maximumWeight;
        },
        get size() {
          return entries.size;
        },
        get weight() {
          return totalWeight;
        },
      };
      return cache;
    }

    const compilerWasmPromise = fetchBinary(
      globalThis.compilerWasmUrl, "browser JIT compiler"
    );
    const discSourceConfig = await configuredDiscSource();
    let discSource = null;
    let boot;
    if (discSourceConfig.kind === "boot-assets") {
      const fallbackDol = await fetchBinary(globalThis.dolUrl, "boot DOL");
      const fallbackBootLayout = discBootMemoryLayout(__FST_MAX_SIZE__);
      boot = {
        audioStreaming: __AUDIO_STREAMING__,
        bi2: decode("__BI2__"),
        bi2Address: fallbackBootLayout.bi2Address,
        discId: __DISC_ID__,
        dol: fallbackDol,
        fst: decode("__FST__"),
        fstAddress: fallbackBootLayout.fstAddress,
        fstMaxSize: __FST_MAX_SIZE__,
        gameCode: __GAME_CODE__,
        identifier: __GAME_IDENTIFIER__,
        label: __GAME_LABEL__,
        makerCode: __MAKER_CODE__,
        streamBufferSize: __STREAM_BUFFER_SIZE__,
        tvMode: __TV_MODE__,
        version: __DISC_VERSION__,
      };
    } else {
      discSource = await openDiscSource(discSourceConfig);
      boot = await readDiscBoot(discSource);
    }
    let compilerWasm = await compilerWasmPromise;
    let { bi2, dol, fst } = boot;
    const { bi2Address, fstAddress, fstMaxSize } = boot;
    const bi2Bytes = bi2.length;
    const dolBytes = dol.length;
    const fstBytes = fst.length;
    const compilerWasmBytes = compilerWasm.length;
    const gprOffsets = [__GPR_OFFSETS__];
    const memory = new WebAssembly.Memory({ initial: __MEMORY_PAGES__ });
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    const cpu = __CPU_PTR__;
    const regionControl = 0xf000;
    const fastmem = __FASTMEM_PTR__;
    const ram = __RAM_PTR__;
    const ramSize = __RAM_SIZE__;
    const mmio = __MMIO_PTR__;
    const mmioSize = __MMIO_SIZE__;
    const lockedCache = __LOCKED_CACHE_PTR__;
    const lockedCacheSize = __LOCKED_CACHE_SIZE__;
    const gxFifoHookRuntimeWasm = decode("__GX_FIFO_HOOK_RUNTIME__");
    const gxFifoStagingMeta = __GX_FIFO_STAGING_META_PTR__;
    const gxFifoStagingData = __GX_FIFO_STAGING_DATA_PTR__;
    const gxFifoStagingCapacity = __GX_FIFO_STAGING_CAPACITY__;
    const pcOffset = __PC_OFFSET__;
    const ctrOffset = __CTR_OFFSET__;
    const msrOffset = __MSR_OFFSET__;
    const lrOffset = __LR_OFFSET__;
    const darOffset = __DAR_OFFSET__;
    const srr0Offset = __SRR0_OFFSET__;
    const srr1Offset = __SRR1_OFFSET__;
    const decrementerOffset = __DEC_OFFSET__;
    const timeBaseOffset = __TB_OFFSET__;
    const dmaUpperOffset = __DMAU_OFFSET__;
    const dmaLowerOffset = __DMAL_OFFSET__;
    function readRunnerLimit(searchParams, name) {
      const value = searchParams.get(name);
      return value === null ? Number.POSITIVE_INFINITY : Number(value);
    }
    const searchParams = new URLSearchParams(globalThis.runnerSearch);
    dispatchLimit = readRunnerLimit(searchParams, "dispatches");
    cycleLimit = readRunnerLimit(searchParams, "cycles");
    const runnerSliceMs = Math.max(1, Number(searchParams.get("sliceMs") ?? 12));
    let runnerRestMs = Math.max(0, Number(searchParams.get("restMs") ?? 0));
    let runnerRenderEvery = Math.max(
      1,
      Math.min(1000, Math.floor(Number(searchParams.get("renderEvery") ?? 1)))
    );
    const requestedBlockChunk = Number(searchParams.get("blockChunk") ?? 1024);
    const runnerBlockChunk = Number.isFinite(requestedBlockChunk)
      ? Math.max(1, Math.min(8192, Math.floor(requestedBlockChunk)))
      : 1024;
    const stopOnFirstDsi = searchParams.get("stopOnFirstDsi") === "1";
    let runnerYieldDeadline = Date.now() + runnerSliceMs;
    let runnerBlocksUntilYield = runnerBlockChunk;

    function runnerRestWhenDue(now) {
      return now >= runnerYieldDeadline ? runnerRestMs : null;
    }
    function createRunnerYieldScheduler(channel = new MessageChannel()) {
      const pending = [];
      channel.port1.onmessage = () => {
        const resolve = pending.shift();
        if (resolve !== undefined) resolve();
      };
      return restMs => {
        if (restMs > 0) {
          return new Promise(resolve => setTimeout(resolve, restMs));
        }
        return new Promise(resolve => {
          pending.push(resolve);
          channel.port2.postMessage(0);
        });
      };
    }
    const yieldRunnerTask = createRunnerYieldScheduler();
    const recentPcs = [];
    const regionsByPc = new Map();
    const regionCandidateHits = new Map();
    const regionFusionHits = new Map();
    const regionFusionHitThreshold = 8;
    const maximumFusedRegionBlocks = 96;
    const blockPattern = Object.freeze({
      idleBasic: 2,
      idleVolatileRead: 3,
    });
    const hookCalls = new Map();
    const deviceEvents = new Map();
    const dspTrace = [];
    const accelerations = new Map();
    const exceptionCounts = new Map();
    const exceptionFirstTrace = [];
    const exceptionTrace = [];
    const exceptionFirstByVector = {};
    let firstDsi = null;
    let lastUnmappedAccess = null;
    let lockedCacheReads = 0;
    let lockedCacheReadBytes = 0;
    let lockedCacheWrites = 0;
    let lockedCacheWriteBytes = 0;
    let lockedCacheDmaToRam = 0;
    let lockedCacheDmaFromRam = 0;
    let lockedCacheDmaBytes = 0;
    const lockedCacheDmaSample = [];
    const gxFifoScratch = new DataView(new ArrayBuffer(8));
    const gxFifoSample = [];
    let gxDecodeBuffer = [];
    const gxCpRegisters = new Uint32Array(256);
    const gxBpRegisters = new Uint32Array(256);
    const gxXfRegisters = new Uint32Array(0x1058);
    const gxTevColorRegisters = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    const gxTevKonstRegisters = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    gxBpRegisters[0xf3] = 0x003f0000;
    gxBpRegisters[0xfe] = 0x00ffffff;
    const gxXfbCopies = [];
    const gxTextureCopies = [];
    const gxPrimitiveSamples = [];
    const gxRecentPrimitiveSamples = [];
    const gxTextureCacheByteLimit = 16 * 1024 * 1024;
    const gxTevTextureCacheByteLimit = 16 * 1024 * 1024;
    const gxTextureCache = createWeightedLruCache(
      64,
      gxTextureCacheByteLimit,
      texture => texture.pixels.byteLength
    );
    const gxTevTextureCache = createWeightedLruCache(
      64,
      gxTevTextureCacheByteLimit,
      texture => texture.pixels.byteLength
    );
    // The index here must identify an EFB canvas that was actually sent to the
    // browser. Sparse presentation skips most copy generations; advancing this
    // map for an uncaptured copy makes the browser reject its last valid canvas
    // and fall back to stale RAM texture bytes.
    const gxTextureCopyDestinations = new Map();
    const gxTextureCopyConsumers = new Map();
    const gxTextureFormatCounts = new Map();
    const gxTevModeCounts = new Map();
    const gxTmem = new Uint8Array(1024 * 1024);
    let gxFrameDraws = [];
    let gxFrameDrawVertices = 0;
    let gxFrameSkippedPrimitives = 0;
    let gxCollectFrameGeometry = true;
    let gxXfbCopyCount = 0;
    let gxTextureCopyCount = 0;
    let gxTextureCopyFramesPresented = 0;
    let gxTextureCopyCaptureThroughXfb = 0;
    let gxTextureCopyCaptureArms = 0;
    let gxTextureCopyCaptureDeferrals = 0;
    let gxTextureCopyProducerPreArms = 0;
    let gxTextureCopyProducerLateArms = 0;
    let gxTextureCopyProducerRecoveryArms = 0;
    let gxTextureCopyCapturedSurfacesRetained = 0;
    let gxDecodedCommands = 0;
    let gxCpLoads = 0;
    let gxXfLoads = 0;
    let gxBpLoads = 0;
    let gxIndexedXfLoads = 0;
    let gxDisplayLists = 0;
    let gxDisplayListBytes = 0;
    let gxPrimitives = 0;
    let gxVertices = 0;
    let gxDecodedVertices = 0;
    let gxProjectedVertices = 0;
    let gxDroppedVertices = 0;
    let gxDisplayListErrors = 0;
    let gxVertexDecodeErrors = 0;
    let gxUnknownOpcodes = 0;
    let gxTextureDecodes = 0;
    let gxTextureCacheHits = 0;
    let gxTextureDecodedBytes = 0;
    let gxTextureDecodeErrors = 0;
    let gxTevTextureCacheHits = 0;
    let gxTexgenTransforms = 0;
    let gxTexgenFallbacks = 0;
    let gxTexturedDraws = 0;
    let gxTlutLoads = 0;
    let gxTlutBytes = 0;
    let gxTlutErrors = 0;
    let gxXfbFramesCaptured = 0;
    let gxFramesPresented = 0;
    let gxFramesSkipped = 0;
    let gxSkippedFrameClearColor = null;
    let gxSkippedGeometryPrimitives = 0;
    let gxSkippedGeometryVertices = 0;
    let gxUncollectedNonClearingFrames = 0;
    let gxFifoQuantizedStores = 0;
    let gxFifoStores = 0;
    let gxFifoBytes = 0;
    let gxFifoHash = 0x811c9dc5;
    let gxFifoStagingDrains = 0;
    let gxFifoStagingStores = 0;
    let gxFifoStagingBytes = 0;
    let gxFifoStagingQuantizedStores = 0;
    let peFinishCycle = null;
    let peFinishSignal = false;
    let peFinishInterruptDelivered = false;
    const viInterruptOffsets = [0x2030, 0x2034, 0x2038, 0x203c];
    const viClockFrequencies = [27_000_000, 54_000_000];
    const viCpuCyclesPerSecond = 486_000_000;
    const viSiPollHalfLines = 15;
    const timeBaseRatio = 12;
    let viTiming = null;
    let viTimingSignature = null;
    let viComparatorSignature = null;
    let viSerialPollSignature = null;
    let viScheduleDirty = true;
    let viEpochCycle = 0;
    let viEpochHalfLine = 0;
    let nextViCycle = null;
    let nextViPresentCycle = null;
    let nextSerialPollCycle = null;
    let viLastEventCycle = null;
    let viLastEventInterval = null;
    let viTimingReschedules = 0;
    let viMissedHalfLines = 0;
    let viPiDeliveries = 0;
    let viPresentationCount = 0;
    let viLastPresentationCycle = null;
    let viLastPresentationField = null;
    let viLastPresentationAddress = 0;
    const viComparatorMatches = [0, 0, 0, 0];
    const viStatusAssertions = [0, 0, 0, 0];
    const viInterruptAcknowledgements = [0, 0, 0, 0];
    const viPreviousInterruptRaw = [0, 0, 0, 0];
    const viTrace = [];
    let decrementerLastCycle = 0;
    let nextDecrementerCycle = null;
    let decrementerPending = false;
    let diskTransfer = null;
    let serialTransfer = null;
    let aiSampleCounter = 0;
    let aiLastCycle = 0;
    let aiInterruptDelivered = false;
    const dspMailQueue = [];
    let dspCurrentMail = null;
    let dspCpuMailbox = 0;
    let dspRomParameter = null;
    let dspMode = "rom";
    let dspUcodeBooted = false;
    let dspAxCommandListPending = false;
    let dspScheduledMail = null;
    const dspAudioDmaEnableInterruptLatencyCycles = 200;
    let dspAudioDmaRemainingBlocks = 0;
    let nextDspAudioDmaCycle = null;
    let nextDspAudioDmaInterruptCycle = null;
    const aram = new Uint8Array(0x01000000);
    let aramTransfer = null;
    let diskReadBytes = 0;
    let diskReadHash = 0x811c9dc5;
    let diskHashedBytes = 0;
    let diskLastError = 0;
    let diskDriveState = 0;
    let diskAudioEnabled = boot.audioStreaming !== 0;
    let diskAudioBufferLength = boot.streamBufferSize;
    let diskAudioStreaming = false;
    let diskAudioStopAtTrackEnd = false;
    let diskAudioPosition = 0;
    let diskAudioStart = 0;
    let diskAudioLength = 0;
    let diskAudioNextStart = 0;
    let diskAudioNextLength = 0;
    let nextDiskAudioCycle = null;
    const diskCommandCounts = new Map();
    const diskCommandTrace = [];
    let regionRunning = false;
    let regionContinuableHookCalls = 0;
    const hookFunctions = {
      user_0_3: (_ctx, address, pointer) => readInteger(address, pointer, 1),
      user_0_4: (_ctx, address, pointer) => readInteger(address, pointer, 2),
      user_0_5: (_ctx, address, pointer) => readInteger(address, pointer, 4),
      user_0_6: (_ctx, address, pointer) => readInteger(address, pointer, 8),
      user_0_7: (_ctx, address, value) => writeInteger(address, value, 1),
      user_0_8: (_ctx, address, value) => writeInteger(address, value, 2),
      user_0_9: (_ctx, address, value) => writeInteger(address, value, 4),
      user_0_10: (_ctx, address, value) => writeInteger(address, value, 8),
      user_0_11: (_ctx, address, gqr, pointer) => readQuantized(address, gqr, pointer),
      user_0_12: (_ctx, address, gqr, value) => writeQuantized(address, gqr, value),
      user_0_15: () => serviceLockedCacheDma(),
      user_0_19: () => updateTimeBase(),
      user_0_20: () => timeBaseChanged(),
      user_0_21: () => updateDecrementer(cycles),
      user_0_22: () => decrementerChanged(),
      user_1_0: (registers, exception) => raiseException(registers, exception),
    };

    function regionHookCanContinue(name, arguments_, result) {
      let size;
      switch (name) {
        case "user_0_3": case "user_0_7": size = 1; break;
        case "user_0_4": case "user_0_8": size = 2; break;
        case "user_0_5": case "user_0_9": size = 4; break;
        case "user_0_6": case "user_0_10": size = 8; break;
        case "user_0_11": case "user_0_12": size = Number(result); break;
        default: return false;
      }
      if (![1, 2, 4, 8].includes(size)) return false;

      const address = Number(arguments_[1]) >>> 0;
      return ramPointer(address, size) !== null || lockedCachePointer(address, size) !== null;
    }

    const hooks = new Proxy(hookFunctions, {
      get(target, name) {
        return (...arguments_) => {
          drainGxFifoStaging();
          hookCalls.set(name, (hookCalls.get(name) ?? 0) + 1);
          if (!regionRunning) return target[name]?.(...arguments_) ?? 0;

          const baseCycles = cycles;
          cycles += view.getUint32(regionControl, true);
          try {
            const result = target[name]?.(...arguments_) ?? 0;
            if (regionHookCanContinue(name, arguments_, result)) {
              regionContinuableHookCalls += 1;
            } else {
              view.setUint32(regionControl + 4, 1, true);
            }
            return result;
          } finally {
            cycles = baseCycles;
          }
        };
      },
    });

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

    function dolU32(offset) {
      return new DataView(dol.buffer, dol.byteOffset, dol.byteLength).getUint32(offset, false);
    }

    function physicalOffset(logical) {
      const address = logical >>> 0;
      if (address >= 0x80000000 && address < 0x81800000) return address - 0x80000000;
      if (address >= 0xc0000000 && address < 0xc1800000) return address - 0xc0000000;
      throw new Error("address is outside mapped main RAM: 0x" + address.toString(16));
    }

    function ramPointer(address, size) {
      const logical = address >>> 0;
      let physical;
      if (logical < ramSize) {
        physical = logical;
      } else {
        try {
          physical = physicalOffset(logical);
        } catch (_error) {
          return null;
        }
      }
      if (physical + size > ramSize) return null;
      return ram + physical;
    }

    function mmioPointer(address, size) {
      const logical = address >>> 0;
      if (logical < 0xcc000000 || logical + size > 0xcc000000 + mmioSize) return null;
      return mmio + logical - 0xcc000000;
    }

    function lockedCachePointer(address, size) {
      const logical = address >>> 0;
      const offset = logical - 0xe0000000;
      if (offset < 0 || offset + size > lockedCacheSize) return null;
      return lockedCache + offset;
    }

    function copyFromLockedCache(target, cacheAddress, length) {
      let copied = 0;
      while (copied < length) {
        const offset = (cacheAddress + copied) & (lockedCacheSize - 1);
        const chunk = Math.min(length - copied, lockedCacheSize - offset);
        bytes.set(
          bytes.subarray(lockedCache + offset, lockedCache + offset + chunk),
          target + copied
        );
        copied += chunk;
      }
    }

    function copyToLockedCache(cacheAddress, source, length) {
      let copied = 0;
      while (copied < length) {
        const offset = (cacheAddress + copied) & (lockedCacheSize - 1);
        const chunk = Math.min(length - copied, lockedCacheSize - offset);
        bytes.set(
          bytes.subarray(source + copied, source + copied + chunk),
          lockedCache + offset
        );
        copied += chunk;
      }
    }

    function serviceLockedCacheDma() {
      const upper = view.getUint32(cpu + dmaUpperOffset, true);
      const lower = view.getUint32(cpu + dmaLowerOffset, true);
      if ((lower & 2) === 0) {
        if ((lower & 1) !== 0) {
          view.setUint32(cpu + dmaLowerOffset, lower & ~1, true);
          deviceEvents.set(
            "lockedCacheDmaFlush",
            (deviceEvents.get("lockedCacheDmaFlush") ?? 0) + 1
          );
        }
        return;
      }

      const memAddress = (upper & 0xffffffe0) >>> 0;
      const cacheAddress = (lower & 0xffffffe0) >>> 0;
      const encodedBlocks = ((upper & 0x1f) << 2) | ((lower >>> 2) & 3);
      const blocks = encodedBlocks === 0 ? 128 : encodedBlocks;
      const length = blocks * 32;
      const fromRam = (lower & 0x10) !== 0;
      const ramTarget = ramPointer(memAddress, length);

      if (ramTarget === null) {
        lastUnmappedAccess = {
          kind: "locked-cache-dma",
          direction: fromRam ? "ram-to-cache" : "cache-to-ram",
          address: hex32(memAddress),
          cacheAddress: hex32(cacheAddress),
          size: length,
          pc: hex32(view.getUint32(cpu + pcOffset, true)),
          dispatch: dispatches,
        };
        deviceEvents.set(
          "lockedCacheDmaUnmappedRam",
          (deviceEvents.get("lockedCacheDmaUnmappedRam") ?? 0) + 1
        );
      } else {
        if (fromRam) {
          copyToLockedCache(cacheAddress, ramTarget, length);
          lockedCacheDmaFromRam += 1;
        } else {
          copyFromLockedCache(ramTarget, cacheAddress, length);
          lockedCacheDmaToRam += 1;
        }
        lockedCacheDmaBytes += length;
        if (lockedCacheDmaSample.length < 32) {
          lockedCacheDmaSample.push({
            direction: fromRam ? "ram-to-cache" : "cache-to-ram",
            memAddress: hex32(memAddress),
            cacheAddress: hex32(cacheAddress),
            blocks,
            bytes: length,
            pc: hex32(view.getUint32(cpu + pcOffset, true)),
          });
        }
        deviceEvents.set(
          fromRam ? "lockedCacheDmaFromRam" : "lockedCacheDmaToRam",
          (deviceEvents.get(fromRam ? "lockedCacheDmaFromRam" : "lockedCacheDmaToRam") ?? 0) + 1
        );
      }

      view.setUint32(cpu + dmaLowerOffset, lower & ~3, true);
    }

    function gxReadU32(source, offset) {
      return (
        source[offset] * 0x01000000
        + (source[offset + 1] << 16)
        + (source[offset + 2] << 8)
        + source[offset + 3]
      ) >>> 0;
    }

    function gxReadU16(source, offset) {
      return (source[offset] << 8) | source[offset + 1];
    }

    function gxReadFloat32(source, offset) {
      gxFifoScratch.setUint32(0, gxReadU32(source, offset), false);
      return gxFifoScratch.getFloat32(0, false);
    }

    function gxXfFloat(address) {
      gxFifoScratch.setUint32(0, gxXfRegisters[address], false);
      return gxFifoScratch.getFloat32(0, false);
    }

    function gxXfMatrixRow(baseAddress, rowIndex) {
      const address = baseAddress + rowIndex * 4;
      if (address < 0 || address + 3 >= gxXfRegisters.length) return null;
      const row = Array.from({ length: 4 }, (_unused, index) =>
        gxXfFloat(address + index)
      );
      return row.every(Number.isFinite) ? row : null;
    }

    function gxDot4(row, vector) {
      return row[0] * vector[0] + row[1] * vector[1]
        + row[2] * vector[2] + row[3] * vector[3];
    }

    function gxNormalize3(vector) {
      if (vector === null || vector === undefined || vector.length < 3) return null;
      const length = Math.hypot(vector[0], vector[1], vector[2]);
      if (!Number.isFinite(length) || length < 1e-12) return [0, 0, 0];
      return [vector[0] / length, vector[1] / length, vector[2] / length];
    }

    function gxTransformPosition(position, matrixIndex) {
      if ((matrixIndex + 2) * 4 + 3 >= 0x100) return null;
      const matrix = Array.from({ length: 12 }, (_unused, index) =>
        gxXfFloat(matrixIndex * 4 + index)
      );
      if (matrix.some(value => !Number.isFinite(value)) || matrix.every(value => value === 0)) {
        return null;
      }
      const [x, y, z] = position;
      return [
        matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3],
        matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7],
        matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11],
      ];
    }

    function gxTransformNormal(vector, matrixIndex) {
      if (vector === null || vector === undefined) return null;
      const base = 0x400 + (matrixIndex % 32) * 3;
      if (base + 8 >= gxXfRegisters.length) return null;
      const matrix = Array.from({ length: 9 }, (_unused, index) =>
        gxXfFloat(base + index)
      );
      if (matrix.some(value => !Number.isFinite(value)) || matrix.every(value => value === 0)) {
        return null;
      }
      return gxNormalize3([
        matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
        matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
        matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2],
      ]);
    }

    function gxTransformTexCoord(attributes, matrixIndex, texgenIndex) {
      if (texgenIndex < 0 || texgenIndex >= 8) return null;
      const texgenCount = gxXfRegisters[0x103f] & 0xf;
      if (texgenIndex >= texgenCount) return null;
      const info = gxXfRegisters[0x1040 + texgenIndex] >>> 0;
      const projection = (info >>> 1) & 1;
      const inputForm = (info >>> 2) & 1;
      const texgenType = (info >>> 4) & 3;
      const sourceRow = (info >>> 7) & 0x1f;
      let source;
      if (sourceRow === 0) source = attributes.position;
      if (sourceRow === 1) source = attributes.normal;
      if (sourceRow === 2) {
        source = attributes.colors[texgenType === 3 ? 1 : 0];
      }
      if (sourceRow === 3) source = attributes.tangent;
      if (sourceRow === 4) source = attributes.binormal;
      if (sourceRow >= 5 && sourceRow <= 12) {
        source = attributes.rawTextureCoords[sourceRow - 5];
      }
      if (source === null || source === undefined) return null;

      const input = inputForm === 0
        ? [source[0] ?? 0, source[1] ?? 0, 1, 1]
        : [source[0] ?? 0, source[1] ?? 0, source[2] ?? 0, 1];
      let transformed;
      if (texgenType === 0) {
        const row0 = gxXfMatrixRow(0, matrixIndex);
        const row1 = gxXfMatrixRow(0, matrixIndex + 1);
        const row2 = gxXfMatrixRow(0, matrixIndex + 2);
        if (row0 === null || row1 === null || row2 === null) return null;
        transformed = [gxDot4(row0, input), gxDot4(row1, input), gxDot4(row2, input)];
      } else if (texgenType === 1) {
        // Emboss texgen is not used by either browser bring-up title yet. GX's
        // base operation leaves its selected source available to the post matrix.
        transformed = input.slice(0, 3);
      } else {
        transformed = [source[0] ?? 0, source[1] ?? 0, 1];
      }
      let result = projection === 0
        ? [transformed[0], transformed[1], 1]
        : transformed;
      if ((gxXfRegisters[0x1012] & 1) !== 0) {
        const postInfo = gxXfRegisters[0x1050 + texgenIndex] >>> 0;
        if ((postInfo & 0x100) !== 0) {
          result = gxNormalize3(result);
        }
        const postIndex = postInfo & 0x3f;
        const post0 = gxXfMatrixRow(0x500, postIndex);
        const post1 = gxXfMatrixRow(0x500, (postIndex + 1) & 0x3f);
        const post2 = gxXfMatrixRow(0x500, (postIndex + 2) & 0x3f);
        if (post0 === null || post1 === null || post2 === null) {
          return null;
        }
        result = [
          post0[0] * result[0] + post0[1] * result[1]
            + post0[2] * result[2] + post0[3],
          post1[0] * result[0] + post1[1] * result[1]
            + post1[2] * result[2] + post1[3],
          post2[0] * result[0] + post2[1] * result[1]
            + post2[2] * result[2] + post2[3],
        ];
      }
      if (!result.every(Number.isFinite)) return null;
      gxTexgenTransforms += 1;
      return result;
    }

    function gxAttributeStatus(index) {
      return index < 4
        ? (gxCpRegisters[0x50] >>> (9 + index * 2)) & 3
        : (gxCpRegisters[0x60] >>> ((index - 4) * 2)) & 3;
    }

    function gxComponentBytes(format) {
      return format <= 1 ? 1 : format <= 3 ? 2 : 4;
    }

    function gxAttributeBytes(status, directBytes) {
      if (status === 0) return 0;
      if (status === 1) return directBytes;
      return status === 2 ? 1 : 2;
    }

    function viXfbAddressFromRaw(value, topValue) {
      const base = value & 0x00ffffff;
      // VI exposes one POFF line shared by TFBL and BFBL. When asserted,
      // both packed 24-bit framebuffer bases are expressed in 32-byte units.
      return (topValue & 0x10000000) !== 0 ? (base << 5) >>> 0 : base;
    }

    function viXfbAddress(offset) {
      return viXfbAddressFromRaw(
        view.getUint32(mmio + offset, false),
        view.getUint32(mmio + 0x201c, false)
      );
    }

    function gxVertexSize(vatIndex) {
      const descriptorLow = gxCpRegisters[0x50];
      const vat0 = gxCpRegisters[0x70 + vatIndex];
      const vat1 = gxCpRegisters[0x80 + vatIndex];
      const vat2 = gxCpRegisters[0x90 + vatIndex];
      let size = 0;
      let matrixIndexes = descriptorLow & 0x1ff;
      while (matrixIndexes !== 0) {
        size += matrixIndexes & 1;
        matrixIndexes >>>= 1;
      }

      const positionStatus = gxAttributeStatus(0);
      const positionElements = (vat0 & 1) + 2;
      const positionFormat = (vat0 >>> 1) & 7;
      size += gxAttributeBytes(
        positionStatus,
        positionElements * gxComponentBytes(positionFormat)
      );

      const normalStatus = gxAttributeStatus(1);
      const normalElements = (vat0 >>> 9) & 1;
      const normalFormat = (vat0 >>> 10) & 7;
      if (normalStatus === 1) {
        size += (normalElements === 0 ? 3 : 9) * gxComponentBytes(normalFormat);
      } else if (normalStatus >= 2) {
        const indexBytes = normalStatus === 2 ? 1 : 2;
        size += normalElements !== 0 && (vat0 & 0x80000000) !== 0
          ? indexBytes * 3
          : indexBytes;
      }

      for (let color = 0; color < 2; color += 1) {
        const status = gxAttributeStatus(2 + color);
        const format = (vat0 >>> (14 + color * 4)) & 7;
        const directBytes = [2, 3, 4, 2, 3, 4][format] ?? 0;
        size += gxAttributeBytes(status, directBytes);
      }

      const textureAttributes = [
        [(vat0 >>> 21) & 1, (vat0 >>> 22) & 7],
        [vat1 & 1, (vat1 >>> 1) & 7],
        [(vat1 >>> 9) & 1, (vat1 >>> 10) & 7],
        [(vat1 >>> 18) & 1, (vat1 >>> 19) & 7],
        [(vat1 >>> 27) & 1, (vat1 >>> 28) & 7],
        [(vat2 >>> 5) & 1, (vat2 >>> 6) & 7],
        [(vat2 >>> 14) & 1, (vat2 >>> 15) & 7],
        [(vat2 >>> 23) & 1, (vat2 >>> 24) & 7],
      ];
      for (let texture = 0; texture < 8; texture += 1) {
        const status = gxAttributeStatus(4 + texture);
        const [elements, format] = textureAttributes[texture];
        size += gxAttributeBytes(status, (elements + 1) * gxComponentBytes(format));
      }
      return size;
    }

    function gxReadComponent(source, offset, format) {
      switch (format) {
        case 0: return source[offset];
        case 1: return (source[offset] << 24) >> 24;
        case 2: return gxReadU16(source, offset);
        case 3: return (gxReadU16(source, offset) << 16) >> 16;
        case 4: return gxReadFloat32(source, offset);
        default: return Number.NaN;
      }
    }

    function gxAttributeSource(source, cursor, status, arrayIndex, directBytes) {
      if (status === 0) return { source: null, offset: 0, cursor };
      if (status === 1) return { source, offset: cursor, cursor: cursor + directBytes };
      const indexBytes = status === 2 ? 1 : 2;
      const index = indexBytes === 1 ? source[cursor] : gxReadU16(source, cursor);
      const next = cursor + indexBytes;
      if (index === (indexBytes === 1 ? 0xff : 0xffff)) {
        return { source: null, offset: 0, cursor: next, skipped: true };
      }
      const base = gxCpRegisters[0xa0 + arrayIndex] >>> 0;
      const stride = gxCpRegisters[0xb0 + arrayIndex] & 0xff;
      const pointer = ramPointer((base + index * stride) >>> 0, directBytes);
      return pointer === null
        ? { source: null, offset: 0, cursor: next, invalid: true }
        : { source: bytes, offset: pointer, cursor: next };
    }

    function gxDecodeColor(source, offset, format) {
      const expand4 = value => (value << 4) | value;
      const expand5 = value => (value << 3) | (value >>> 2);
      const expand6 = value => (value << 2) | (value >>> 4);
      switch (format) {
        case 0: {
          const value = gxReadU16(source, offset);
          return [
            expand5(value >>> 11),
            expand6((value >>> 5) & 0x3f),
            expand5(value & 0x1f),
            0xff,
          ];
        }
        case 1: return [source[offset], source[offset + 1], source[offset + 2], 0xff];
        case 2: return [source[offset], source[offset + 1], source[offset + 2], 0xff];
        case 3: {
          const value = gxReadU16(source, offset);
          return [
            expand4(value >>> 12),
            expand4((value >>> 8) & 0xf),
            expand4((value >>> 4) & 0xf),
            expand4(value & 0xf),
          ];
        }
        case 4: {
          const value = (
            source[offset] * 0x10000 + (source[offset + 1] << 8) + source[offset + 2]
          ) >>> 0;
          return [
            expand6(value >>> 18),
            expand6((value >>> 12) & 0x3f),
            expand6((value >>> 6) & 0x3f),
            expand6(value & 0x3f),
          ];
        }
        case 5: return [
          source[offset], source[offset + 1], source[offset + 2], source[offset + 3],
        ];
        default: return [0xff, 0xff, 0xff, 0xff];
      }
    }

    function gxDecodeNormalAttribute(
      source, cursor, status, elements, format, separateIndices
    ) {
      const empty = next => ({
        cursor: next,
        normal: null,
        tangent: null,
        binormal: null,
        skipped: false,
      });
      if (status === 0) return empty(cursor);
      const componentBytes = gxComponentBytes(format);
      const scale = format <= 1 ? 2 ** -6 : format <= 3 ? 2 ** -14 : 1;
      const vectorCount = elements === 0 ? 1 : 3;
      const readVector = (data, offset) => {
        const vector = Array.from({ length: 3 }, (_unused, component) =>
          gxReadComponent(data, offset + component * componentBytes, format) * scale
        );
        return vector.every(Number.isFinite) ? vector : null;
      };
      let next = cursor;
      let vectors = [];
      if (status === 1) {
        vectors = Array.from({ length: vectorCount }, (_unused, index) =>
          readVector(source, cursor + index * 3 * componentBytes)
        );
        next += vectorCount * 3 * componentBytes;
      } else {
        const indexBytes = status === 2 ? 1 : 2;
        const indexCount = vectorCount === 3 && separateIndices ? 3 : 1;
        const indexes = Array.from({ length: indexCount }, () => {
          const index = indexBytes === 1 ? source[next] : gxReadU16(source, next);
          next += indexBytes;
          return index;
        });
        const sentinel = indexBytes === 1 ? 0xff : 0xffff;
        if (indexes.some(index => index === sentinel)) {
          return { ...empty(next), skipped: true };
        }
        const base = gxCpRegisters[0xa1] >>> 0;
        const stride = gxCpRegisters[0xb1] & 0xff;
        if (indexCount === 3) {
          vectors = indexes.map(index => {
            const pointer = ramPointer((base + index * stride) >>> 0, 3 * componentBytes);
            return pointer === null ? null : readVector(bytes, pointer);
          });
        } else {
          const pointer = ramPointer(
            (base + indexes[0] * stride) >>> 0,
            vectorCount * 3 * componentBytes
          );
          vectors = pointer === null
            ? Array(vectorCount).fill(null)
            : Array.from({ length: vectorCount }, (_unused, index) =>
              readVector(bytes, pointer + index * 3 * componentBytes)
            );
        }
      }
      if (vectors.some(vector => vector === null)) {
        return { ...empty(next), skipped: true };
      }
      return {
        cursor: next,
        normal: vectors[0],
        binormal: vectors[1] ?? null,
        tangent: vectors[2] ?? null,
        skipped: false,
      };
    }

    function gxXfColor(address) {
      const value = gxXfRegisters[address] >>> 0;
      return [
        (value >>> 24) / 255,
        ((value >>> 16) & 0xff) / 255,
        ((value >>> 8) & 0xff) / 255,
        (value & 0xff) / 255,
      ];
    }

    function gxXfLight(index) {
      const base = 0x603 + index * 0x10;
      if (base + 12 >= gxXfRegisters.length) return null;
      const light = {
        color: gxXfColor(base),
        cosAtten: Array.from({ length: 3 }, (_unused, component) =>
          gxXfFloat(base + 1 + component)
        ),
        distAtten: Array.from({ length: 3 }, (_unused, component) =>
          gxXfFloat(base + 4 + component)
        ),
        position: Array.from({ length: 3 }, (_unused, component) =>
          gxXfFloat(base + 7 + component)
        ),
        direction: Array.from({ length: 3 }, (_unused, component) =>
          gxXfFloat(base + 10 + component)
        ),
      };
      return Object.values(light).flat().every(Number.isFinite) ? light : null;
    }

    function gxDot3(left, right) {
      return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
    }

    function gxVectorSubtract(left, right) {
      return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
    }

    function gxLightDiffuse(control, light, position, normal) {
      const mode = (control >>> 7) & 3;
      if (mode === 0 || mode === 3) return 1;
      const vertexToLight = gxVectorSubtract(light.position, position);
      const length = Math.hypot(...vertexToLight);
      const value = length < 1e-12 ? 0 : gxDot3(vertexToLight, normal) / length;
      return mode === 2 ? Math.max(value, 0) : value;
    }

    function gxPolynomial(coefficients, value) {
      return coefficients[0] + value * coefficients[1] + value * value * coefficients[2];
    }

    function gxLightPosition(control, light, position, normal) {
      if ((control & (1 << 9)) === 0) return 1;
      let angularValue;
      let distanceValue;
      if ((control & (1 << 10)) === 0) {
        const lightDirection = gxNormalize3(light.position) ?? [0, 0, 0];
        const normalDotLight = gxDot3(normal, lightDirection);
        angularValue = normalDotLight > 0
          ? Math.max(gxDot3(normal, light.direction), 0)
          : 0;
        distanceValue = angularValue;
      } else {
        const vertexToLight = gxVectorSubtract(light.position, position);
        const direction = gxNormalize3(vertexToLight) ?? [0, 0, 0];
        angularValue = Math.max(gxDot3(direction, light.direction), 0);
        distanceValue = Math.hypot(...vertexToLight);
      }
      const numerator = Math.max(gxPolynomial(light.cosAtten, angularValue), 0);
      const denominator = gxPolynomial(light.distAtten, distanceValue);
      return Math.abs(denominator) < 1e-12 ? 0 : numerator / denominator;
    }

    function gxChannelLightEnabled(control, lightIndex) {
      return lightIndex < 4
        ? ((control >>> (2 + lightIndex)) & 1) !== 0
        : ((control >>> (11 + lightIndex - 4)) & 1) !== 0;
    }

    function gxLightChannelComponent(
      control, component, material, ambient, vertexColor, position, normal
    ) {
      const materialValue = (control & 1) !== 0 ? vertexColor[component] : material[component];
      if ((control & 2) === 0) return materialValue;
      let lightFunction = (control & (1 << 6)) !== 0
        ? vertexColor[component]
        : ambient[component];
      for (let lightIndex = 0; lightIndex < 8; lightIndex += 1) {
        if (!gxChannelLightEnabled(control, lightIndex)) continue;
        const light = gxXfLight(lightIndex);
        if (light === null) continue;
        lightFunction += light.color[component]
          * gxLightDiffuse(control, light, position, normal)
          * gxLightPosition(control, light, position, normal);
      }
      return materialValue * Math.max(0, Math.min(1, lightFunction));
    }

    function gxLightRasterChannels(position, normal, colors) {
      const transformedNormal = normal ?? [0, 0, 0];
      return Array.from({ length: 2 }, (_unused, channel) => {
        const vertexColor = colors[channel].map(value => value / 255);
        const material = gxXfColor(0x100c + channel);
        const ambient = gxXfColor(0x100a + channel);
        const colorControl = gxXfRegisters[0x100e + channel] >>> 0;
        const alphaControl = gxXfRegisters[0x1010 + channel] >>> 0;
        return [
          gxLightChannelComponent(
            colorControl, 0, material, ambient, vertexColor, position, transformedNormal
          ),
          gxLightChannelComponent(
            colorControl, 1, material, ambient, vertexColor, position, transformedNormal
          ),
          gxLightChannelComponent(
            colorControl, 2, material, ambient, vertexColor, position, transformedNormal
          ),
          gxLightChannelComponent(
            alphaControl, 3, material, ambient, vertexColor, position, transformedNormal
          ),
        ];
      });
    }

    function gxTextureRegisters(textureMap) {
      const slot = textureMap & 3;
      const bank = textureMap >= 4 ? 0x20 : 0;
      return {
        mode0: 0x80 + bank + slot,
        image0: 0x88 + bank + slot,
        image3: 0x94 + bank + slot,
        tlut: 0x98 + bank + slot,
      };
    }

    function gxRecordTextureCopyGeneration(address, index, captured) {
      if (!captured) {
        if (gxTextureCopyDestinations.has(address)) {
          gxTextureCopyCapturedSurfacesRetained += 1;
        }
        return;
      }
      gxTextureCopyDestinations.delete(address);
      gxTextureCopyDestinations.set(address, index);
      if (gxTextureCopyDestinations.size > 64) {
        gxTextureCopyDestinations.delete(gxTextureCopyDestinations.keys().next().value);
      }
    }

    function gxRememberTextureCopyConsumer(address) {
      gxTextureCopyConsumers.delete(address);
      gxTextureCopyConsumers.set(address, gxXfbCopyCount);
      if (gxTextureCopyConsumers.size > 128) {
        gxTextureCopyConsumers.delete(gxTextureCopyConsumers.keys().next().value);
      }
    }

    function gxShouldCollectNextXfb() {
      const nextFrame = gxXfbCopyCount + 1;
      return nextFrame <= 4
        || nextFrame % runnerRenderEvery === 0
        || nextFrame <= gxTextureCopyCaptureThroughXfb;
    }

    function gxPrearmTextureCopyProducer(address) {
      if (!gxTextureCopyConsumers.has(address)) return false;
      if (gxFrameSkippedPrimitives !== 0) {
        gxTextureCopyProducerLateArms += 1;
        return false;
      }
      gxTextureCopyProducerPreArms += 1;
      gxCollectFrameGeometry = true;
      return true;
    }

    function gxMarkTextureCopyConsumer(address) {
      // Texture image registers can point at an EFB-copy destination before its
      // first copy exists. Remember that prospective consumer so the matching
      // copy producer can arm geometry collection before drawing its source.
      gxRememberTextureCopyConsumer(address);
      if (!gxTextureCopyDestinations.has(address)) return false;
      const nextXfbCopy = gxXfbCopyCount + 1;
      const framesUntilSample = nextXfbCopy <= 4 || runnerRenderEvery <= 1
        ? 0
        : (runnerRenderEvery - (nextXfbCopy % runnerRenderEvery)) % runnerRenderEvery;
      // A copied EFB surface only needs to be current when its consuming XFB
      // frame will be presented. Re-arming on every texture lookup otherwise
      // defeats renderEvery and makes sparse browser rendering fully sampled.
      if (framesUntilSample > 4) {
        gxTextureCopyCaptureDeferrals += 1;
        return true;
      }
      gxTextureCopyCaptureArms += 1;
      gxTextureCopyCaptureThroughXfb = Math.max(
        gxTextureCopyCaptureThroughXfb,
        gxXfbCopyCount + 4
      );
      gxCollectFrameGeometry = true;
      return true;
    }

    function gxTextureCopyIsBound(address) {
      for (let textureMap = 0; textureMap < 8; textureMap += 1) {
        const registers = gxTextureRegisters(textureMap);
        if ((gxBpRegisters[registers.image3] << 5) >>> 0 === address) return true;
      }
      return false;
    }

    function gxTextureLayout(format) {
      switch (format) {
        case 0: return { name: "I4", blockWidth: 8, blockHeight: 8, blockBytes: 32 };
        case 1: return { name: "I8", blockWidth: 8, blockHeight: 4, blockBytes: 32 };
        case 2: return { name: "IA4", blockWidth: 8, blockHeight: 4, blockBytes: 32 };
        case 3: return { name: "IA8", blockWidth: 4, blockHeight: 4, blockBytes: 32 };
        case 4: return { name: "RGB565", blockWidth: 4, blockHeight: 4, blockBytes: 32 };
        case 5: return { name: "RGB5A3", blockWidth: 4, blockHeight: 4, blockBytes: 32 };
        case 6: return { name: "RGBA8", blockWidth: 4, blockHeight: 4, blockBytes: 64 };
        case 8: return { name: "C4", blockWidth: 8, blockHeight: 8, blockBytes: 32 };
        case 9: return { name: "C8", blockWidth: 8, blockHeight: 4, blockBytes: 32 };
        case 10: return { name: "C14X2", blockWidth: 4, blockHeight: 4, blockBytes: 32 };
        case 14: return { name: "CMPR", blockWidth: 8, blockHeight: 8, blockBytes: 32 };
        default: return null;
      }
    }

    function gxExpand3(value) {
      return (value << 5) | (value << 2) | (value >>> 1);
    }

    function gxExpand4(value) {
      return (value << 4) | value;
    }

    function gxExpand5(value) {
      return (value << 3) | (value >>> 2);
    }

    function gxExpand6(value) {
      return (value << 2) | (value >>> 4);
    }

    function gxTexturePixel(pixels, width, height, x, y, red, green, blue, alpha) {
      if (x >= width || y >= height) return;
      const output = (y * width + x) * 4;
      pixels[output] = red;
      pixels[output + 1] = green;
      pixels[output + 2] = blue;
      pixels[output + 3] = alpha;
    }

    function gxRgb565(value) {
      return [
        gxExpand5((value >>> 11) & 0x1f),
        gxExpand6((value >>> 5) & 0x3f),
        gxExpand5(value & 0x1f),
        0xff,
      ];
    }

    function gxRgb5a3(value) {
      if ((value & 0x8000) !== 0) {
        return [
          gxExpand5((value >>> 10) & 0x1f),
          gxExpand5((value >>> 5) & 0x1f),
          gxExpand5(value & 0x1f),
          0xff,
        ];
      }
      return [
        gxExpand4((value >>> 8) & 0xf),
        gxExpand4((value >>> 4) & 0xf),
        gxExpand4(value & 0xf),
        gxExpand3((value >>> 12) & 7),
      ];
    }

    function gxCmprBlend(first, second) {
      return (first * 3 + second * 5) >>> 3;
    }

    function gxDecodeCmprBlock(pixels, width, height, x, y, source, offset) {
      const firstValue = gxReadU16(source, offset);
      const secondValue = gxReadU16(source, offset + 2);
      const first = gxRgb565(firstValue);
      const second = gxRgb565(secondValue);
      let third;
      let fourth;
      if (firstValue > secondValue) {
        third = [
          gxCmprBlend(second[0], first[0]),
          gxCmprBlend(second[1], first[1]),
          gxCmprBlend(second[2], first[2]),
          0xff,
        ];
        fourth = [
          gxCmprBlend(first[0], second[0]),
          gxCmprBlend(first[1], second[1]),
          gxCmprBlend(first[2], second[2]),
          0xff,
        ];
      } else {
        third = [
          Math.floor((first[0] + second[0]) / 2),
          Math.floor((first[1] + second[1]) / 2),
          Math.floor((first[2] + second[2]) / 2),
          0xff,
        ];
        fourth = [third[0], third[1], third[2], 0];
      }
      const colors = [first, second, third, fourth];
      for (let row = 0; row < 4; row += 1) {
        let indexes = source[offset + 4 + row];
        for (let column = 0; column < 4; column += 1) {
          const color = colors[(indexes >>> 6) & 3];
          gxTexturePixel(
            pixels, width, height, x + column, y + row,
            color[0], color[1], color[2], color[3]
          );
          indexes = (indexes << 2) & 0xff;
        }
      }
    }

    function gxTlutColor(index, paletteOffset, paletteFormat) {
      const offset = paletteOffset + index * 2;
      if (paletteFormat === 0) {
        const alpha = gxTmem[offset];
        const intensity = gxTmem[offset + 1];
        return [intensity, intensity, intensity, alpha];
      }
      const value = (gxTmem[offset] << 8) | gxTmem[offset + 1];
      return paletteFormat === 1 ? gxRgb565(value) : gxRgb5a3(value);
    }

    function gxLoadTlut() {
      const sourceAddress = (gxBpRegisters[0x64] << 5) & 0x01ffffff;
      const configuration = gxBpRegisters[0x65];
      const destination = (configuration & 0x3ff) << 9;
      const byteCount = ((configuration >>> 10) & 0x7ff) * 32;
      if (byteCount === 0) return;
      const pointer = ramPointer(sourceAddress, byteCount);
      if (
        pointer === null || destination + byteCount > gxTmem.length
      ) {
        gxTlutErrors += 1;
        return;
      }
      gxTmem.set(bytes.subarray(pointer, pointer + byteCount), destination);
      gxTlutLoads += 1;
      gxTlutBytes += byteCount;
      // Texture cache keys include the palette offset, format, and content hash,
      // so a TLUT upload does not invalidate unrelated or identical entries.
    }

    function gxDecodeTexture(textureMap) {
      const registers = gxTextureRegisters(textureMap);
      const image0 = gxBpRegisters[registers.image0];
      const mode0 = gxBpRegisters[registers.mode0];
      const width = (image0 & 0x3ff) + 1;
      const height = ((image0 >>> 10) & 0x3ff) + 1;
      const format = (image0 >>> 20) & 0xf;
      const layout = gxTextureLayout(format);
      if (layout === null || width > 1024 || height > 1024 || width * height > 1_048_576) {
        gxTextureDecodeErrors += 1;
        return null;
      }
      const address = (gxBpRegisters[registers.image3] << 5) >>> 0;
      gxMarkTextureCopyConsumer(address);
      const blocksWide = Math.ceil(width / layout.blockWidth);
      const blocksHigh = Math.ceil(height / layout.blockHeight);
      const encodedBytes = blocksWide * blocksHigh * layout.blockBytes;
      const pointer = ramPointer(address, encodedBytes);
      if (pointer === null) {
        gxTextureDecodeErrors += 1;
        return null;
      }
      const source = bytes.subarray(pointer, pointer + encodedBytes);
      let hash = 0x811c9dc5;
      for (const byte of source) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
      const paletteEntries = format === 8 ? 16 : format === 9 ? 256 : format === 10 ? 16384 : 0;
      let paletteOffset = 0;
      let paletteFormat = 0;
      let paletteHash = 0;
      if (paletteEntries !== 0) {
        const tlut = gxBpRegisters[registers.tlut];
        paletteOffset = (tlut & 0x3ff) << 9;
        paletteFormat = (tlut >>> 10) & 3;
        const paletteBytes = paletteEntries * 2;
        if (paletteFormat > 2 || paletteOffset + paletteBytes > gxTmem.length) {
          gxTextureDecodeErrors += 1;
          return null;
        }
        paletteHash = 0x811c9dc5;
        for (let offset = 0; offset < paletteBytes; offset += 1) {
          paletteHash = Math.imul(
            paletteHash ^ gxTmem[paletteOffset + offset],
            0x01000193
          ) >>> 0;
        }
      }
      const textureCopyIndex = gxTextureCopyDestinations.get(address);
      const key = [
        textureMap, address, width, height, format, hash,
        paletteOffset, paletteFormat, paletteHash, textureCopyIndex ?? "ram",
      ].join(":");
      const cached = gxTextureCache.get(key);
      if (cached !== undefined) {
        gxTextureCacheHits += 1;
        return cached;
      }

      const pixels = new Uint8ClampedArray(width * height * 4);
      let blockOffset = 0;
      for (let blockY = 0; blockY < blocksHigh; blockY += 1) {
        for (let blockX = 0; blockX < blocksWide; blockX += 1) {
          const originX = blockX * layout.blockWidth;
          const originY = blockY * layout.blockHeight;
          if (format === 0 || format === 8) {
            for (let row = 0; row < 8; row += 1) {
              for (let pair = 0; pair < 4; pair += 1) {
                const value = source[blockOffset + row * 4 + pair];
                if (format === 0) {
                  const first = gxExpand4(value >>> 4);
                  const second = gxExpand4(value & 0xf);
                  gxTexturePixel(
                    pixels, width, height, originX + pair * 2, originY + row,
                    first, first, first, first
                  );
                  gxTexturePixel(
                    pixels, width, height, originX + pair * 2 + 1, originY + row,
                    second, second, second, second
                  );
                } else {
                  const first = gxTlutColor(value >>> 4, paletteOffset, paletteFormat);
                  const second = gxTlutColor(value & 0xf, paletteOffset, paletteFormat);
                  gxTexturePixel(
                    pixels, width, height, originX + pair * 2, originY + row,
                    first[0], first[1], first[2], first[3]
                  );
                  gxTexturePixel(
                    pixels, width, height, originX + pair * 2 + 1, originY + row,
                    second[0], second[1], second[2], second[3]
                  );
                }
              }
            }
          } else if (format === 1 || format === 2 || format === 9) {
            for (let row = 0; row < 4; row += 1) {
              for (let column = 0; column < 8; column += 1) {
                const value = source[blockOffset + row * 8 + column];
                if (format === 1) {
                  gxTexturePixel(
                    pixels, width, height, originX + column, originY + row,
                    value, value, value, value
                  );
                } else if (format === 2) {
                  const alpha = gxExpand4(value >>> 4);
                  const intensity = gxExpand4(value & 0xf);
                  gxTexturePixel(
                    pixels, width, height, originX + column, originY + row,
                    intensity, intensity, intensity, alpha
                  );
                } else {
                  const color = gxTlutColor(value, paletteOffset, paletteFormat);
                  gxTexturePixel(
                    pixels, width, height, originX + column, originY + row,
                    color[0], color[1], color[2], color[3]
                  );
                }
              }
            }
          } else if ([3, 4, 5, 10].includes(format)) {
            for (let row = 0; row < 4; row += 1) {
              for (let column = 0; column < 4; column += 1) {
                const pixelOffset = blockOffset + (row * 4 + column) * 2;
                let color;
                if (format === 3) {
                  const alpha = source[pixelOffset];
                  const intensity = source[pixelOffset + 1];
                  color = [intensity, intensity, intensity, alpha];
                } else if (format === 4) {
                  color = gxRgb565(gxReadU16(source, pixelOffset));
                } else if (format === 5) {
                  color = gxRgb5a3(gxReadU16(source, pixelOffset));
                } else {
                  const index = gxReadU16(source, pixelOffset) & 0x3fff;
                  color = gxTlutColor(index, paletteOffset, paletteFormat);
                }
                gxTexturePixel(
                  pixels, width, height, originX + column, originY + row,
                  color[0], color[1], color[2], color[3]
                );
              }
            }
          } else if (format === 6) {
            for (let row = 0; row < 4; row += 1) {
              for (let column = 0; column < 4; column += 1) {
                const planeOffset = row * 8 + column * 2;
                const alpha = source[blockOffset + planeOffset];
                const red = source[blockOffset + planeOffset + 1];
                const green = source[blockOffset + 32 + planeOffset];
                const blue = source[blockOffset + 32 + planeOffset + 1];
                gxTexturePixel(
                  pixels, width, height, originX + column, originY + row,
                  red, green, blue, alpha
                );
              }
            }
          } else if (format === 14) {
            for (let subBlock = 0; subBlock < 4; subBlock += 1) {
              gxDecodeCmprBlock(
                pixels, width, height,
                originX + (subBlock & 1) * 4,
                originY + (subBlock >>> 1) * 4,
                source, blockOffset + subBlock * 8
              );
            }
          }
          blockOffset += layout.blockBytes;
        }
      }

      const texture = {
        key,
        map: textureMap,
        address,
        width,
        height,
        format,
        formatName: layout.name,
        encodedBytes,
        hash: "0x" + hash.toString(16).padStart(8, "0"),
        wrapS: mode0 & 3,
        wrapT: (mode0 >>> 2) & 3,
        magFilter: (mode0 >>> 4) & 1,
        minFilter: (mode0 >>> 5) & 7,
        pixels,
      };
      if (textureCopyIndex !== undefined) texture.textureCopyIndex = textureCopyIndex;
      if (paletteEntries !== 0) {
        texture.palette = {
          offset: paletteOffset,
          format: paletteFormat,
          formatName: ["IA8", "RGB565", "RGB5A3"][paletteFormat],
          entries: paletteEntries,
          hash: "0x" + paletteHash.toString(16).padStart(8, "0"),
        };
      }
      gxTextureDecodes += 1;
      gxTextureDecodedBytes += pixels.byteLength;
      gxTextureFormatCounts.set(
        layout.name,
        (gxTextureFormatCounts.get(layout.name) ?? 0) + 1
      );
      gxTextureCache.set(key, texture);
      return texture;
    }

    function gxTextureSummary(texture) {
      if (texture === null) return null;
      const { pixels: _pixels, ...summary } = texture;
      return summary;
    }

    function gxTevStageState(stageIndex) {
      const odd = (stageIndex & 1) !== 0;
      const order = gxBpRegisters[0x28 + (stageIndex >>> 1)] >>> 0;
      const orderShift = odd ? 12 : 0;
      const ksel = gxBpRegisters[0xf6 + (stageIndex >>> 1)] >>> 0;
      return {
        index: stageIndex,
        order,
        textureMap: (order >>> orderShift) & 7,
        texCoordIndex: (order >>> (orderShift + 3)) & 7,
        textureEnabled: ((order >>> (orderShift + 6)) & 1) !== 0,
        colorChannel: (order >>> (orderShift + 7)) & 7,
        colorCombiner: gxBpRegisters[0xc0 + stageIndex * 2] >>> 0,
        alphaCombiner: gxBpRegisters[0xc1 + stageIndex * 2] >>> 0,
        konstColorSelector: (ksel >>> (odd ? 14 : 4)) & 0x1f,
        konstAlphaSelector: (ksel >>> (odd ? 19 : 9)) & 0x1f,
      };
    }

    function gxTevColorArguments(combiner) {
      return {
        a: (combiner >>> 12) & 0xf,
        b: (combiner >>> 8) & 0xf,
        c: (combiner >>> 4) & 0xf,
        d: combiner & 0xf,
      };
    }

    function gxTevAlphaArguments(combiner) {
      return {
        a: (combiner >>> 13) & 7,
        b: (combiner >>> 10) & 7,
        c: (combiner >>> 7) & 7,
        d: (combiner >>> 4) & 7,
      };
    }

    function gxTevRegisterIndex(encoded) {
      return encoded === 0 ? 3 : encoded - 1;
    }

    function gxTevSwapTable(tableIndex) {
      const rg = gxBpRegisters[0xf6 + tableIndex * 2] >>> 0;
      const ba = gxBpRegisters[0xf7 + tableIndex * 2] >>> 0;
      return [rg & 3, (rg >>> 2) & 3, ba & 3, (ba >>> 2) & 3];
    }

    function gxPackTevState(stages) {
      const buffer = new ArrayBuffer(464);
      const state = new DataView(buffer);
      const stageCount = Math.min(16, stages.length);
      for (let index = 0; index < stageCount; index += 1) {
        const stage = stages[index];
        const offset = index * 16;
        const refs = (stage.textureMap & 7)
          | ((stage.texCoordIndex & 7) << 3)
          | (Number(stage.textureEnabled) << 6)
          | ((stage.colorChannel & 7) << 7);
        const konstSelectors = (stage.konstColorSelector & 0x1f)
          | ((stage.konstAlphaSelector & 0x1f) << 5);
        state.setUint32(offset, stage.colorCombiner & 0x00ffffff, true);
        state.setUint32(offset + 4, stage.alphaCombiner & 0x00ffffff, true);
        state.setUint32(offset + 8, refs, true);
        state.setUint32(offset + 12, konstSelectors, true);
      }
      for (let register = 0; register < 4; register += 1) {
        for (let component = 0; component < 4; component += 1) {
          state.setInt32(
            256 + (register * 4 + component) * 4,
            gxTevColorRegisters[register][component],
            true
          );
          state.setInt32(
            320 + (register * 4 + component) * 4,
            gxTevKonstRegisters[register][component],
            true
          );
          state.setUint32(
            384 + (register * 4 + component) * 4,
            gxTevSwapTable(register)[component],
            true
          );
        }
      }
      state.setUint32(448, stageCount, true);
      return new Uint8Array(buffer);
    }

    function gxTevTextures(stages) {
      const textures = Array(8).fill(null);
      for (const stage of stages) {
        if (!stage.textureEnabled || textures[stage.textureMap] !== null) continue;
        const texture = gxDecodeTexture(stage.textureMap);
        if (texture === null) {
          throw new Error(
            `GX TEV stage ${stage.index} requires undecodable texture map ${stage.textureMap}`
          );
        }
        textures[stage.textureMap] = texture;
      }
      return textures;
    }

    function gxTevSwizzle(color, tableIndex) {
      const table = gxTevSwapTable(tableIndex);
      return table.map(channel => color[channel] ?? 0);
    }

    function gxTevKonst(selector, alpha) {
      const fractions = [255, 223, 191, 159, 128, 96, 64, 32];
      if (selector < fractions.length) {
        return alpha
          ? fractions[selector]
          : [fractions[selector], fractions[selector], fractions[selector]];
      }
      if (!alpha && selector >= 12 && selector <= 15) {
        return gxTevKonstRegisters[selector - 12]
          .slice(0, 3)
          .map(value => Math.max(0, Math.min(255, value)));
      }
      if (selector >= 16) {
        const register = (selector - 16) & 3;
        const channel = (selector - 16) >>> 2;
        const value = Math.max(0, Math.min(255, gxTevKonstRegisters[register][channel]));
        return alpha ? value : [value, value, value];
      }
      return alpha ? 0 : [0, 0, 0];
    }

    function gxTevColorArgument(
      argument, channel, registers, textureColor, rasterColor, konstColor
    ) {
      if (argument <= 7) {
        const register = gxTevRegisterIndex(argument >>> 1);
        return registers[register][(argument & 1) === 0 ? channel : 3];
      }
      switch (argument) {
        case 8: return textureColor[channel];
        case 9: return textureColor[3];
        case 10: return rasterColor[channel];
        case 11: return rasterColor[3];
        case 12: return 255;
        case 13: return 128;
        case 14: return konstColor[channel];
        default: return 0;
      }
    }

    function gxTevAlphaArgument(
      argument, registers, textureColor, rasterColor, konstAlpha
    ) {
      if (argument <= 3) return registers[gxTevRegisterIndex(argument)][3];
      switch (argument) {
        case 4: return textureColor[3];
        case 5: return rasterColor[3];
        case 6: return konstAlpha;
        default: return 0;
      }
    }

    function gxTevRegular(a, b, c, d, combiner) {
      // GX stores TEV registers as signed 11-bit values, but the A, B, and C
      // combiner inputs are read through 8-bit lanes. D retains the signed
      // value so intermediate add/subtract stages can use the extended range.
      a &= 0xff;
      b &= 0xff;
      c &= 0xff;
      const mixed = ((255 - c) * a + c * b + 127) / 255;
      let result = ((combiner >>> 18) & 1) !== 0 ? d - mixed : d + mixed;
      const bias = (combiner >>> 16) & 3;
      if (bias === 1) result += 128;
      if (bias === 2) result -= 128;
      const scale = (combiner >>> 20) & 3;
      if (scale === 1) result *= 2;
      if (scale === 2) result *= 4;
      if (scale === 3) result *= 0.5;
      result = Math.round(result);
      return (combiner & 0x00080000) !== 0
        ? Math.max(0, Math.min(255, result))
        : Math.max(-1024, Math.min(1023, result));
    }

    function gxTevClamp(result, combiner) {
      return (combiner & 0x00080000) !== 0
        ? Math.max(0, Math.min(255, result))
        : Math.max(-1024, Math.min(1023, result));
    }

    function gxTevComparison(a, b, combiner) {
      return (combiner & 0x00040000) !== 0 ? a === b : a > b;
    }

    function gxTevPackedColor(color, target) {
      let value = color[0] & 0xff;
      if (target >= 1) value |= (color[1] & 0xff) << 8;
      if (target >= 2) value |= (color[2] & 0xff) << 16;
      return value;
    }

    function gxTevColorCombiner(a, b, c, d, combiner) {
      if (((combiner >>> 16) & 3) !== 3) {
        return Array.from({ length: 3 }, (_unused, channel) =>
          gxTevRegular(a[channel], b[channel], c[channel], d[channel], combiner)
        );
      }

      const target = (combiner >>> 20) & 3;
      if (target === 3) {
        return Array.from({ length: 3 }, (_unused, channel) => gxTevClamp(
          d[channel] + (
            gxTevComparison(a[channel] & 0xff, b[channel] & 0xff, combiner)
              ? c[channel] & 0xff
              : 0
          ),
          combiner
        ));
      }

      const matches = gxTevComparison(
        gxTevPackedColor(a, target), gxTevPackedColor(b, target), combiner
      );
      return Array.from({ length: 3 }, (_unused, channel) => gxTevClamp(
        d[channel] + (matches ? c[channel] & 0xff : 0), combiner
      ));
    }

    function gxTevAlphaCombiner(colorA, colorB, a, b, c, d, combiner) {
      if (((combiner >>> 16) & 3) !== 3) {
        return gxTevRegular(a, b, c, d, combiner);
      }

      const target = (combiner >>> 20) & 3;
      // Packed alpha comparisons share the color combiner's RGB A/B inputs;
      // target 3 is the only mode that compares the alpha combiner inputs.
      const compareA = target === 3 ? a & 0xff : gxTevPackedColor(colorA, target);
      const compareB = target === 3 ? b & 0xff : gxTevPackedColor(colorB, target);
      return gxTevClamp(
        d + (gxTevComparison(compareA, compareB, combiner) ? c & 0xff : 0),
        combiner
      );
    }

    function gxTevSampleTexture(texture, x, y, width, height) {
      if (texture === null) return [255, 255, 255, 255];
      const normalizedX = (x + 0.5) / width;
      const normalizedY = (y + 0.5) / height;
      const sourceX = Math.max(
        0, Math.min(texture.width - 1, Math.floor(normalizedX * texture.width))
      );
      const sourceY = Math.max(
        0, Math.min(texture.height - 1, Math.floor(normalizedY * texture.height))
      );
      const offset = (sourceY * texture.width + sourceX) * 4;
      return Array.from(texture.pixels.subarray(offset, offset + 4));
    }

    function gxTevCoordsValid(coords, vertexCount) {
      return Array.isArray(coords) && coords.length === vertexCount
        && coords.every(coord =>
          coord !== null && coord.length >= 2 && coord.every(Number.isFinite)
        );
    }

    function gxTevCoordsEquivalent(left, right) {
      if (left.length !== right.length) return false;
      return left.every((coord, index) =>
        Math.abs(coord[0] - right[index][0]) < 1e-6
        && Math.abs(coord[1] - right[index][1]) < 1e-6
      );
    }

    function gxTextureForDraw(vertices, texCoordSets) {
      const stageCount = Math.min(16, ((gxBpRegisters[0x00] >>> 10) & 0xf) + 1);
      const stages = Array.from({ length: stageCount }, (_unused, stageIndex) => {
        const stage = gxTevStageState(stageIndex);
        stage.texture = stage.textureEnabled ? gxDecodeTexture(stage.textureMap) : null;
        return stage;
      });
      const texturedStages = stages.filter(stage => stage.textureEnabled && stage.texture !== null);
      if (texturedStages.length === 0) return null;
      const primary = texturedStages.reduce((best, stage) =>
        stage.texture.width * stage.texture.height > best.texture.width * best.texture.height
          ? stage
          : best
      );
      const vertexCount = vertices.length / 8;
      const primaryCoords = texCoordSets[primary.texCoordIndex];
      if (!gxTevCoordsValid(primaryCoords, vertexCount)) return null;
      for (const stage of texturedStages) {
        const coords = texCoordSets[stage.texCoordIndex];
        if (!gxTevCoordsValid(coords, vertexCount)) return null;
        if (!gxTevCoordsEquivalent(primaryCoords, coords)) return null;
      }

      const rasterColor = [0, 0, 0, 0];
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        for (let channel = 0; channel < 4; channel += 1) {
          rasterColor[channel] += vertices[vertex * 8 + 4 + channel] * 255 / vertexCount;
        }
      }
      for (let channel = 0; channel < 4; channel += 1) {
        rasterColor[channel] = Math.max(0, Math.min(255, Math.round(rasterColor[channel])));
      }

      const first = stages[0];
      const colorArguments = gxTevColorArguments(first.colorCombiner);
      const alphaArguments = gxTevAlphaArguments(first.alphaCombiner);
      const colorRegular = ((first.colorCombiner >>> 16) & 7) === 0
        && ((first.colorCombiner >>> 20) & 3) === 0;
      const alphaRegular = ((first.alphaCombiner >>> 16) & 7) === 0
        && ((first.alphaCombiner >>> 20) & 3) === 0;
      const directTexture = stageCount === 1 && colorRegular && alphaRegular
        && colorArguments.a === 15 && colorArguments.b === 15
        && colorArguments.c === 15 && colorArguments.d === 8
        && alphaArguments.a === 7 && alphaArguments.b === 7
        && alphaArguments.c === 7 && alphaArguments.d === 4;
      const textureTimesRaster = stageCount === 1 && colorRegular && alphaRegular
        && colorArguments.a === 15 && colorArguments.b === 8
        && colorArguments.c === 10 && colorArguments.d === 15
        && alphaArguments.a === 7 && alphaArguments.b === 4
        && alphaArguments.c === 5 && alphaArguments.d === 7;
      const tevMode = directTexture
        ? "texture"
        : textureTimesRaster
          ? "texture-times-raster"
          : stageCount === 1 ? "generic-stage-0" : `multi-stage-${stageCount}`;
      gxTevModeCounts.set(tevMode, (gxTevModeCounts.get(tevMode) ?? 0) + 1);
      gxTexturedDraws += 1;
      statusDataset.gxTextures = String(gxTexturedDraws);

      const stageSummaries = stages.map(stage => ({
        index: stage.index,
        order: hex32(stage.order),
        textureMap: stage.textureMap,
        texCoordIndex: stage.texCoordIndex,
        textureEnabled: stage.textureEnabled,
        colorChannel: stage.colorChannel,
        colorCombiner: hex32(stage.colorCombiner),
        alphaCombiner: hex32(stage.alphaCombiner),
        konstColorSelector: stage.konstColorSelector,
        konstAlphaSelector: stage.konstAlphaSelector,
        texture: gxTextureSummary(stage.texture),
      }));
      const renderKey = [
        tevMode,
        ...stages.flatMap(stage => [
          stage.texture?.key ?? "none",
          stage.order,
          stage.colorCombiner,
          stage.alphaCombiner,
          stage.konstColorSelector,
          stage.konstAlphaSelector,
        ]),
        ...gxTevColorRegisters.flat(),
        ...gxTevKonstRegisters.flat(),
        ...Array.from({ length: 8 }, (_unused, index) => gxBpRegisters[0xf6 + index]),
        ...rasterColor,
      ].join(":");
      const cached = gxTevTextureCache.get(renderKey);
      if (cached !== undefined) {
        gxTevTextureCacheHits += 1;
        return { texture: cached, texCoordIndex: primary.texCoordIndex, stages: stageSummaries };
      }

      const width = primary.texture.width;
      const height = primary.texture.height;
      const pixels = new Uint8ClampedArray(width * height * 4);
      if (directTexture) {
        pixels.set(primary.texture.pixels);
      } else if (textureTimesRaster) {
        for (let offset = 0; offset < pixels.length; offset += 4) {
          for (let channel = 0; channel < 4; channel += 1) {
            pixels[offset + channel] = Math.round(
              primary.texture.pixels[offset + channel] * rasterColor[channel] / 255
            );
          }
        }
      } else {
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const registers = gxTevColorRegisters.map(register => register.slice());
            let lastColorDestination = 3;
            let lastAlphaDestination = 3;
            for (const stage of stages) {
              const textureBase = gxTevSampleTexture(stage.texture, x, y, width, height);
              const textureColor = gxTevSwizzle(
                textureBase, (stage.alphaCombiner >>> 2) & 3
              );
              const rasterBase = stage.colorChannel === 7
                ? [0, 0, 0, 0]
                : rasterColor;
              const raster = gxTevSwizzle(rasterBase, stage.alphaCombiner & 3);
              const konstColor = gxTevKonst(stage.konstColorSelector, false);
              const konstAlpha = gxTevKonst(stage.konstAlphaSelector, true);
              const colorArgs = gxTevColorArguments(stage.colorCombiner);
              const alphaArgs = gxTevAlphaArguments(stage.alphaCombiner);
              const colorInput = argument => Array.from(
                { length: 3 }, (_unused, channel) =>
                  gxTevColorArgument(
                    argument, channel, registers, textureColor, raster, konstColor
                  )
              );
              const colorA = colorInput(colorArgs.a);
              const colorB = colorInput(colorArgs.b);
              const colorResult = gxTevColorCombiner(
                colorA,
                colorB,
                colorInput(colorArgs.c),
                colorInput(colorArgs.d),
                stage.colorCombiner
              );
              const alphaInput = argument => gxTevAlphaArgument(
                argument, registers, textureColor, raster, konstAlpha
              );
              const alphaResult = gxTevAlphaCombiner(
                colorA,
                colorB,
                alphaInput(alphaArgs.a),
                alphaInput(alphaArgs.b),
                alphaInput(alphaArgs.c),
                alphaInput(alphaArgs.d),
                stage.alphaCombiner
              );
              const colorDestination = gxTevRegisterIndex(
                (stage.colorCombiner >>> 22) & 3
              );
              const alphaDestination = gxTevRegisterIndex(
                (stage.alphaCombiner >>> 22) & 3
              );
              registers[colorDestination][0] = colorResult[0];
              registers[colorDestination][1] = colorResult[1];
              registers[colorDestination][2] = colorResult[2];
              registers[alphaDestination][3] = alphaResult;
              lastColorDestination = colorDestination;
              lastAlphaDestination = alphaDestination;
            }
            const offset = (y * width + x) * 4;
            pixels[offset] = registers[lastColorDestination][0];
            pixels[offset + 1] = registers[lastColorDestination][1];
            pixels[offset + 2] = registers[lastColorDestination][2];
            pixels[offset + 3] = registers[lastAlphaDestination][3];
          }
        }
      }
      const rendered = {
        ...primary.texture,
        width,
        height,
        renderKey,
        modulation: rasterColor.map(value => value / 255),
        tev: {
          mode: tevMode,
          stages: stageSummaries,
          colorRegisters: gxTevColorRegisters.map(register => register.slice()),
          konstRegisters: gxTevKonstRegisters.map(register => register.slice()),
        },
        pixels,
      };
      gxTevTextureCache.set(renderKey, rendered);
      return { texture: rendered, texCoordIndex: primary.texCoordIndex, stages: stageSummaries };
    }

    function gxProjectPosition(position, matrixIndex) {
      const viewPosition = gxTransformPosition(position, matrixIndex);
      if (viewPosition === null) return null;
      const [viewX, viewY, viewZ] = viewPosition;
      const projection = Array.from({ length: 6 }, (_unused, index) =>
        gxXfFloat(0x1020 + index)
      );
      const projectionType = gxXfRegisters[0x1026] >>> 0;
      let clipX;
      let clipY;
      let clipZ;
      let clipW;
      if (projectionType === 0) {
        clipX = projection[0] * viewX + projection[1] * viewZ;
        clipY = projection[2] * viewY + projection[3] * viewZ;
        clipZ = projection[4] * viewZ + projection[5];
        clipW = -viewZ;
      } else if (projectionType === 1) {
        clipX = projection[0] * viewX + projection[1];
        clipY = projection[2] * viewY + projection[3];
        clipZ = projection[4] * viewZ + projection[5];
        clipW = 1;
      } else {
        return null;
      }
      if (![clipX, clipY, clipZ, clipW].every(Number.isFinite) || Math.abs(clipW) < 1e-12) {
        return null;
      }
      const viewport = Array.from({ length: 6 }, (_unused, index) =>
        gxXfFloat(0x101a + index)
      );
      if (viewport.some(value => !Number.isFinite(value)) || viewport[0] === 0 || viewport[1] === 0) {
        return null;
      }
      const scissorOffset = gxBpRegisters[0x59];
      const scissorX = scissorOffset & 0x3ff;
      const scissorY = (scissorOffset >>> 10) & 0x3ff;
      return [
        clipX / clipW * viewport[0] + viewport[3] - scissorX * 2,
        clipY / clipW * viewport[1] + viewport[4] - scissorY * 2,
        clipZ / clipW * viewport[2] + viewport[5],
        clipW,
      ];
    }

    function gxDecodeVertex(source, cursor, vatIndex) {
      const descriptorLow = gxCpRegisters[0x50];
      const vat0 = gxCpRegisters[0x70 + vatIndex];
      const vat1 = gxCpRegisters[0x80 + vatIndex];
      const vat2 = gxCpRegisters[0x90 + vatIndex];
      let positionMatrix = gxCpRegisters[0x30] & 0x3f;
      const matrixIndexA = gxCpRegisters[0x30] >>> 0;
      const matrixIndexB = gxCpRegisters[0x40] >>> 0;
      const textureMatrices = [
        (matrixIndexA >>> 6) & 0x3f,
        (matrixIndexA >>> 12) & 0x3f,
        (matrixIndexA >>> 18) & 0x3f,
        (matrixIndexA >>> 24) & 0x3f,
        matrixIndexB & 0x3f,
        (matrixIndexB >>> 6) & 0x3f,
        (matrixIndexB >>> 12) & 0x3f,
        (matrixIndexB >>> 18) & 0x3f,
      ];
      for (let matrix = 0; matrix < 9; matrix += 1) {
        if ((descriptorLow & (1 << matrix)) === 0) continue;
        if (matrix === 0) positionMatrix = source[cursor] & 0x3f;
        if (matrix > 0) textureMatrices[matrix - 1] = source[cursor] & 0x3f;
        cursor += 1;
      }

      const positionStatus = gxAttributeStatus(0);
      const positionElements = (vat0 & 1) + 2;
      const positionFormat = (vat0 >>> 1) & 7;
      const positionBytes = positionElements * gxComponentBytes(positionFormat);
      const positionSource = gxAttributeSource(
        source, cursor, positionStatus, 0, positionBytes
      );
      cursor = positionSource.cursor;
      if (positionSource.source === null) return { cursor, skipped: true };
      const positionScale = positionFormat === 4 ? 1 : 2 ** -((vat0 >>> 4) & 0x1f);
      const position = [0, 0, 0];
      for (let component = 0; component < positionElements; component += 1) {
        position[component] = gxReadComponent(
          positionSource.source,
          positionSource.offset + component * gxComponentBytes(positionFormat),
          positionFormat
        ) * positionScale;
      }

      const normalStatus = gxAttributeStatus(1);
      const normalElements = (vat0 >>> 9) & 1;
      const normalFormat = (vat0 >>> 10) & 7;
      const normalAttribute = gxDecodeNormalAttribute(
        source,
        cursor,
        normalStatus,
        normalElements,
        normalFormat,
        normalElements !== 0 && (vat0 & 0x80000000) !== 0
      );
      cursor = normalAttribute.cursor;
      if (normalAttribute.skipped) return { cursor, skipped: true };

      const colors = Array.from({ length: 2 }, () => [0xff, 0xff, 0xff, 0xff]);
      for (let colorIndex = 0; colorIndex < 2; colorIndex += 1) {
        const status = gxAttributeStatus(2 + colorIndex);
        const format = (vat0 >>> (14 + colorIndex * 4)) & 7;
        const directBytes = [2, 3, 4, 2, 3, 4][format] ?? 0;
        const colorSource = gxAttributeSource(
          source, cursor, status, 2 + colorIndex, directBytes
        );
        cursor = colorSource.cursor;
        if (colorSource.source !== null) {
          colors[colorIndex] = gxDecodeColor(colorSource.source, colorSource.offset, format);
        }
      }

      const textureAttributes = [
        [(vat0 >>> 21) & 1, (vat0 >>> 22) & 7, (vat0 >>> 25) & 0x1f],
        [vat1 & 1, (vat1 >>> 1) & 7, (vat1 >>> 4) & 0x1f],
        [(vat1 >>> 9) & 1, (vat1 >>> 10) & 7, (vat1 >>> 13) & 0x1f],
        [(vat1 >>> 18) & 1, (vat1 >>> 19) & 7, (vat1 >>> 22) & 0x1f],
        [(vat1 >>> 27) & 1, (vat1 >>> 28) & 7, vat2 & 0x1f],
        [(vat2 >>> 5) & 1, (vat2 >>> 6) & 7, (vat2 >>> 9) & 0x1f],
        [(vat2 >>> 14) & 1, (vat2 >>> 15) & 7, (vat2 >>> 18) & 0x1f],
        [(vat2 >>> 23) & 1, (vat2 >>> 24) & 7, (vat2 >>> 27) & 0x1f],
      ];
      const rawTextureCoords = Array(8).fill(null);
      for (let texture = 0; texture < 8; texture += 1) {
        const status = gxAttributeStatus(4 + texture);
        const [elements, format, fraction] = textureAttributes[texture];
        const componentCount = elements + 1;
        const directBytes = componentCount * gxComponentBytes(format);
        const textureSource = gxAttributeSource(
          source, cursor, status, 4 + texture, directBytes
        );
        cursor = textureSource.cursor;
        if (textureSource.source !== null) {
          const scale = format === 4 ? 1 : 2 ** -fraction;
          rawTextureCoords[texture] = Array.from(
            { length: componentCount }, (_unused, component) =>
            gxReadComponent(
              textureSource.source,
              textureSource.offset + component * gxComponentBytes(format),
              format
            ) * scale
          );
          if (rawTextureCoords[texture].length === 1) rawTextureCoords[texture].push(0);
        }
      }
      const viewPosition = gxTransformPosition(position, positionMatrix);
      const projected = gxProjectPosition(position, positionMatrix);
      const normal = gxTransformNormal(normalAttribute.normal, positionMatrix);
      const tangent = gxTransformNormal(normalAttribute.tangent, positionMatrix);
      const binormal = gxTransformNormal(normalAttribute.binormal, positionMatrix);
      const rasterColors = viewPosition === null
        ? colors.map(color => color.map(value => value / 255))
        : gxLightRasterChannels(viewPosition, normal, colors);
      const texgenAttributes = {
        position,
        normal: normalAttribute.normal,
        tangent: normalAttribute.tangent,
        binormal: normalAttribute.binormal,
        colors: rasterColors,
        rawTextureCoords,
      };
      const texCoords = textureMatrices.map((matrixIndex, texgenIndex) =>
        gxTransformTexCoord(texgenAttributes, matrixIndex, texgenIndex)
      );
      return {
        cursor,
        projected,
        colors,
        rasterColors,
        normal,
        tangent,
        binormal,
        rawNormal: normalAttribute.normal,
        rawTangent: normalAttribute.tangent,
        rawBinormal: normalAttribute.binormal,
        texCoords,
        rawTextureCoords,
        textureMatrices,
      };
    }

    function gxDrawPipelineState() {
      const topLeft = gxBpRegisters[0x20] >>> 0;
      const bottomRight = gxBpRegisters[0x21] >>> 0;
      const offset = gxBpRegisters[0x59] >>> 0;
      const topLeftX = Math.max(0, ((topLeft >>> 12) & 0x7ff) - 342);
      const topLeftY = Math.max(0, (topLeft & 0x7ff) - 342);
      const width = Math.max(
        0,
        ((bottomRight >>> 12) & 0x7ff) - ((topLeft >>> 12) & 0x7ff)
      ) + 1;
      const height = Math.max(
        0,
        (bottomRight & 0x7ff) - (topLeft & 0x7ff)
      ) + 1;
      const offsetX = (offset & 0x3ff) * 2 - 342;
      const offsetY = ((offset >>> 10) & 0x3ff) * 2 - 342;
      const scissorX = Math.min(640, Math.max(0, topLeftX - offsetX));
      const scissorY = Math.min(528, Math.max(0, topLeftY - offsetY));
      return {
        zMode: gxBpRegisters[0x40] >>> 0,
        blendMode: gxBpRegisters[0x41] >>> 0,
        alphaTest: gxBpRegisters[0xf3] >>> 0,
        cullMode: (gxBpRegisters[0x00] >>> 14) & 3,
        scissorX,
        scissorY,
        scissorWidth: Math.min(width, 640 - scissorX),
        scissorHeight: Math.min(height, 528 - scissorY),
      };
    }

    function gxDrawTexCoords(textureResult, selectedTexCoords) {
      // Missing or unusable texcoords make gxTextureForDraw deliberately
      // return null. Keep those primitives untextured instead of forwarding
      // one null placeholder per vertex as a malformed UV array.
      return textureResult === null ? [] : selectedTexCoords.flat();
    }

    function recordGxPrimitive(opcode, source, payloadOffset, vertexCount, vertexSize) {
      if (!gxCollectFrameGeometry) {
        gxSkippedGeometryPrimitives += 1;
        gxSkippedGeometryVertices += vertexCount;
        gxFrameSkippedPrimitives += 1;
        return;
      }
      const vertices = [];
      const texCoordSets = Array.from({ length: 8 }, () => []);
      const rawTextureCoordSets = Array.from({ length: 8 }, () => []);
      const rasterColorSets = Array.from({ length: 2 }, () => []);
      const normalSet = [];
      let textureMatrices = null;
      let complete = true;
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        const start = payloadOffset + vertex * vertexSize;
        const decoded = gxDecodeVertex(source, start, opcode & 7);
        if (decoded.cursor !== start + vertexSize) gxVertexDecodeErrors += 1;
        if (decoded.skipped || decoded.projected === null) {
          gxDroppedVertices += 1;
          complete = false;
          continue;
        }
        gxDecodedVertices += 1;
        gxProjectedVertices += 1;
        const raster0 = decoded.rasterColors?.[0]
          ?? decoded.colors[0].map(value => value / 255);
        const raster1 = decoded.rasterColors?.[1]
          ?? decoded.colors[1].map(value => value / 255);
        vertices.push(
          decoded.projected[0], decoded.projected[1], decoded.projected[2],
          decoded.projected[3],
          ...raster0,
          ...raster1
        );
        for (let texgen = 0; texgen < 8; texgen += 1) {
          const texCoord = decoded.texCoords[texgen];
          texCoordSets[texgen].push(texCoord);
          rawTextureCoordSets[texgen].push(decoded.rawTextureCoords[texgen]);
          vertices.push(...(texCoord ?? [0, 0, 1]));
        }
        rasterColorSets[0].push(raster0);
        rasterColorSets[1].push(raster1);
        normalSet.push(decoded.normal);
        textureMatrices = decoded.textureMatrices;
      }
      if (!complete || vertices.length === 0) return;
      gxFrameDrawVertices += vertexCount;
      const stageCount = Math.min(16, ((gxBpRegisters[0x00] >>> 10) & 0xf) + 1);
      const stages = Array.from({ length: stageCount }, (_unused, stageIndex) =>
        gxTevStageState(stageIndex)
      );
      for (const stage of stages) {
        if (!stage.textureEnabled) continue;
        const coords = texCoordSets[stage.texCoordIndex];
        if (!gxTevCoordsValid(coords, vertexCount) || coords.some(coord => coord.length < 3)) {
          throw new Error(
            `GX TEV stage ${stage.index} requires invalid texcoord ${stage.texCoordIndex}`
          );
        }
      }
      const textures = gxTevTextures(stages);
      const texturedStages = stages.filter(stage => stage.textureEnabled);
      if (texturedStages.length !== 0) {
        gxTexturedDraws += 1;
        statusDataset.gxTextures = String(gxTexturedDraws);
      }
      const tevMode = `per-fragment-stage-${stageCount}`;
      gxTevModeCounts.set(tevMode, (gxTevModeCounts.get(tevMode) ?? 0) + 1);
      const texCoordIndex = texturedStages[0]?.texCoordIndex ?? 0;
      const selectedTexCoords = texCoordSets[texCoordIndex];
      const draw = {
        topology: (opcode >>> 3) & 7,
        vat: opcode & 7,
        vertexCount,
        // Renderer frames cross a Worker boundary. Keep the GPU-bound payload
        // in its final f32 representation so structured cloning does not walk
        // and duplicate one boxed JavaScript number per vertex component.
        vertices: new Float32Array(vertices),
        textures,
        tevState: gxPackTevState(stages),
        pipeline: gxDrawPipelineState(),
      };
      gxFrameDraws.push(draw);
      const vatIndex = opcode & 7;
      const primitiveSample = {
        cycle: cycles,
        dispatch: dispatches,
        opcode: "0x" + opcode.toString(16).padStart(2, "0"),
        topology: draw.topology,
        vat: vatIndex,
        vertexSize,
        vertexCount,
        vcdLow: hex32(gxCpRegisters[0x50]),
        vcdHigh: hex32(gxCpRegisters[0x60]),
        vat0: hex32(gxCpRegisters[0x70 + vatIndex]),
        vat1: hex32(gxCpRegisters[0x80 + vatIndex]),
        vat2: hex32(gxCpRegisters[0x90 + vatIndex]),
        vertices: vertices.slice(0, 32),
        texCoordIndex,
        texCoords: selectedTexCoords.slice(0, 4),
        rasterColors: rasterColorSets.map(colors => colors.slice(0, 4)),
        normals: normalSet.slice(0, 4),
        generatedTexCoords: texCoordSets.map(coords => coords.slice(0, 4)),
        rawTextureCoords: rawTextureCoordSets.map(coords => coords.slice(0, 4)),
        textureMatrices,
        textures: textures.map(gxTextureSummary),
        tev: {
          stageCount,
          stages: stages.map(stage => ({
            index: stage.index,
            order: hex32(stage.order),
            textureMap: stage.textureMap,
            texCoordIndex: stage.texCoordIndex,
            textureEnabled: stage.textureEnabled,
            colorChannel: stage.colorChannel,
            colorCombiner: hex32(stage.colorCombiner),
            alphaCombiner: hex32(stage.alphaCombiner),
            konstColorSelector: stage.konstColorSelector,
            konstAlphaSelector: stage.konstAlphaSelector,
          })),
          order0: hex32(gxBpRegisters[0x28]),
          color0: hex32(gxBpRegisters[0xc0]),
          alpha0: hex32(gxBpRegisters[0xc1]),
          colorRegisters: gxTevColorRegisters.map(register => register.slice()),
          konstRegisters: gxTevKonstRegisters.map(register => register.slice()),
          ksel: Array.from({ length: 8 }, (_unused, index) =>
            hex32(gxBpRegisters[0xf6 + index])
          ),
        },
      };
      if (gxPrimitiveSamples.length < 16) gxPrimitiveSamples.push(primitiveSample);
      gxRecentPrimitiveSamples.push(primitiveSample);
      if (gxRecentPrimitiveSamples.length > 16) gxRecentPrimitiveSamples.shift();
    }

    function gxSparseRegisters(registers) {
      return Object.fromEntries(
        Array.from(registers.entries())
          .filter(([_address, value]) => value !== 0)
          .map(([address, value]) => [
            "0x" + address.toString(16).padStart(2, "0"),
            hex32(value),
          ])
      );
    }

    function recordGxXfWrite(address, value) {
      if (address >= gxXfRegisters.length) return;
      gxXfRegisters[address] = value >>> 0;
    }

    function recordGxIndexedXfWrite(opcode, value) {
      const referenceArray = (opcode >>> 3) + 8;
      const index = value >>> 16;
      const targetAddress = value & 0xfff;
      const count = ((value >>> 12) & 0xf) + 1;
      const base = gxCpRegisters[0xa0 + referenceArray] >>> 0;
      const stride = gxCpRegisters[0xb0 + referenceArray] & 0xff;
      const pointer = ramPointer((base + stride * index) >>> 0, count * 4);
      if (pointer === null || targetAddress + count > gxXfRegisters.length) {
        gxVertexDecodeErrors += 1;
        return;
      }
      for (let word = 0; word < count; word += 1) {
        recordGxXfWrite(targetAddress + word, view.getUint32(pointer + word * 4, false));
      }
    }

    function recordGxBpWrite(word) {
      const address = word >>> 24;
      const value = word & 0x00ffffff;
      const mask = gxBpRegisters[0xfe];
      const previous = gxBpRegisters[address];
      gxBpRegisters[address] = ((previous & ~mask) | (value & mask)) & 0x00ffffff;
      if (address !== 0xfe) gxBpRegisters[0xfe] = 0x00ffffff;
      gxBpLoads += 1;
      if (address >= 0xe0 && address <= 0xe7) {
        const registerIndex = gxTevRegisterIndex((address - 0xe0) >>> 1);
        const registerValue = gxBpRegisters[address];
        const target = (registerValue & 0x00800000) !== 0
          ? gxTevKonstRegisters[registerIndex]
          : gxTevColorRegisters[registerIndex];
        const signed11 = bits => (bits & 0x400) !== 0 ? bits - 0x800 : bits;
        if ((address & 1) === 0) {
          target[0] = signed11(registerValue & 0x7ff);
          target[3] = signed11((registerValue >>> 12) & 0x7ff);
        } else {
          target[2] = signed11(registerValue & 0x7ff);
          target[1] = signed11((registerValue >>> 12) & 0x7ff);
        }
      }
      if (
        (address >= 0x94 && address <= 0x97)
        || (address >= 0xb4 && address <= 0xb7)
      ) {
        gxMarkTextureCopyConsumer((gxBpRegisters[address] << 5) >>> 0);
      }
      if (address === 0x4b) {
        gxPrearmTextureCopyProducer((gxBpRegisters[address] << 5) >>> 0);
      }
      if (address === 0x45 && (gxBpRegisters[address] & 2) !== 0) {
        deviceEvents.set(
          "peFinishCommand",
          (deviceEvents.get("peFinishCommand") ?? 0) + 1
        );
        if (peFinishCycle === null && !peFinishSignal) peFinishCycle = cycles + 200;
      }
      if (address === 0x65) gxLoadTlut();
      if (address !== 0x52) return;

      const trigger = gxBpRegisters[0x52];
      const source = gxBpRegisters[0x49];
      const dimensions = gxBpRegisters[0x4a];
      const yScaleRaw = gxBpRegisters[0x4e];
      const sourceHeight = ((dimensions >>> 10) & 0x3ff) + 1;
      const yScale = (trigger & 0x400) !== 0
        ? 256 / Math.max(1, yScaleRaw)
        : yScaleRaw / 256;
      const copyToXfb = (trigger & 0x4000) !== 0;
      const viTop = viXfbAddress(0x201c);
      const viBottom = viXfbAddress(0x2024);
      const frame = {
        index: copyToXfb ? gxXfbCopyCount + 1 : gxTextureCopyCount + 1,
        sourceX: source & 0x3ff,
        sourceY: (source >>> 10) & 0x3ff,
        width: (dimensions & 0x3ff) + 1,
        sourceHeight,
        height: Math.max(1, Math.floor(1 + (sourceHeight - 1) * yScale)),
        destination: (gxBpRegisters[0x4b] << 5) >>> 0,
        viTop,
        viBottom,
        stride: (gxBpRegisters[0x4d] << 5) >>> 0,
        copyToXfb,
        clear: (trigger & 0x0800) !== 0,
        clearColor: [
          gxBpRegisters[0x4f] & 0xff,
          (gxBpRegisters[0x50] >>> 8) & 0xff,
          gxBpRegisters[0x50] & 0xff,
          (gxBpRegisters[0x4f] >>> 8) & 0xff,
        ],
        geometry: {
          drawCalls: gxFrameDraws.length,
          vertices: gxFrameDrawVertices,
          draws: gxFrameDraws,
        },
      };
      frame.displayed = false;
      if (copyToXfb) {
        gxXfbCopyCount += 1;
        gxXfbCopies.push({
          ...frame,
          captured: gxCollectFrameGeometry,
          geometry: {
            drawCalls: frame.geometry.drawCalls,
            vertices: frame.geometry.vertices,
          },
        });
        if (gxXfbCopies.length > 16) gxXfbCopies.shift();
        if (!gxCollectFrameGeometry) {
          gxFramesSkipped += 1;
          if (frame.clear) gxSkippedFrameClearColor = frame.clearColor;
          else gxUncollectedNonClearingFrames += 1;
        } else {
          if (gxSkippedFrameClearColor !== null) {
            postMessage({ type: "efb-clear", clearColor: gxSkippedFrameClearColor });
            gxSkippedFrameClearColor = null;
          }
          postRendererFrame("xfb-copy", frame);
          gxXfbFramesCaptured += 1;
        }
        gxFrameDraws = [];
        gxFrameDrawVertices = 0;
        gxFrameSkippedPrimitives = 0;
        gxCollectFrameGeometry = gxShouldCollectNextXfb();
      } else {
        gxTextureCopyCount += 1;
        const collectedGeometry = gxCollectFrameGeometry;
        const knownConsumer = gxTextureCopyConsumers.has(frame.destination);
        gxRecordTextureCopyGeneration(
          frame.destination, gxTextureCopyCount, collectedGeometry
        );
        const boundAsTexture = gxTextureCopyIsBound(frame.destination);
        gxTextureCopies.push({
          ...frame,
          boundAsTexture,
          captured: collectedGeometry,
          geometry: {
            drawCalls: frame.geometry.drawCalls,
            vertices: frame.geometry.vertices,
          },
        });
        if (gxTextureCopies.length > 16) gxTextureCopies.shift();
        if (collectedGeometry) {
          if (gxSkippedFrameClearColor !== null) {
            postMessage({ type: "efb-clear", clearColor: gxSkippedFrameClearColor });
            gxSkippedFrameClearColor = null;
          }
          postRendererFrame("texture-copy", frame);
          gxTextureCopyFramesPresented += 1;
        } else if (frame.clear) {
          postMessage({ type: "efb-clear", clearColor: frame.clearColor });
        }
        gxFrameDraws = [];
        gxFrameDrawVertices = 0;
        gxFrameSkippedPrimitives = 0;
        gxCollectFrameGeometry = gxShouldCollectNextXfb();
        if (boundAsTexture) gxMarkTextureCopyConsumer(frame.destination);
        if (knownConsumer && !collectedGeometry) {
          // A producer setup that arrived after skipped primitives cannot be
          // reconstructed. Collect the next EFB segment from its boundary so
          // the following generation replaces the stale RAM fallback.
          gxTextureCopyProducerRecoveryArms += 1;
          gxCollectFrameGeometry = true;
        }
      }
    }

    function decodeGxCommands(source, start, end, inDisplayList = false) {
      let offset = start;
      while (offset < end) {
        const opcode = source[offset];
        let commandBytes;
        if ([0x00, 0x01, 0x44, 0x48].includes(opcode)) {
          commandBytes = 1;
        } else if (opcode === 0x08) {
          commandBytes = 6;
        } else if (opcode === 0x10) {
          if (end - offset < 5) break;
          commandBytes = 5 + ((((gxReadU32(source, offset + 1) >>> 16) & 15) + 1) * 4);
        } else if ([0x20, 0x28, 0x30, 0x38].includes(opcode)) {
          commandBytes = 5;
        } else if (opcode === 0x40) {
          commandBytes = 9;
        } else if (opcode === 0x61) {
          commandBytes = 5;
        } else if ((opcode & 0xc0) === 0x80) {
          if (end - offset < 3) break;
          const vertices = gxReadU16(source, offset + 1);
          commandBytes = 3 + vertices * gxVertexSize(opcode & 7);
        } else {
          gxUnknownOpcodes += 1;
          offset += 1;
          continue;
        }
        if (end - offset < commandBytes) break;

        if (opcode === 0x08) {
          gxCpRegisters[source[offset + 1]] = gxReadU32(source, offset + 2);
          gxCpLoads += 1;
        } else if (opcode === 0x10) {
          const command = gxReadU32(source, offset + 1);
          const count = ((command >>> 16) & 15) + 1;
          const address = command & 0xffff;
          for (let word = 0; word < count; word += 1) {
            recordGxXfWrite(address + word, gxReadU32(source, offset + 5 + word * 4));
          }
          gxXfLoads += 1;
        } else if ([0x20, 0x28, 0x30, 0x38].includes(opcode)) {
          recordGxIndexedXfWrite(opcode, gxReadU32(source, offset + 1));
          gxIndexedXfLoads += 1;
        } else if (opcode === 0x40) {
          gxDisplayLists += 1;
          const address = gxReadU32(source, offset + 1);
          const size = gxReadU32(source, offset + 5);
          gxDisplayListBytes += size;
          if (!inDisplayList) {
            const pointer = ramPointer(address, size);
            if (pointer === null) {
              gxDisplayListErrors += 1;
            } else {
              const displayList = bytes.subarray(pointer, pointer + size);
              const consumed = decodeGxCommands(displayList, 0, displayList.length, true);
              if (consumed !== displayList.length) gxDisplayListErrors += 1;
            }
          }
        } else if (opcode === 0x61) {
          recordGxBpWrite(gxReadU32(source, offset + 1));
        } else if ((opcode & 0xc0) === 0x80) {
          const vertices = gxReadU16(source, offset + 1);
          const vertexSize = gxVertexSize(opcode & 7);
          gxPrimitives += 1;
          gxVertices += vertices;
          recordGxPrimitive(opcode, source, offset + 3, vertices, vertexSize);
        }
        gxDecodedCommands += 1;
        offset += commandBytes;
      }
      return offset - start;
    }

    function decodeGxFifo() {
      const consumed = decodeGxCommands(gxDecodeBuffer, 0, gxDecodeBuffer.length);
      if (consumed !== 0) gxDecodeBuffer.splice(0, consumed);
    }

    function appendGxFifoBytes(source, stores, quantizedStores = 0) {
      for (let index = 0; index < source.length; index += 1) {
        const byte = source[index];
        gxFifoHash = Math.imul(gxFifoHash ^ byte, 0x01000193) >>> 0;
        if (gxFifoSample.length < 256) gxFifoSample.push(byte);
        gxDecodeBuffer.push(byte);
      }
      gxFifoStores += stores;
      gxFifoBytes += source.length;
      gxFifoQuantizedStores += quantizedStores;
      decodeGxFifo();
    }

    function appendGxFifo(size) {
      appendGxFifoBytes(
        new Uint8Array(gxFifoScratch.buffer, gxFifoScratch.byteOffset, size),
        1
      );
    }

    function drainGxFifoStaging() {
      const pendingBytes = view.getUint32(gxFifoStagingMeta, true);
      if (pendingBytes === 0) return;
      if (pendingBytes > gxFifoStagingCapacity) {
        throw new Error(`GX FIFO staging overflow: ${pendingBytes}`);
      }
      const stores = view.getUint32(gxFifoStagingMeta + 4, true);
      const quantizedStores = view.getUint32(gxFifoStagingMeta + 8, true);
      view.setUint32(gxFifoStagingMeta, 0, true);
      view.setUint32(gxFifoStagingMeta + 4, 0, true);
      view.setUint32(gxFifoStagingMeta + 8, 0, true);
      appendGxFifoBytes(
        bytes.subarray(gxFifoStagingData, gxFifoStagingData + pendingBytes),
        stores,
        quantizedStores
      );
      gxFifoStagingDrains += 1;
      gxFifoStagingStores += stores;
      gxFifoStagingBytes += pendingBytes;
      gxFifoStagingQuantizedStores += quantizedStores;
    }

    function traceDsp(event, details = {}) {
      if (dspTrace.length >= 48) return;
      dspTrace.push({
        event,
        pc: "0x" + (pc >>> 0).toString(16).padStart(8, "0"),
        cycles,
        ...details,
      });
    }

    function loadNextDspMail() {
      if (dspCurrentMail !== null || dspMailQueue.length === 0) return;
      const entry = dspMailQueue.shift();
      dspCurrentMail = entry.mail >>> 0;
      view.setUint16(mmio + 0x5004, (dspCurrentMail >>> 16) | 0x8000, false);
      view.setUint16(mmio + 0x5006, dspCurrentMail & 0xffff, false);
      if (entry.interrupt) {
        view.setUint16(mmio + 0x500a, view.getUint16(mmio + 0x500a, false) | 0x80, false);
      }
    }

    function pushDspMail(mail, interrupt = false, source = "dsp") {
      dspMailQueue.push({ mail: (mail | 0x80000000) >>> 0, interrupt });
      loadNextDspMail();
      traceDsp("mail-produced", { mail: hex32(mail), interrupt, source });
      deviceEvents.set("dspMailProduced", (deviceEvents.get("dspMailProduced") ?? 0) + 1);
    }

    function consumeDspMail() {
      if (dspCurrentMail === null) return;
      traceDsp("mail-consumed", { mail: hex32(dspCurrentMail) });
      dspCurrentMail = null;
      view.setUint16(mmio + 0x5004, 0, false);
      view.setUint16(mmio + 0x5006, 0, false);
      deviceEvents.set("dspMailConsumed", (deviceEvents.get("dspMailConsumed") ?? 0) + 1);
      loadNextDspMail();
    }

    function resetDspMailbox() {
      dspMailQueue.length = 0;
      dspCurrentMail = null;
      dspCpuMailbox = 0;
      dspRomParameter = null;
      dspMode = "rom";
      dspUcodeBooted = false;
      dspAxCommandListPending = false;
      dspScheduledMail = null;
      view.setUint16(mmio + 0x5000, 0, false);
      view.setUint16(mmio + 0x5002, 0, false);
      view.setUint16(mmio + 0x5004, 0, false);
      view.setUint16(mmio + 0x5006, 0, false);
      pushDspMail(0x8071feed, false, "reset");
      deviceEvents.set("dspReset", (deviceEvents.get("dspReset") ?? 0) + 1);
    }

    function initializeDspAudioSystem() {
      dspMailQueue.length = 0;
      dspCurrentMail = null;
      dspRomParameter = null;
      dspMode = "init";
      dspUcodeBooted = false;
      dspAxCommandListPending = false;
      dspScheduledMail = null;
      view.setUint16(mmio + 0x5004, 0, false);
      view.setUint16(mmio + 0x5006, 0, false);
      pushDspMail(0x80544348, false, "init-audio-system");
      deviceEvents.set(
        "dspInitAudioSystem",
        (deviceEvents.get("dspInitAudioSystem") ?? 0) + 1
      );
    }

    function handleDspCpuMail(mail) {
      deviceEvents.set("dspCpuMail", (deviceEvents.get("dspCpuMail") ?? 0) + 1);
      if (dspMode === "init") return;
      if (!dspUcodeBooted) {
        if (dspRomParameter === null) {
          if (((mail & 0xffff0000) >>> 0) === 0x80f30000) {
            dspRomParameter = mail >>> 0;
          } else {
            pushDspMail(0xfeee0000 | (mail & 0xffff));
          }
        } else {
          const parameter = dspRomParameter;
          dspRomParameter = null;
          if (parameter === 0x80f3d001) {
            dspMode = "ax";
            dspUcodeBooted = true;
            pushDspMail(0xdcd10000, true);
            deviceEvents.set("dspUcodeBoot", (deviceEvents.get("dspUcodeBoot") ?? 0) + 1);
          }
        }
      } else if (dspAxCommandListPending) {
        dspAxCommandListPending = false;
        dspScheduledMail = { mail: 0xdcd10002, completionCycle: cycles + 2500 };
        deviceEvents.set("dspAxCommandList", (deviceEvents.get("dspAxCommandList") ?? 0) + 1);
      } else if (mail === 0xcdd10000) {
        pushDspMail(0xdcd10001, true);
      } else if (mail === 0xcdd10002) {
        resetDspMailbox();
      } else if (((mail & 0xffff0000) >>> 0) === 0xbabe0000) {
        dspAxCommandListPending = true;
      }
    }

    function readCommandProcessorStatus() {
      const idleMask = cpStatusReadIdle | cpStatusCommandIdle;
      const pendingStagingBytes = view.getUint32(gxFifoStagingMeta, true);
      const idle = pendingStagingBytes === 0 && gxDecodeBuffer.length === 0;
      const stored = view.getUint16(mmio, false) & ~idleMask;
      return stored | (idle ? idleMask : 0);
    }

    function readInteger(address, pointer, size) {
      const logical = address >>> 0;
      if (logical === 0xcc000000 && size === 2) {
        view.setUint16(pointer, readCommandProcessorStatus(), true);
        return 1;
      }
      if (logical === 0xcc006c08 && size === 4) {
        updateAudioSampleCounter(cycles);
      }
      if (logical === 0xcc00503a && size === 2) {
        view.setUint16(pointer, dspAudioDmaBlocksLeft(), true);
        return 1;
      }
      if (logical === 0xcc005038 && size === 4) {
        publishDspAudioDmaBlocksLeft();
      }
      const lockedSource = lockedCachePointer(address, size);
      const source = ramPointer(address, size) ?? mmioPointer(address, size) ?? lockedSource;
      if (source === null) {
        lastUnmappedAccess = {
          kind: "read",
          address: hex32(logical),
          size,
          pc: hex32(view.getUint32(cpu + pcOffset, true)),
          r1: hex32(readGpr(1)),
          dispatch: dispatches,
        };
        return 0;
      }
      switch (size) {
        case 1:
          view.setUint8(pointer, view.getUint8(source));
          break;
        case 2:
          view.setUint16(pointer, view.getUint16(source, false), true);
          break;
        case 4:
          view.setUint32(pointer, view.getUint32(source, false), true);
          break;
        case 8:
          view.setBigUint64(pointer, view.getBigUint64(source, false), true);
          break;
        default:
          return 0;
      }
      if (lockedSource !== null) {
        lockedCacheReads += 1;
        lockedCacheReadBytes += size;
      }
      if (logical === 0xcc005006 && size === 2) consumeDspMail();
      if (size === 4 && logical >= 0xcc006404 && logical <= 0xcc00642c) {
        const channelOffset = logical - 0xcc006404;
        const registerOffset = channelOffset % 12;
        if (registerOffset === 0 || registerOffset === 4) {
          const channel = Math.floor(channelOffset / 12);
          const inputReady = 0x20000000 >>> (channel * 8);
          const status = view.getUint32(mmio + 0x6438, false) & ~inputReady;
          view.setUint32(mmio + 0x6438, status >>> 0, false);
          recomputeSerialInterruptLevel("input-read");
          deviceEvents.set(
            "serialInputRead",
            (deviceEvents.get("serialInputRead") ?? 0) + 1
          );
        }
      }
      return 1;
    }

    function recomputeSerialInterruptLevel(reason) {
      const status = view.getUint32(mmio + 0x6438, false);
      const beforeControl = view.getUint32(mmio + 0x6434, false);
      let control = beforeControl;
      if ((status & siStatusInputReadyMask) !== 0) {
        control |= siReadStatusInterrupt;
      } else {
        control &= ~siReadStatusInterrupt;
      }
      control >>>= 0;
      view.setUint32(mmio + 0x6434, control, false);

      const active = (
        (control & siReadStatusInterrupt) !== 0
        && (control & siReadStatusInterruptMask) !== 0
      ) || (
        (control & siTransferInterrupt) !== 0
        && (control & siTransferInterruptMask) !== 0
      );
      const beforeCause = view.getUint32(mmio + 0x3000, false);
      const cause = (
        active
          ? beforeCause | piSerialInterruptCause
          : beforeCause & ~piSerialInterruptCause
      ) >>> 0;
      view.setUint32(mmio + 0x3000, cause, false);
      if (active !== serialInterruptLevelActive) {
        serialInterruptLevelChanges += 1;
      }
      serialInterruptLevelActive = active;
      serialInterruptLevelReason = reason;
      return active;
    }

    function serialNoResponseBit(channel) {
      check(channel >= 0 && channel < 4, "invalid serial channel");
      return 0x08000000 >>> (channel * 8);
    }

    function processSerialOutputCommand(channel, poll) {
      const output = view.getUint32(mmio + 0x6400 + channel * 12, false);
      const command = (output >>> 16) & 0xff;
      const mode = (output >>> 8) & 0xff;
      const motor = output & 0xff;
      serialOutputCommandsByChannel[channel] += 1;

      // Only socket one has a controller in this harness. The SI hardware
      // still dispatches every OUT register; null devices ignore it.
      if (channel !== 0 || command === 0x00) return;
      if (command !== 0x40) {
        serialUnknownOutputCommands += 1;
        deviceEvents.set("serialUnknownOutputCommand", command);
        return;
      }

      serialControllerRumble[channel] = motor === 1;
      const enabled = (poll & (0x80 >>> channel)) !== 0;
      if (!enabled) serialControllerModes[channel] = mode;
      deviceEvents.set(
        "serialOutputCommand",
        (deviceEvents.get("serialOutputCommand") ?? 0) + 1
      );
    }

    function writeSerialStatus(value) {
      const current = view.getUint32(mmio + 0x6438, false);
      const written = value >>> 0;
      const clearedErrors = current & written & siStatusErrorWriteOneToClear;
      for (let channel = 0; channel < 4; channel += 1) {
        const noResponse = serialNoResponseBit(channel);
        if ((clearedErrors & noResponse) !== 0) {
          serialNoResponseAcknowledgedByChannel[channel] += 1;
        }
      }
      let next = (current & ~clearedErrors) >>> 0;
      if ((written & siStatusWrite) !== 0) {
        const poll = view.getUint32(mmio + 0x6430, false);
        for (let channel = 0; channel < 4; channel += 1) {
          processSerialOutputCommand(channel, poll);
        }
        next &= ~(siStatusWrite | siStatusWriteStatusMask);
        deviceEvents.set(
          "serialStatusCommand",
          (deviceEvents.get("serialStatusCommand") ?? 0) + 1
        );
      }
      view.setUint32(mmio + 0x6438, next >>> 0, false);
      recomputeSerialInterruptLevel("status-write");
    }

    function writeSerialControl(value) {
      const current = view.getUint32(mmio + 0x6434, false);
      const written = value >>> 0;
      const readInterrupt = (current & siReadStatusInterrupt)
        & ~(written & siReadStatusInterrupt);
      const communicationError = current & siCommunicationError;
      const transferInterrupt = (current & siTransferInterrupt)
        & ~(written & siTransferInterrupt);
      const transferStart = (current | written) & siTransferStart;
      const next = (written & 0x4ffffffe)
        | readInterrupt
        | communicationError
        | transferInterrupt
        | transferStart;
      view.setUint32(mmio + 0x6434, next >>> 0, false);
      if (
        (current & siTransferInterrupt) !== 0
        && (written & siTransferInterrupt) !== 0
      ) {
        serialTransferInterruptAcknowledgements += 1;
      }
      if ((written & siTransferStart) !== 0) {
        serialTransfer = {
          channel: (next >>> 1) & 3,
          completionCycle: cycles + 200,
        };
        deviceEvents.set("serialTransfer", (deviceEvents.get("serialTransfer") ?? 0) + 1);
      }
      recomputeSerialInterruptLevel("control-write");
    }

    function recomputeDiskInterruptLevel() {
      const status = view.getUint32(mmio + 0x6000, false);
      const active = ((status & 0x04) !== 0 && (status & 0x02) !== 0)
        || ((status & 0x10) !== 0 && (status & 0x08) !== 0)
        || ((status & 0x40) !== 0 && (status & 0x20) !== 0);
      const beforeCause = view.getUint32(mmio + 0x3000, false);
      const cause = (
        active
          ? beforeCause | piDiskInterruptCause
          : beforeCause & ~piDiskInterruptCause
      ) >>> 0;
      view.setUint32(mmio + 0x3000, cause, false);
      return active;
    }

    function writeDiskStatus(value) {
      const current = view.getUint32(mmio + 0x6000, false);
      const written = value >>> 0;
      const statuses = (current & diInterruptStatuses)
        & ~(written & diInterruptStatuses);
      const next = (
        statuses
        | (written & diInterruptMasks)
        | (written & diBreakRequest)
      ) >>> 0;
      view.setUint32(mmio + 0x6000, next, false);
      recomputeDiskInterruptLevel();
    }

    function writePixelEngineControl(value) {
      const written = value & 0xffff;
      if ((written & 0x08) !== 0) {
        peFinishSignal = false;
        peFinishInterruptDelivered = false;
        deviceEvents.set(
          "peFinishAcknowledge",
          (deviceEvents.get("peFinishAcknowledge") ?? 0) + 1
        );
      }
      view.setUint16(mmio + 0x100a, written & 3, false);
    }

    function audioCyclesPerSample(control) {
      return 486_000_000 / ((control & 2) !== 0 ? 48_043 : 32_029);
    }

    function nextAudioSampleCycle() {
      const control = view.getUint32(mmio + 0x6c00, false);
      return (control & 1) === 0
        ? null
        : Math.ceil(aiLastCycle + audioCyclesPerSample(control));
    }

    function updateAudioSampleCounter(observedCycles) {
      const control = view.getUint32(mmio + 0x6c00, false);
      if ((control & 1) === 0) return;
      const cyclesPerSample = audioCyclesPerSample(control);
      const samples = Math.floor((observedCycles - aiLastCycle) / cyclesPerSample);
      if (samples <= 0) return;
      const oldCounter = aiSampleCounter >>> 0;
      aiSampleCounter = (aiSampleCounter + samples) >>> 0;
      aiLastCycle += samples * cyclesPerSample;
      view.setUint32(mmio + 0x6c08, aiSampleCounter, false);

      const firstNewSample = (oldCounter + 1) >>> 0;
      const interruptTiming = view.getUint32(mmio + 0x6c0c, false);
      if (
        ((interruptTiming - firstNewSample) >>> 0)
        <= ((aiSampleCounter - firstNewSample) >>> 0)
      ) {
        view.setUint32(mmio + 0x6c00, control | 0x08, false);
        deviceEvents.set("aiInterrupt", (deviceEvents.get("aiInterrupt") ?? 0) + 1);
      }
      deviceEvents.set("aiSamples", (deviceEvents.get("aiSamples") ?? 0) + samples);
    }

    function writeAudioControl(value) {
      updateAudioSampleCounter(cycles);
      const current = view.getUint32(mmio + 0x6c00, false);
      const written = value >>> 0;
      const wasPlaying = (current & 1) !== 0;
      let next = written & 0x57;
      next |= (current & 0x08) & ~(written & 0x08);
      if ((written & 0x20) !== 0) {
        aiSampleCounter = 0;
        view.setUint32(mmio + 0x6c08, 0, false);
      }
      if (wasPlaying !== ((next & 1) !== 0) || (written & 0x20) !== 0) {
        aiLastCycle = cycles;
      }
      if ((next & 0x08) === 0) aiInterruptDelivered = false;
      view.setUint32(mmio + 0x6c00, next >>> 0, false);
      const playStateChanged = wasPlaying !== ((next & 1) !== 0);
      const streamRateChanged = ((current ^ next) & 2) !== 0;
      updateDiskAudioSchedule(cycles, playStateChanged || streamRateChanged);
    }

    function dspAudioDmaCyclesPerBlock() {
      const control = view.getUint32(mmio + 0x6c00, false);
      const sampleRate = (control & 0x40) !== 0 ? 32_029 : 48_043;
      return Math.ceil((8 * 486_000_000) / sampleRate);
    }

    function dspAudioDmaBlocksLeft() {
      return dspAudioDmaRemainingBlocks > 0
        ? (dspAudioDmaRemainingBlocks - 1) & 0x7fff
        : 0;
    }

    function publishDspAudioDmaBlocksLeft() {
      view.setUint16(mmio + 0x503a, dspAudioDmaBlocksLeft(), false);
    }

    function assertDspAudioDmaInterrupt(eventName) {
      view.setUint16(
        mmio + 0x500a,
        view.getUint16(mmio + 0x500a, false) | 0x0008,
        false
      );
      deviceEvents.set(eventName, (deviceEvents.get(eventName) ?? 0) + 1);
    }

    function startDspAudioDma() {
      dspAudioDmaRemainingBlocks = view.getUint16(mmio + 0x5036, false) & 0x7fff;
      nextDspAudioDmaCycle = dspAudioDmaRemainingBlocks === 0
        ? null
        : Math.ceil(cycles + dspAudioDmaCyclesPerBlock());
      nextDspAudioDmaInterruptCycle = cycles + dspAudioDmaEnableInterruptLatencyCycles;
      publishDspAudioDmaBlocksLeft();
      deviceEvents.set(
        "dspAudioDmaStart",
        (deviceEvents.get("dspAudioDmaStart") ?? 0) + 1
      );
    }

    function stopDspAudioDma() {
      dspAudioDmaRemainingBlocks = 0;
      nextDspAudioDmaCycle = null;
      nextDspAudioDmaInterruptCycle = null;
      publishDspAudioDmaBlocksLeft();
      deviceEvents.set(
        "dspAudioDmaStop",
        (deviceEvents.get("dspAudioDmaStop") ?? 0) + 1
      );
    }

    function resetDspAudioDma() {
      view.setUint16(mmio + 0x5036, 0, false);
      stopDspAudioDma();
    }

    function writeDspAudioDmaControl(value) {
      const current = view.getUint16(mmio + 0x5036, false);
      const wasEnabled = (current & 0x8000) !== 0;
      const written = value & 0xffff;
      const enabled = (written & 0x8000) !== 0;
      view.setUint16(mmio + 0x5036, written, false);

      if (!wasEnabled && enabled) {
        startDspAudioDma();
      } else if (wasEnabled && !enabled) {
        stopDspAudioDma();
      } else {
        publishDspAudioDmaBlocksLeft();
      }
    }

    function serviceDspAudioDma(observedCycles) {
      if (
        nextDspAudioDmaInterruptCycle !== null
        && observedCycles >= nextDspAudioDmaInterruptCycle
      ) {
        nextDspAudioDmaInterruptCycle = null;
        assertDspAudioDmaInterrupt("dspAudioDmaInitialInterrupt");
      }
      while (nextDspAudioDmaCycle !== null && observedCycles >= nextDspAudioDmaCycle) {
        const eventCycle = nextDspAudioDmaCycle;
        dspAudioDmaRemainingBlocks -= 1;
        deviceEvents.set(
          "dspAudioDmaBlock",
          (deviceEvents.get("dspAudioDmaBlock") ?? 0) + 1
        );

        if (dspAudioDmaRemainingBlocks === 0) {
          assertDspAudioDmaInterrupt("dspAudioDmaComplete");
          dspAudioDmaRemainingBlocks = view.getUint16(mmio + 0x5036, false) & 0x7fff;
        }

        const enabled = (view.getUint16(mmio + 0x5036, false) & 0x8000) !== 0;
        nextDspAudioDmaCycle = enabled && dspAudioDmaRemainingBlocks !== 0
          ? Math.ceil(eventCycle + dspAudioDmaCyclesPerBlock())
          : null;
        publishDspAudioDmaBlocksLeft();
      }
    }

    function startAramDma(value) {
      const written = value >>> 0;
      const countAndDirection = (
        (((written >>> 16) & 0x83ff) << 16)
        | (written & 0xffe0)
      ) >>> 0;
      const length = countAndDirection & 0x7fffffe0;
      const direction = countAndDirection >>> 31;
      const mmAddress = view.getUint32(mmio + 0x5020, false) & 0x03ffffe0;
      const aramAddress = view.getUint32(mmio + 0x5024, false) & 0x03ffffe0;
      const transferCycles = Math.max(1, (length / 32) * 246);

      view.setUint32(mmio + 0x5028, countAndDirection, false);
      view.setUint16(
        mmio + 0x500a,
        view.getUint16(mmio + 0x500a, false) | 0x0200,
        false
      );
      aramTransfer = {
        direction,
        mmAddress,
        aramAddress,
        length,
        completionCycle: cycles + transferCycles,
      };
      deviceEvents.set("aramDmaStart", (deviceEvents.get("aramDmaStart") ?? 0) + 1);
    }

    function serviceAramDma(observedCycles) {
      if (aramTransfer === null || observedCycles < aramTransfer.completionCycle) return;

      const { direction, mmAddress, aramAddress, length } = aramTransfer;
      const ramTarget = ramPointer(mmAddress, length);
      if (ramTarget === null) {
        deviceEvents.set(
          "aramDmaUnmappedRam",
          (deviceEvents.get("aramDmaUnmappedRam") ?? 0) + 1
        );
      } else if (direction !== 0) {
        if (aramAddress >= aram.length) {
          bytes.fill(0, ramTarget, ramTarget + length);
        } else {
          let copied = 0;
          while (copied < length) {
            const source = (aramAddress + copied) & (aram.length - 1);
            const chunk = Math.min(length - copied, aram.length - source);
            bytes.set(aram.subarray(source, source + chunk), ramTarget + copied);
            copied += chunk;
          }
        }
      } else if (aramAddress < aram.length) {
        let copied = 0;
        while (copied < length) {
          const target = (aramAddress + copied) & (aram.length - 1);
          const chunk = Math.min(length - copied, aram.length - target);
          aram.set(bytes.subarray(ramTarget + copied, ramTarget + copied + chunk), target);
          copied += chunk;
        }
      }

      view.setUint32(mmio + 0x5020, (mmAddress + length) & 0x03ffffe0, false);
      view.setUint32(mmio + 0x5024, (aramAddress + length) & 0x03ffffe0, false);
      view.setUint32(mmio + 0x5028, direction === 0 ? 0 : 0x80000000, false);
      view.setUint16(
        mmio + 0x500a,
        (view.getUint16(mmio + 0x500a, false) & ~0x0200) | 0x0020,
        false
      );
      aramTransfer = null;
      deviceEvents.set(
        "aramDmaComplete",
        (deviceEvents.get("aramDmaComplete") ?? 0) + 1
      );
    }

    function writeDspControl(value) {
      const current = view.getUint16(mmio + 0x500a, false);
      const written = value & 0xffff;
      const interruptStatuses = 0x00a8;
      const status = (current & interruptStatuses) & ~(written & interruptStatuses);
      let next = (written & ~interruptStatuses) | status;
      if ((written & 1) !== 0) {
        resetDspMailbox();
        resetDspAudioDma();
        next &= ~1;
      }
      if ((current & 0x0800) !== 0 && (next & 0x0800) === 0) {
        initializeDspAudioSystem();
      }
      view.setUint16(mmio + 0x500a, next, false);
      traceDsp("control-write", {
        current: "0x" + current.toString(16).padStart(4, "0"),
        written: "0x" + written.toString(16).padStart(4, "0"),
        next: "0x" + next.toString(16).padStart(4, "0"),
      });
    }

    function writeDspMailboxHigh(value) {
      dspCpuMailbox = (((value & 0x7fff) << 16) | (dspCpuMailbox & 0xffff)) >>> 0;
      view.setUint16(mmio + 0x5000, value & 0x7fff, false);
    }

    function writeDspMailboxLow(value) {
      dspCpuMailbox = ((dspCpuMailbox & 0xffff0000) | (value & 0xffff)) >>> 0;
      view.setUint16(mmio + 0x5000, (dspCpuMailbox >>> 16) | 0x8000, false);
      view.setUint16(mmio + 0x5002, dspCpuMailbox & 0xffff, false);
      handleDspCpuMail((dspCpuMailbox | 0x80000000) >>> 0);
      view.setUint16(mmio + 0x5000, (dspCpuMailbox >>> 16) & 0x7fff, false);
    }

    function writeInteger(address, value, size) {
      const logical = address >>> 0;
      if (logical >= 0xcc008000 && logical < 0xcc008020) {
        switch (size) {
          case 1: gxFifoScratch.setUint8(0, value); break;
          case 2: gxFifoScratch.setUint16(0, value, false); break;
          case 4: gxFifoScratch.setUint32(0, value, false); break;
          case 8: gxFifoScratch.setBigUint64(0, BigInt.asUintN(64, value), false); break;
          default: return 0;
        }
        appendGxFifo(size);
        return 1;
      }
      if (logical === 0xcc006434 && size === 4) {
        writeSerialControl(value);
        return 1;
      }
      if (logical === 0xcc006438 && size === 4) {
        writeSerialStatus(value);
        return 1;
      }
      if (logical === 0xcc006000 && size === 4) {
        writeDiskStatus(value);
        return 1;
      }
      if (logical === 0xcc00100a && size === 2) {
        writePixelEngineControl(value);
        return 1;
      }
      if (logical === 0xcc006c00 && size === 4) {
        writeAudioControl(value);
        return 1;
      }
      if (logical === 0xcc006c08 && size === 4) {
        aiSampleCounter = value >>> 0;
        aiLastCycle = cycles;
        view.setUint32(mmio + 0x6c08, aiSampleCounter, false);
        return 1;
      }
      if (logical === 0xcc005000 && size === 2) {
        writeDspMailboxHigh(value);
        return 1;
      }
      if (logical === 0xcc005002 && size === 2) {
        writeDspMailboxLow(value);
        return 1;
      }
      if (logical === 0xcc00500a && size === 2) {
        writeDspControl(value);
        return 1;
      }
      if (logical === 0xcc005034 && size === 4) {
        view.setUint16(mmio + 0x5034, (value >>> 16) & 0xffff, false);
        writeDspAudioDmaControl(value & 0xffff);
        return 1;
      }
      if (logical === 0xcc005036 && size === 2) {
        writeDspAudioDmaControl(value);
        return 1;
      }
      if (logical === 0xcc005028 && size === 4) {
        startAramDma(value);
        return 1;
      }
      if (logical === 0xcc005028 && size === 2) {
        view.setUint16(mmio + 0x5028, value & 0x83ff, false);
        return 1;
      }
      if (logical === 0xcc00502a && size === 2) {
        const countAndDirection = (
          (view.getUint16(mmio + 0x5028, false) << 16)
          | (value & 0xffe0)
        ) >>> 0;
        startAramDma(countAndDirection);
        return 1;
      }

      const lockedTarget = lockedCachePointer(address, size);
      const target = ramPointer(address, size) ?? mmioPointer(address, size) ?? lockedTarget;
      if (target === null) {
        lastUnmappedAccess = {
          kind: "write",
          address: hex32(logical),
          size,
          value: size === 8 ? "0x" + BigInt.asUintN(64, value).toString(16) : hex32(value),
          pc: hex32(view.getUint32(cpu + pcOffset, true)),
          r1: hex32(readGpr(1)),
          dispatch: dispatches,
        };
        return 0;
      }
      switch (size) {
        case 1:
          view.setUint8(target, value);
          break;
        case 2:
          view.setUint16(target, value, false);
          break;
        case 4:
          view.setUint32(target, value, false);
          break;
        case 8:
          view.setBigUint64(target, BigInt.asUintN(64, value), false);
          break;
        default:
          return 0;
      }
      if (logical >= 0xcc002000 && logical < 0xcc002070) {
        const start = logical - 0xcc002000;
        const end = start + size;
        if (
          (start < 0x14 && end > 0x00)
          || (start < 0x40 && end > 0x30)
          || (start < 0x6e && end > 0x6c)
        ) {
          viScheduleDirty = true;
        }
      }
      if (logical < 0xcc006434 && logical + size > 0xcc006430) {
        viScheduleDirty = true;
      }
      if (lockedTarget !== null) {
        lockedCacheWrites += 1;
        lockedCacheWriteBytes += size;
      }
      return 1;
    }

    function signedSix(value) {
      const bits = value & 0x3f;
      return (bits & 0x20) === 0 ? bits : bits - 0x40;
    }

    function quantizedStoreValue(type, value) {
      if (type === 0) return value;
      if (Number.isNaN(value)) return 0;
      const [minimum, maximum] = type === 4 ? [0, 255]
        : type === 5 ? [0, 65535]
        : type === 6 ? [-128, 127]
        : [-32768, 32767];
      return Math.trunc(Math.max(minimum, Math.min(maximum, value)));
    }

    function readQuantized(address, gqr, pointer) {
      const type = (gqr >>> 16) & 7;
      const size = type === 0 ? 4 : (type === 4 || type === 6 ? 1 : 2);
      if (![0, 4, 5, 6, 7].includes(type)) return 0;
      const lockedSource = lockedCachePointer(address, size);
      const source = ramPointer(address, size) ?? lockedSource;
      if (source === null) return 0;
      let value;
      switch (type) {
        case 0: value = view.getFloat32(source, false); break;
        case 4: value = view.getUint8(source); break;
        case 5: value = view.getUint16(source, false); break;
        case 6: value = view.getInt8(source); break;
        case 7: value = view.getInt16(source, false); break;
      }
      const scale = type === 0 ? 0 : signedSix(gqr >>> 24);
      view.setFloat64(pointer, value * (2 ** -scale), true);
      if (lockedSource !== null) {
        lockedCacheReads += 1;
        lockedCacheReadBytes += size;
      }
      return size;
    }

    function writeQuantized(address, gqr, value) {
      const type = gqr & 7;
      const size = type === 0 ? 4 : (type === 4 || type === 6 ? 1 : 2);
      if (![0, 4, 5, 6, 7].includes(type)) return 0;
      const scale = type === 0 ? 0 : signedSix(gqr >>> 8);
      const scaled = value * (2 ** scale);
      const stored = quantizedStoreValue(type, scaled);
      const logical = address >>> 0;
      if (logical >= 0xcc008000 && logical < 0xcc008020) {
        switch (type) {
          case 0: gxFifoScratch.setFloat32(0, stored, false); break;
          case 4: gxFifoScratch.setUint8(0, stored); break;
          case 5: gxFifoScratch.setUint16(0, stored, false); break;
          case 6: gxFifoScratch.setInt8(0, stored); break;
          case 7: gxFifoScratch.setInt16(0, stored, false); break;
        }
        appendGxFifo(size);
        gxFifoQuantizedStores += 1;
        return size;
      }
      const lockedTarget = lockedCachePointer(address, size);
      const target = ramPointer(address, size) ?? lockedTarget;
      if (target === null) return 0;
      switch (type) {
        case 0: view.setFloat32(target, stored, false); break;
        case 4: view.setUint8(target, stored); break;
        case 5: view.setUint16(target, stored, false); break;
        case 6: view.setInt8(target, stored); break;
        case 7: view.setInt16(target, stored, false); break;
      }
      if (lockedTarget !== null) {
        lockedCacheWrites += 1;
        lockedCacheWriteBytes += size;
      }
      return size;
    }

    function loadSections(fileBase, targetBase, sizeBase, count) {
      for (let index = 0; index < count; index += 1) {
        const size = dolU32(sizeBase + index * 4);
        if (size === 0) continue;
        const fileOffset = dolU32(fileBase + index * 4);
        const target = dolU32(targetBase + index * 4);
        check(fileOffset + size <= dol.length, "DOL section extends past the file");
        const targetPointer = ramPointer(target, size);
        check(targetPointer !== null, "DOL section extends past main RAM");
        bytes.set(dol.subarray(fileOffset, fileOffset + size), targetPointer);
      }
    }

    function initializeFastmem() {
      for (let index = 0; index < __FASTMEM_LUT_COUNT__; index += 1) {
        view.setUint32(fastmem + index * 4, 0, true);
      }
      const pageSize = 1 << __FASTMEM_PAGE_SHIFT__;
      for (let physical = 0; physical < ramSize; physical += pageSize) {
        const pointer = ram + physical;
        const cached = (0x80000000 + physical) >>> 0;
        const uncached = (0xc0000000 + physical) >>> 0;
        view.setUint32(fastmem + (physical >>> __FASTMEM_PAGE_SHIFT__) * 4, pointer, true);
        view.setUint32(fastmem + (cached >>> __FASTMEM_PAGE_SHIFT__) * 4, pointer, true);
        view.setUint32(fastmem + (uncached >>> __FASTMEM_PAGE_SHIFT__) * 4, pointer, true);
      }
    }

    function writePhysical32(address, value) {
      view.setUint32(ram + address, value >>> 0, false);
    }

    function initializeLowMemory() {
      writePhysical32(0x00, boot.gameCode);
      view.setUint16(ram + 0x04, boot.makerCode, false);
      bytes[ram + 0x06] = boot.discId;
      bytes[ram + 0x07] = boot.version;
      bytes[ram + 0x08] = boot.audioStreaming;
      bytes[ram + 0x09] = boot.streamBufferSize;
      writePhysical32(0x1c, 0xc2339f3d);
      writePhysical32(0x20, 0x0d15ea5e);
      writePhysical32(0x24, 1);
      writePhysical32(0x28, 0x01800000);
      writePhysical32(0x2c, 0x10000005);
      // The retail apploader clears ArenaLo before handing control to the
      // game. Its OSInit then substitutes the executable's linked arena
      // boundary; publishing the IPL-HLE arena here needlessly shrinks the
      // game's heaps.
      writePhysical32(0x30, 0);
      writePhysical32(0x34, fstAddress);
      writePhysical32(0x38, fstAddress);
      writePhysical32(0x3c, fstMaxSize);
      writePhysical32(0xcc, boot.tvMode);
      writePhysical32(0xd0, 0x01000000);
      writePhysical32(0xf4, bi2Address);
      writePhysical32(0xf8, 0x09a7ec80);
      writePhysical32(0xfc, 0x1cf7c580);
    }

    function loadBootData() {
      bytes.set(bi2, ram + physicalOffset(bi2Address));
      bytes.set(fst, ram + physicalOffset(fstAddress));
    }

    function fetchWord(pc) {
      const pointer = ramPointer(pc, 4);
      check(pointer !== null, "address is outside mapped main RAM: 0x" + (pc >>> 0).toString(16));
      return view.getUint32(pointer, false);
    }

    function cpuSignature() {
      let signature = 0x811c9dc5;
      for (let offset = 0; offset < 1024; offset += 4) {
        signature = Math.imul(signature ^ view.getUint32(cpu + offset, true), 0x01000193);
      }
      return signature >>> 0;
    }

    function inspectMmio(address) {
      const logical = address >>> 0;
      const offset = logical - 0xcc000000;
      if (offset < 0 || offset + 4 > mmioSize) return null;
      return {
        address: "0x" + logical.toString(16).padStart(8, "0"),
        value: "0x" + view.getUint32(mmio + offset, false).toString(16).padStart(8, "0"),
      };
    }

    function inspectRamWords(address, count) {
      const pointer = ramPointer(address, count * 4);
      if (pointer === null) return null;
      return Array.from({ length: count }, (_unused, index) =>
        "0x" + view.getUint32(pointer + index * 4, false).toString(16).padStart(8, "0")
      );
    }

    function inspectPadStatus(address) {
      const pointer = ramPointer(address, 12);
      if (pointer === null) return null;
      return {
        address: hex32(address >>> 0),
        buttons: view.getUint16(pointer, false),
        stickX: view.getInt8(pointer + 2),
        stickY: view.getInt8(pointer + 3),
        cStickX: view.getInt8(pointer + 4),
        cStickY: view.getInt8(pointer + 5),
        triggerL: view.getUint8(pointer + 6),
        triggerR: view.getUint8(pointer + 7),
        analogA: view.getUint8(pointer + 8),
        analogB: view.getUint8(pointer + 9),
        error: view.getInt8(pointer + 10),
      };
    }

    function inspectSuperMonkeyBallPad0() {
      if (boot.identifier !== "GMBE8P") return null;
      // GMBE8P's input_main stores five consecutive PADStatus snapshots for
      // controller zero. Character Select tests the pressed/new snapshot.
      const controllerInfo = 0x801f3b70;
      return {
        controllerInfo: hex32(controllerInfo),
        held: inspectPadStatus(controllerInfo),
        previous: inspectPadStatus(controllerInfo + 0x0c),
        pressed: inspectPadStatus(controllerInfo + 0x18),
        released: inspectPadStatus(controllerInfo + 0x24),
        repeat: inspectPadStatus(controllerInfo + 0x30),
      };
    }

    function guestU32(address) {
      const pointer = ramPointer(address, 4);
      return pointer === null ? null : view.getUint32(pointer, false);
    }

    function guestU16(address) {
      const pointer = ramPointer(address, 2);
      return pointer === null ? null : view.getUint16(pointer, false);
    }

    function guestS32(address) {
      const pointer = ramPointer(address, 4);
      return pointer === null ? null : view.getInt32(pointer, false);
    }

    function guestS16(address) {
      const pointer = ramPointer(address, 2);
      return pointer === null ? null : view.getInt16(pointer, false);
    }

    function inspectSuperMonkeyBallGameState() {
      if (boot.identifier !== "GMBE8P") return null;

      // Retail GMBE8P's READY-main routine at 0x80012e6c unconditionally
      // counts modeCtrl.submodeTimer down unless gamePauseStatus & 0x0a is
      // nonzero. Expose the exact gate and transition request so a snapshot
      // can distinguish the normal 360-frame first-attempt fly-in from a
      // genuinely stalled stage start.
      const modeControl = 0x801eec20;
      const gamePauseStatusAddress = 0x802f1ee0;
      const gameSubmodeRequestAddress = 0x802f1b8c;
      const gameSubmodeAddress = 0x802f1b8e;
      const pauseStatus = guestU32(gamePauseStatusAddress);
      const submodeTimer = guestS32(modeControl);
      const submodeRequest = guestS16(gameSubmodeRequestAddress);
      const submode = guestS16(gameSubmodeAddress);
      return {
        modeControl: hex32(modeControl),
        gamePauseStatusAddress: hex32(gamePauseStatusAddress),
        gameSubmodeRequestAddress: hex32(gameSubmodeRequestAddress),
        gameSubmodeAddress: hex32(gameSubmodeAddress),
        pauseStatus: hex32(pauseStatus),
        readyPauseGateActive: pauseStatus === null ? null : (pauseStatus & 0x0a) !== 0,
        submodeTimer,
        submodeRequest,
        submode,
        readyMain: submode === 0x31,
        playRequested: submodeRequest === 0x32 || submode >= 0x32,
      };
    }

    function hex32(value) {
      return value === null ? null : "0x" + value.toString(16).padStart(8, "0");
    }

    function inspectStackTrace(savedSp, stack, stackEnd) {
      if (savedSp === null || stack === null || stackEnd === null) return null;
      const lowerBound = Math.min(stack, stackEnd);
      const upperBound = Math.max(stack, stackEnd);
      const frames = [];
      const seen = new Set();
      let frame = savedSp;
      while (frames.length < 24) {
        if (
          frame < lowerBound || frame + 8 > upperBound ||
          (frame & 3) !== 0 || seen.has(frame)
        ) break;
        seen.add(frame);
        const callerFrame = guestU32(frame);
        if (
          callerFrame === null || callerFrame === 0 || callerFrame <= frame ||
          callerFrame < lowerBound || callerFrame + 8 > upperBound ||
          (callerFrame & 3) !== 0
        ) break;
        const returnAddress = guestU32(callerFrame + 4);
        frames.push({
          frame: hex32(frame),
          callerFrame: hex32(callerFrame),
          returnAddress: hex32(returnAddress),
          callSite: returnAddress === null || returnAddress < 4 ? null : hex32(returnAddress - 4),
          callerWords: inspectRamWords(callerFrame, 4),
        });
        frame = callerFrame;
      }
      return frames;
    }

    function inspectOsThreads() {
      const activeHead = guestU32(0x800000dc);
      const addresses = [];
      const seen = new Set();
      const append = address => {
        if (address === null || address === 0 || seen.has(address) || addresses.length >= 24) {
          return false;
        }
        if (ramPointer(address, 0x318) === null) return false;
        seen.add(address);
        addresses.push(address);
        return true;
      };

      if (activeHead !== null && activeHead !== 0) {
        const before = [];
        let address = guestU32(activeHead + 0x300);
        while (address !== null && address !== 0 && before.length < 12) {
          if (seen.has(address) || ramPointer(address, 0x318) === null) break;
          seen.add(address);
          before.push(address);
          address = guestU32(address + 0x300);
        }
        before.reverse();
        addresses.push(...before);
        append(activeHead);
        address = guestU32(activeHead + 0x2fc);
        while (append(address)) address = guestU32(address + 0x2fc);
      }

      const stateNames = new Map([
        [1, "ready"],
        [2, "running"],
        [4, "waiting"],
        [8, "moribund"],
      ]);
      return {
        currentContext: hex32(guestU32(0x800000d4)),
        currentThread: hex32(guestU32(0x800000d8)),
        activeHead: hex32(activeHead),
        activeTail: hex32(guestU32(0x800000e0)),
        threads: addresses.map(address => {
          const state = guestU16(address + 0x2c8);
          const queue = guestU32(address + 0x2dc);
          const stack = guestU32(address + 0x304);
          const stackEnd = guestU32(address + 0x308);
          const savedSp = guestU32(address + 0x04);
          return {
            address: hex32(address),
            state,
            stateName: stateNames.get(state) ?? "unknown",
            detached: guestU16(address + 0x2ca),
            suspend: guestU32(address + 0x2cc),
            effectivePriority: guestU32(address + 0x2d0),
            basePriority: guestU32(address + 0x2d4),
            savedPc: hex32(guestU32(address + 0x198)),
            savedLr: hex32(guestU32(address + 0x84)),
            savedSp: hex32(savedSp),
            queue: hex32(queue),
            queueHead: queue === null || queue === 0 ? null : hex32(guestU32(queue)),
            queueTail: queue === null || queue === 0 ? null : hex32(guestU32(queue + 4)),
            stack: hex32(stack),
            stackEnd: hex32(stackEnd),
            stackMagic: stackEnd === null ? null : hex32(guestU32(stackEnd)),
            stackWords: savedSp === null ? null : inspectRamWords(savedSp, 12),
            stackTrace: inspectStackTrace(savedSp, stack, stackEnd),
            specific: [hex32(guestU32(address + 0x310)), hex32(guestU32(address + 0x314))],
          };
        }),
      };
    }

    function readGpr(index) {
      return view.getUint32(cpu + gprOffsets[index], true);
    }

    function traceVi(event, observedCycles, details = {}) {
      const halfLine = viCurrentHalfLine(observedCycles);
      viTrace.push({
        event,
        cycles: observedCycles,
        pc: hex32(view.getUint32(cpu + pcOffset, true)),
        dispatches,
        halfLine,
        fieldParity: viTiming === null || halfLine === null
          ? null
          : halfLine < viTiming.oddHalfLines ? "odd" : "even",
        xfbCopyCount: gxXfbCopyCount,
        ...details,
      });
      if (viTrace.length > 64) viTrace.shift();
    }

    function decodeViTiming() {
      const verticalTiming = view.getUint16(mmio + 0x2000, false);
      const displayControl = view.getUint16(mmio + 0x2002, false);
      const horizontalTiming0 = view.getUint32(mmio + 0x2004, false);
      const oddVBlank = view.getUint32(mmio + 0x200c, false);
      const evenVBlank = view.getUint32(mmio + 0x2010, false);
      const clock = view.getUint16(mmio + 0x206c, false);
      const equ = verticalTiming & 0x000f;
      const acv = (verticalTiming >>> 4) & 0x03ff;
      const hlw = horizontalTiming0 & 0x03ff;
      const oddPrb = oddVBlank & 0x03ff;
      const oddPsb = (oddVBlank >>> 16) & 0x03ff;
      const evenPrb = evenVBlank & 0x03ff;
      const evenPsb = (evenVBlank >>> 16) & 0x03ff;
      const clockSelect = clock & 1;
      const clockHz = viClockFrequencies[clockSelect];
      const cyclesPerSample = 2 * viCpuCyclesPerSecond / clockHz;
      const cyclesPerHalfLine = cyclesPerSample * hlw;
      const oddHalfLines = 3 * equ + oddPrb + 2 * acv + oddPsb;
      const evenHalfLines = 3 * equ + evenPrb + 2 * acv + evenPsb;
      const singleField = (displayControl & 4) !== 0;
      const totalHalfLines = oddHalfLines + (singleField ? 0 : evenHalfLines);
      const valid = hlw !== 0
        && oddHalfLines !== 0
        && (singleField || evenHalfLines !== 0)
        && Number.isSafeInteger(cyclesPerHalfLine)
        && cyclesPerHalfLine > 0;
      return {
        valid,
        signature: [
          verticalTiming,
          displayControl,
          horizontalTiming0,
          oddVBlank,
          evenVBlank,
          clock,
        ].join(":"),
        raw: {
          verticalTiming: "0x" + verticalTiming.toString(16).padStart(4, "0"),
          displayControl: "0x" + displayControl.toString(16).padStart(4, "0"),
          horizontalTiming0: "0x" + horizontalTiming0.toString(16).padStart(8, "0"),
          oddVBlank: "0x" + oddVBlank.toString(16).padStart(8, "0"),
          evenVBlank: "0x" + evenVBlank.toString(16).padStart(8, "0"),
          clock: "0x" + clock.toString(16).padStart(4, "0"),
        },
        displayEnabled: (displayControl & 1) !== 0,
        singleField,
        equ,
        acv,
        hlw,
        oddPrb,
        oddPsb,
        evenPrb,
        evenPsb,
        clockSelect,
        clockHz,
        cyclesPerSample,
        cyclesPerHalfLine,
        oddHalfLines,
        evenHalfLines,
        totalHalfLines,
        oddFieldCycles: oddHalfLines * cyclesPerHalfLine,
        evenFieldCycles: evenHalfLines * cyclesPerHalfLine,
        frameCycles: totalHalfLines * cyclesPerHalfLine,
      };
    }

    function viActiveFieldTargets(timing) {
      const top = 3 * timing.equ + timing.oddPrb;
      const topTarget = { field: "top", halfLine: top, registerOffset: 0x201c };
      if (timing.singleField) return [topTarget];
      const topEnd = top + 2 * timing.acv;
      // Match the VI's odd/even PSB pacing adjustment when determining the
      // first active half-line of the bottom field.
      const unwrappedBottom = topEnd
        + timing.oddPsb
        + 3 * timing.equ
        + timing.evenPrb
        - (timing.oddPsb - timing.evenPsb);
      const bottom = (
        unwrappedBottom % timing.totalHalfLines + timing.totalHalfLines
      ) % timing.totalHalfLines;
      return [
        topTarget,
        { field: "bottom", halfLine: bottom, registerOffset: 0x2024 },
      ];
    }

    function decodeViOutputDimensions(pictureConfiguration, displayControl, activeLines) {
      const width = ((pictureConfiguration >>> 8) & 0x7f) * 16;
      const nonInterlaced = (displayControl & 4) !== 0;
      return {
        width,
        height: activeLines * (nonInterlaced ? 1 : 2),
      };
    }

    function viOutputDimensions() {
      return decodeViOutputDimensions(
        view.getUint16(mmio + 0x2048, false),
        view.getUint16(mmio + 0x2002, false),
        viTiming?.acv ?? 0
      );
    }

    function viCurrentHalfLine(observedCycles) {
      if (viTiming === null) return null;
      const elapsed = Math.max(
        0,
        Math.floor((observedCycles - viEpochCycle) / viTiming.cyclesPerHalfLine)
      );
      return (viEpochHalfLine + elapsed) % viTiming.totalHalfLines;
    }

    function viCycleForHalfLineAfter(targetHalfLine, observedCycles) {
      if (viTiming === null) return null;
      const elapsed = Math.max(
        0,
        Math.floor((observedCycles - viEpochCycle) / viTiming.cyclesPerHalfLine)
      );
      const boundaryCycle = viEpochCycle + elapsed * viTiming.cyclesPerHalfLine;
      const currentHalfLine = (viEpochHalfLine + elapsed) % viTiming.totalHalfLines;
      let distance = (
        targetHalfLine - currentHalfLine + viTiming.totalHalfLines
      ) % viTiming.totalHalfLines;
      if (distance === 0) distance = viTiming.totalHalfLines;
      let candidate = boundaryCycle + distance * viTiming.cyclesPerHalfLine;
      if (candidate <= observedCycles) {
        candidate += viTiming.totalHalfLines * viTiming.cyclesPerHalfLine;
      }
      return candidate;
    }

    function viComparatorTarget(raw) {
      if (viTiming === null) return null;
      const hct = raw & 0x07ff;
      const vct = (raw >>> 16) & 0x07ff;
      if (vct === 0) return null;
      const target = 2 * (vct - 1) + (hct > viTiming.hlw ? 1 : 0);
      return target < viTiming.totalHalfLines ? target : null;
    }

    function nextViComparatorCycle(observedCycles) {
      if (viTiming === null || !viTiming.displayEnabled) return null;
      const candidates = viInterruptOffsets
        .map(offset => viComparatorTarget(view.getUint32(mmio + offset, false)))
        .filter(target => target !== null)
        .map(target => viCycleForHalfLineAfter(target, observedCycles));
      return candidates.length === 0 ? null : Math.min(...candidates);
    }

    function nextViPresentationCycleAfter(observedCycles) {
      if (viTiming === null || !viTiming.displayEnabled) return null;
      const candidates = viActiveFieldTargets(viTiming).map(target =>
        viCycleForHalfLineAfter(target.halfLine, observedCycles)
      );
      return candidates.length === 0 ? null : Math.min(...candidates);
    }

    function nextViSerialPollCycle(observedCycles) {
      if (viTiming === null || !viTiming.displayEnabled) return null;
      const poll = view.getUint32(mmio + 0x6430, false);
      const xLines = (poll >>> 16) & 0x03ff;
      const interval = 2 * xLines;
      const targets = [];
      for (const [fieldStart, fieldEnd, includeEnd] of [
        [0, viTiming.oddHalfLines, true],
        [viTiming.oddHalfLines, viTiming.totalHalfLines, false],
      ]) {
        let target = fieldStart + viSiPollHalfLines;
        while (target < fieldEnd || (includeEnd && target === fieldEnd)) {
          // Dolphin compares SI before incrementing the VI beam. Convert its
          // pre-increment target to this model's post-increment position.
          targets.push((target + 1) % viTiming.totalHalfLines);
          if (interval === 0) break;
          target += interval;
        }
      }
      const candidates = targets.map(target =>
        viCycleForHalfLineAfter(target, observedCycles)
      );
      return candidates.length === 0 ? null : Math.min(...candidates);
    }

    function nextStatefulSerialPollCycle(previousCycle) {
      if (viTiming === null || !viTiming.displayEnabled) return null;
      const mappedHalfLine = viCurrentHalfLine(previousCycle);
      check(mappedHalfLine !== null, "missing VI position for SI poll");
      const currentHalfLine = (
        mappedHalfLine - 1 + viTiming.totalHalfLines
      ) % viTiming.totalHalfLines;
      const xLines = (view.getUint32(mmio + 0x6430, false) >>> 16) & 0x03ff;
      const interval = 2 * xLines;
      let targetHalfLine;

      if (currentHalfLine < viTiming.oddHalfLines) {
        const candidate = currentHalfLine + interval;
        targetHalfLine = interval !== 0 && candidate <= viTiming.oddHalfLines
          ? candidate
          : viTiming.oddHalfLines + viSiPollHalfLines;
      } else if (currentHalfLine === viTiming.oddHalfLines) {
        // VI polls before applying the field-boundary reset. A poll exactly
        // on the odd boundary therefore completes, then the next deadline is
        // anchored fifteen half-lines into the new field.
        targetHalfLine = viTiming.oddHalfLines + viSiPollHalfLines;
      } else {
        const candidate = currentHalfLine + interval;
        targetHalfLine = interval !== 0 && candidate < viTiming.totalHalfLines
          ? candidate
          : viSiPollHalfLines;
      }

      const mappedTarget = (targetHalfLine + 1) % viTiming.totalHalfLines;
      return viCycleForHalfLineAfter(mappedTarget, previousCycle);
    }

    function currentViComparatorSignature() {
      return viInterruptOffsets.map(offset => {
        const raw = view.getUint32(mmio + offset, false);
        return raw & 0x07ff07ff;
      }).join(":");
    }

    function ensureViSchedule(observedCycles) {
      if (!viScheduleDirty) return;
      viScheduleDirty = false;
      const decoded = decodeViTiming();
      if (!decoded.valid) {
        if (viTiming !== null) {
          traceVi("timing-invalid", observedCycles, { raw: decoded.raw });
        }
        viTiming = null;
        viTimingSignature = decoded.signature;
        viComparatorSignature = null;
        viSerialPollSignature = null;
        nextViCycle = null;
        nextViPresentCycle = null;
        nextSerialPollCycle = null;
        return;
      }

      if (viTiming === null || decoded.signature !== viTimingSignature) {
        const previousHalfLine = viCurrentHalfLine(observedCycles);
        viTiming = decoded;
        viTimingSignature = decoded.signature;
        viEpochCycle = observedCycles;
        viEpochHalfLine = previousHalfLine === null
          ? 0
          : previousHalfLine % viTiming.totalHalfLines;
        viComparatorSignature = currentViComparatorSignature();
        viSerialPollSignature = view.getUint32(mmio + 0x6430, false);
        nextViCycle = nextViComparatorCycle(observedCycles);
        nextViPresentCycle = nextViPresentationCycleAfter(observedCycles);
        nextSerialPollCycle = nextViSerialPollCycle(observedCycles);
        viTimingReschedules += 1;
        traceVi("timing-reschedule", observedCycles, {
          raw: decoded.raw,
          clockHz: decoded.clockHz,
          cyclesPerHalfLine: decoded.cyclesPerHalfLine,
          oddFieldCycles: decoded.oddFieldCycles,
          evenFieldCycles: decoded.evenFieldCycles,
        });
        return;
      }

      const comparatorSignature = currentViComparatorSignature();
      if (comparatorSignature !== viComparatorSignature) {
        viComparatorSignature = comparatorSignature;
        nextViCycle = nextViComparatorCycle(observedCycles);
        traceVi("comparator-reschedule", observedCycles, { comparatorSignature });
      }
      const serialPollSignature = view.getUint32(mmio + 0x6430, false);
      if (serialPollSignature !== viSerialPollSignature) {
        viSerialPollSignature = serialPollSignature;
        // Dolphin samples a new X value only after the already-scheduled SI
        // deadline fires. A mid-field POLL write must not move that deadline.
        traceVi("serial-poll-update", observedCycles, {
          poll: hex32(serialPollSignature),
          xLines: (serialPollSignature >>> 16) & 0x03ff,
          yPolls: (serialPollSignature >>> 8) & 0x00ff,
        });
      }
    }

    function detectViAcknowledgements(observedCycles) {
      for (let index = 0; index < viInterruptOffsets.length; index += 1) {
        const raw = view.getUint32(mmio + viInterruptOffsets[index], false);
        const previous = viPreviousInterruptRaw[index];
        if ((previous & 0x80000000) !== 0 && (raw & 0x80000000) === 0) {
          viInterruptAcknowledgements[index] += 1;
          traceVi("ack", observedCycles, {
            index,
            rawBefore: hex32(previous),
            rawAfter: hex32(raw),
          });
        }
        viPreviousInterruptRaw[index] = raw;
      }
    }

    function videoInterruptConfigured() {
      if (viTiming === null || !viTiming.displayEnabled) return false;
      return viInterruptOffsets.some(offset => {
        const raw = view.getUint32(mmio + offset, false);
        return (raw & 0x10000000) !== 0 && viComparatorTarget(raw) !== null;
      });
    }

    function gxXfbCopyRowOffset(frame, address) {
      if (address < frame.destination) return null;
      const delta = address - frame.destination;
      if (delta === 0) return 0;
      if (frame.stride === 0 || delta % frame.stride !== 0) return null;
      const row = delta / frame.stride;
      return row < frame.height ? row : null;
    }

    function gxResolveXfbCopy(address) {
      for (let index = gxXfbCopies.length - 1; index >= 0; index -= 1) {
        const frame = gxXfbCopies[index];
        if (frame.captured && frame.destination === address) return { frame, row: 0 };
      }
      for (let index = gxXfbCopies.length - 1; index >= 0; index -= 1) {
        const frame = gxXfbCopies[index];
        if (!frame.captured) continue;
        const row = gxXfbCopyRowOffset(frame, address);
        if (row !== null && row <= 1) return { frame, row };
      }
      return null;
    }

    function serviceVideoPresentation(observedCycles) {
      while (
        rendererFramesInFlight.size === 0
        && nextViPresentCycle !== null
        && nextViPresentCycle <= observedCycles
      ) {
        const scheduledCycle = nextViPresentCycle;
        const halfLine = viCurrentHalfLine(scheduledCycle);
        const target = viActiveFieldTargets(viTiming)
          .find(candidate => candidate.halfLine === halfLine);
        if (target !== undefined) {
          const address = viXfbAddress(target.registerOffset);
          const dimensions = viOutputDimensions();
          const resolved = gxResolveXfbCopy(address);
          if (resolved !== null) {
            resolved.frame.displayed = true;
            resolved.frame.displayedAtCycle = scheduledCycle;
            resolved.frame.displayedField = target.field;
            resolved.frame.displayedRow = resolved.row;
          }
          postRendererFrame("vi-present", {
            field: target.field,
            address,
            width: dimensions.width,
            height: dimensions.height,
            copyIndex: resolved?.frame.index ?? 0,
            copyRow: resolved?.row ?? 0,
          });
          gxFramesPresented += 1;
          viPresentationCount += 1;
          viLastPresentationCycle = scheduledCycle;
          viLastPresentationField = target.field;
          viLastPresentationAddress = address;
          deviceEvents.set("viField", (deviceEvents.get("viField") ?? 0) + 1);
          traceVi("present", observedCycles, {
            scheduledCycle,
            field: target.field,
            address: hex32(address),
            copyIndex: resolved?.frame.index ?? null,
            copyRow: resolved?.row ?? null,
          });
        }
        nextViPresentCycle = nextViPresentationCycleAfter(scheduledCycle);
      }
    }

    function serviceVideoInterrupt(observedCycles) {
      detectViAcknowledgements(observedCycles);

      while (nextViCycle !== null && nextViCycle <= observedCycles) {
        const scheduledCycle = nextViCycle;
        const halfLine = viCurrentHalfLine(scheduledCycle);
        const lateness = observedCycles - scheduledCycle;
        viMissedHalfLines += Math.floor(lateness / viTiming.cyclesPerHalfLine);
        view.setUint16(mmio + 0x202c, 1 + Math.floor(halfLine / 2), false);
        view.setUint16(
          mmio + 0x202e,
          (halfLine & 1) === 0 ? 1 : viTiming.hlw + 1,
          false
        );

        const matches = [];
        for (let index = 0; index < viInterruptOffsets.length; index += 1) {
          const offset = viInterruptOffsets[index];
          const raw = view.getUint32(mmio + offset, false);
          if (viComparatorTarget(raw) !== halfLine) continue;
          matches.push(index);
          viComparatorMatches[index] += 1;
          if ((raw & 0x80000000) === 0) viStatusAssertions[index] += 1;
          const asserted = (raw | 0x80000000) >>> 0;
          view.setUint32(mmio + offset, asserted, false);
          viPreviousInterruptRaw[index] = asserted;
        }

        if (viLastEventCycle !== null) {
          viLastEventInterval = scheduledCycle - viLastEventCycle;
        }
        viLastEventCycle = scheduledCycle;
        deviceEvents.set("viCompare", (deviceEvents.get("viCompare") ?? 0) + 1);
        traceVi("compare", observedCycles, {
          scheduledCycle,
          lateness,
          matches,
          beamVct: 1 + Math.floor(halfLine / 2),
          beamHct: (halfLine & 1) === 0 ? 1 : viTiming.hlw + 1,
        });
        nextViCycle = nextViComparatorCycle(scheduledCycle);
      }

      const active = viInterruptOffsets.some(offset => {
        const value = view.getUint32(mmio + offset, false);
        return ((value & 0x90000000) >>> 0) === 0x90000000;
      });
      let cause = view.getUint32(mmio + 0x3000, false);
      cause = active ? cause | 0x00000100 : cause & ~0x00000100;
      view.setUint32(mmio + 0x3000, cause, false);
      const mask = view.getUint32(mmio + 0x3004, false);
      const msr = view.getUint32(cpu + msrOffset, true);
      if (active && (mask & 0x00000100) !== 0 && (msr & 0x00008000) !== 0) {
        viPiDeliveries += 1;
        deviceEvents.set("externalInterrupt", (deviceEvents.get("externalInterrupt") ?? 0) + 1);
        traceVi("pi-deliver", observedCycles, { cause: hex32(cause), mask: hex32(mask) });
        raiseException(cpu, 0x0500);
      }
    }

    function servicePixelEngine(observedCycles) {
      if (peFinishCycle !== null && observedCycles >= peFinishCycle) {
        peFinishCycle = null;
        peFinishSignal = true;
        peFinishInterruptDelivered = false;
        deviceEvents.set("peFinish", (deviceEvents.get("peFinish") ?? 0) + 1);
      }

      const control = view.getUint16(mmio + 0x100a, false);
      const active = peFinishSignal && (control & 0x02) !== 0;
      let cause = view.getUint32(mmio + 0x3000, false);
      cause = active ? cause | 0x00000400 : cause & ~0x00000400;
      view.setUint32(mmio + 0x3000, cause >>> 0, false);

      const mask = view.getUint32(mmio + 0x3004, false);
      const msr = view.getUint32(cpu + msrOffset, true);
      if (
        active
        && (mask & 0x00000400) !== 0
        && (msr & 0x00008000) !== 0
        && !peFinishInterruptDelivered
      ) {
        peFinishInterruptDelivered = true;
        deviceEvents.set(
          "peFinishInterrupt",
          (deviceEvents.get("peFinishInterrupt") ?? 0) + 1
        );
        raiseException(cpu, 0x0500);
      } else if (!active) {
        peFinishInterruptDelivered = false;
      }
    }

    function serviceAudioInterface(observedCycles) {
      updateAudioSampleCounter(observedCycles);
      const control = view.getUint32(mmio + 0x6c00, false);
      const active = (control & 0x0c) === 0x0c;
      let cause = view.getUint32(mmio + 0x3000, false);
      cause = active ? cause | 0x00000020 : cause & ~0x00000020;
      view.setUint32(mmio + 0x3000, cause >>> 0, false);

      const mask = view.getUint32(mmio + 0x3004, false);
      const msr = view.getUint32(cpu + msrOffset, true);
      if (
        active
        && (mask & 0x00000020) !== 0
        && (msr & 0x00008000) !== 0
        && !aiInterruptDelivered
      ) {
        aiInterruptDelivered = true;
        deviceEvents.set(
          "aiExternalInterrupt",
          (deviceEvents.get("aiExternalInterrupt") ?? 0) + 1
        );
        raiseException(cpu, 0x0500);
      } else if (!active) {
        aiInterruptDelivered = false;
      }
    }

    function serviceDsp(observedCycles) {
      serviceDspAudioDma(observedCycles);
      serviceAramDma(observedCycles);
      if (dspScheduledMail !== null && observedCycles >= dspScheduledMail.completionCycle) {
        pushDspMail(dspScheduledMail.mail, true);
        dspScheduledMail = null;
        deviceEvents.set("dspScheduledReply", (deviceEvents.get("dspScheduledReply") ?? 0) + 1);
      }

      const control = view.getUint16(mmio + 0x500a, false);
      const active = (((control >>> 1) & control & 0x00a8) !== 0);
      let cause = view.getUint32(mmio + 0x3000, false);
      cause = active ? cause | 0x00000040 : cause & ~0x00000040;
      view.setUint32(mmio + 0x3000, cause >>> 0, false);

      const mask = view.getUint32(mmio + 0x3004, false);
      const msr = view.getUint32(cpu + msrOffset, true);
      if (
        active
        && (mask & 0x00000040) !== 0
        && (msr & 0x00008000) !== 0
      ) {
        deviceEvents.set(
          "dspExternalInterrupt",
          (deviceEvents.get("dspExternalInterrupt") ?? 0) + 1
        );
        raiseException(cpu, 0x0500);
      }
    }

    function serviceMmio(observedCycles) {
      ensureViSchedule(observedCycles);
      for (const offset of [0x680c, 0x6820, 0x6834]) {
        const control = view.getUint32(mmio + offset, false);
        if ((control & 1) === 0) continue;
        view.setUint32(mmio + offset, control & ~1, false);
        const channel = "exiChannel" + ((offset - 0x680c) / 0x14);
        deviceEvents.set(channel, (deviceEvents.get(channel) ?? 0) + 1);
      }
      serviceAudioInterface(observedCycles);
      serviceDsp(observedCycles);
      serviceSerial(observedCycles);
      servicePixelEngine(observedCycles);
      serviceVideoPresentation(observedCycles);
      serviceVideoInterrupt(observedCycles);
      serviceDisk(observedCycles);
      serviceDecrementer(observedCycles);
    }

    function processSerialCommand(channel) {
      const command = view.getUint8(mmio + 0x6480);
      if (channel !== 0) return serialTransferOutcome.noResponse;
      switch (command) {
        case 0x00:
        case 0xff:
          bytes.set([0x09, 0x00, 0x00], mmio + 0x6480);
          return serialTransferOutcome.success;
        case 0x40: {
          const packet = controllerPacketForPoll(channel);
          bytes.set(packet, mmio + 0x6480);
          postControllerPollAcknowledgement(packet);
          return serialTransferOutcome.success;
        }
        case 0x41:
        case 0x42:
          bytes.set(
            [0x00, 0x00, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00, 0x00, 0x00],
            mmio + 0x6480
          );
          return serialTransferOutcome.success;
        default:
          deviceEvents.set("serialUnknownCommand", command);
          return serialTransferOutcome.protocolError;
      }
    }

    function performSerialPoll(scheduledCycle, observedCycles) {
      const poll = view.getUint32(mmio + 0x6430, false);
      const queuedBefore = controllerQueue.length;
      let enabledChannels = 0;
      let respondedChannels = 0;
      let publishedChannels = 0;
      let status = view.getUint32(mmio + 0x6438, false);
      let packet = null;
      let backpressured = false;

      for (let channel = 0; channel < 4; channel += 1) {
        if ((poll & (0x80 >>> channel)) !== 0) enabledChannels += 1;

        // Dolphin's UpdateDevices samples all four sockets regardless of the
        // POLL.EN bits. This harness has one controller in socket one and
        // null devices in sockets two through four.
        if (channel === 0) {
          respondedChannels += 1;
          const inputReady = 0x20000000;
          if ((status & inputReady) !== 0) {
            // IN_HI/IN_LO are a one-entry hardware mailbox. Preserve unread
            // data and do not pop the next ordered host state.
            backpressured = true;
          } else {
            const inputHigh = mmio + 0x6404;
            const errorLatch = view.getUint32(inputHigh, false) & 0x40000000;
            packet = controllerPacketForPoll(channel);
            bytes.set(packet, inputHigh);
            view.setUint32(
              inputHigh,
              (view.getUint32(inputHigh, false) | errorLatch) >>> 0,
              false
            );
            status |= inputReady;
            publishedChannels += 1;
          }
          continue;
        }

        status |= serialNoResponseBit(channel);
        const inputHigh = mmio + 0x6404 + channel * 12;
        view.setUint32(
          inputHigh,
          (view.getUint32(inputHigh, false) | 0xc0000000) >>> 0,
          false
        );
        serialPeriodicNoResponseByChannel[channel] += 1;
      }

      serialLastEnabledChannels = enabledChannels;
      serialLastRespondedChannels = respondedChannels;
      serialLastPublishedChannels = publishedChannels;
      serialLastUpdatedChannels = 4;
      view.setUint32(mmio + 0x6438, status >>> 0, false);
      recomputeSerialInterruptLevel("periodic-poll");
      deviceEvents.set(
        "serialPoll",
        (deviceEvents.get("serialPoll") ?? 0) + 1
      );
      if (packet !== null) {
        deviceEvents.set(
          "serialPollPublished",
          (deviceEvents.get("serialPollPublished") ?? 0) + 1
        );
        const buttons = postControllerPollAcknowledgement(packet);
        const signature = packet.join(",");
        if (signature !== serialLastPollSignature) {
          serialLastPollSignature = signature;
          deviceEvents.set(
            "serialPollChange",
            (deviceEvents.get("serialPollChange") ?? 0) + 1
          );
        }
        if (buttons !== 0) {
          deviceEvents.set(
            "serialPollWithButtons",
            (deviceEvents.get("serialPollWithButtons") ?? 0) + 1
          );
        }
      }
      if (backpressured) {
        deviceEvents.set(
          "serialPollBackpressured",
          (deviceEvents.get("serialPollBackpressured") ?? 0) + 1
        );
      }

      const lateness = Math.max(0, observedCycles - scheduledCycle);
      serialPollMaxLateness = Math.max(serialPollMaxLateness, lateness);
      serialPollTrace.push({
        scheduledCycle,
        observedCycles,
        lateness,
        queuedBefore,
        queuedAfter: controllerQueue.length,
        appliedSequence: controllerAppliedSequence,
        enabledChannels,
        respondedChannels,
        publishedChannels,
        backpressured,
      });
      if (serialPollTrace.length > 64) serialPollTrace.shift();
    }

    function pollSerialController(observedCycles) {
      let batch = 0;
      while (
        nextSerialPollCycle !== null
        && nextSerialPollCycle <= observedCycles
      ) {
        const scheduledCycle = nextSerialPollCycle;
        const following = nextStatefulSerialPollCycle(scheduledCycle);
        check(
          following === null || following > scheduledCycle,
          "SI poll schedule did not advance"
        );
        nextSerialPollCycle = following;
        performSerialPoll(scheduledCycle, observedCycles);
        batch += 1;
      }
      serialPollMaxBatch = Math.max(serialPollMaxBatch, batch);
      if (batch > 1) {
        serialPollCatchUpBatches += 1;
        serialPollCatchUpPolls += batch - 1;
      }
    }

    function serviceSerial(observedCycles) {
      pollSerialController(observedCycles);
      if (serialTransfer !== null && observedCycles >= serialTransfer.completionCycle) {
        const transfer = serialTransfer;
        const command = view.getUint8(mmio + 0x6480);
        const controlBefore = view.getUint32(mmio + 0x6434, false);
        const statusBefore = view.getUint32(mmio + 0x6438, false);
        const outcome = processSerialCommand(transfer.channel);
        let statusAfter = view.getUint32(mmio + 0x6438, false);
        if (outcome === serialTransferOutcome.noResponse) {
          statusAfter |= serialNoResponseBit(transfer.channel);
          serialNoResponseByChannel[transfer.channel] += 1;
          view.setUint32(mmio + 0x6438, statusAfter >>> 0, false);
        }
        let controlAfter = view.getUint32(mmio + 0x6434, false);
        controlAfter &= ~(siTransferStart | siCommunicationError);
        if (outcome !== serialTransferOutcome.success) {
          controlAfter |= siCommunicationError;
        }
        controlAfter |= siTransferInterrupt;
        controlAfter >>>= 0;
        view.setUint32(mmio + 0x6434, controlAfter, false);
        serialTransfer = null;
        recomputeSerialInterruptLevel("direct-completion");
        controlAfter = view.getUint32(mmio + 0x6434, false);
        statusAfter = view.getUint32(mmio + 0x6438, false);
        const outcomeName = serialTransferOutcomeNames[outcome];
        check(outcomeName !== undefined, "invalid serial transfer outcome");
        serialLastTransfer = {
          channel: transfer.channel,
          command: "0x" + command.toString(16).padStart(2, "0"),
          outcome: outcomeName,
          controlBefore: "0x" + controlBefore.toString(16).padStart(8, "0"),
          controlAfter: "0x" + controlAfter.toString(16).padStart(8, "0"),
          statusBefore: "0x" + statusBefore.toString(16).padStart(8, "0"),
          statusAfter: "0x" + statusAfter.toString(16).padStart(8, "0"),
        };
        deviceEvents.set(
          "serialTransferComplete",
          (deviceEvents.get("serialTransferComplete") ?? 0) + 1
        );
        const eventName = outcome === serialTransferOutcome.success
          ? "serialTransferSuccess"
          : outcome === serialTransferOutcome.noResponse
            ? "serialTransferNoResponse"
            : "serialTransferProtocolError";
        deviceEvents.set(eventName, (deviceEvents.get(eventName) ?? 0) + 1);
      }

      const active = recomputeSerialInterruptLevel("service-boundary");
      const mask = view.getUint32(mmio + 0x3004, false);
      const msr = view.getUint32(cpu + msrOffset, true);
      if (
        active
        && (mask & piSerialInterruptCause) !== 0
        && (msr & 0x00008000) !== 0
      ) {
        deviceEvents.set(
          "serialInterrupt",
          (deviceEvents.get("serialInterrupt") ?? 0) + 1
        );
        raiseException(cpu, 0x0500);
      }
    }

    function dueDiskTransferPromise(observedCycles) {
      const transfer = diskTransfer;
      if (
        transfer === null
        || transfer.ready
        || observedCycles < transfer.completionCycle
      ) return null;

      if (!transfer.waited) {
        transfer.waited = true;
        deviceEvents.set("diskHostWait", (deviceEvents.get("diskHostWait") ?? 0) + 1);
      }
      return transfer.promise;
    }

    function diskCommandName(opcode) {
      switch (opcode) {
        case 0x12: return "identify";
        case 0xa8: return "read";
        case 0xab: return "seek";
        case 0xe0: return "request-error";
        case 0xe1: return "audio-stream";
        case 0xe2: return "audio-status";
        case 0xe3: return "stop-motor";
        case 0xe4: return "audio-config";
        default: return "unsupported";
      }
    }

    function recordDiskCommand(observedCycles, transfer, details) {
      details ??= {};
      const name = diskCommandName(transfer.opcode);
      diskCommandCounts.set(name, (diskCommandCounts.get(name) ?? 0) + 1);
      deviceEvents.set("diskCommand", (deviceEvents.get("diskCommand") ?? 0) + 1);
      const outcomeEvent = transfer.interruptStatus === diDeviceErrorInterrupt
        ? "diskCommandDeviceError"
        : "diskCommandAccepted";
      deviceEvents.set(outcomeEvent, (deviceEvents.get(outcomeEvent) ?? 0) + 1);
      diskCommandTrace.push({
        cycle: observedCycles,
        opcode: "0x" + transfer.opcode.toString(16).padStart(2, "0"),
        name,
        outcome: transfer.interruptStatus === diDeviceErrorInterrupt
          ? "device-error"
          : "transfer-complete",
        ...details,
      });
      if (diskCommandTrace.length > 64) diskCommandTrace.shift();
    }

    function diskAudioTiming() {
      const control = view.getUint32(mmio + 0x6c00, false);
      const streamingAt48KHz = (control & 2) !== 0;
      const blocksPerBatch = streamingAt48KHz ? 6 : 4;
      const sampleRateDivisor = streamingAt48KHz ? 2248 : 3372;
      const cyclesPerBlock = (
        viCpuCyclesPerSecond * sampleRateDivisor * 28 / 108_000_000
      );
      return {
        blocksPerBatch,
        cyclesPerBlock,
        cyclesPerBatch: blocksPerBatch * cyclesPerBlock,
      };
    }

    function updateDiskAudioSchedule(observedCycles, force) {
      const playing = (view.getUint32(mmio + 0x6c00, false) & 1) !== 0;
      if (!diskAudioStreaming || !playing) {
        nextDiskAudioCycle = null;
        return;
      }
      if (force || nextDiskAudioCycle === null) {
        nextDiskAudioCycle = Math.ceil(observedCycles + diskAudioTiming().cyclesPerBatch);
      }
    }

    function advanceDiskAudioBlock() {
      if (diskAudioPosition >= diskAudioStart + diskAudioLength) {
        diskAudioPosition = diskAudioNextStart;
        diskAudioStart = diskAudioNextStart;
        diskAudioLength = diskAudioNextLength;
        deviceEvents.set(
          "diskAudioTrackBoundary",
          (deviceEvents.get("diskAudioTrackBoundary") ?? 0) + 1
        );

        if (diskAudioStopAtTrackEnd) {
          diskAudioStopAtTrackEnd = false;
          diskAudioStreaming = false;
          deviceEvents.set(
            "diskAudioStoppedAtTrackEnd",
            (deviceEvents.get("diskAudioStoppedAtTrackEnd") ?? 0) + 1
          );
          return false;
        }
      }

      diskAudioPosition += 32;
      return true;
    }

    function serviceDiskAudio(observedCycles) {
      // Keep DTK hardware state moving without reading or decoding disc ADPCM in this harness.
      while (nextDiskAudioCycle !== null && observedCycles >= nextDiskAudioCycle) {
        const scheduledCycle = nextDiskAudioCycle;
        const playing = (view.getUint32(mmio + 0x6c00, false) & 1) !== 0;
        if (!diskAudioStreaming || !playing) {
          nextDiskAudioCycle = null;
          break;
        }

        const timing = diskAudioTiming();
        let processedBlocks = 0;
        while (
          processedBlocks < timing.blocksPerBatch
          && diskAudioStreaming
          && advanceDiskAudioBlock()
        ) {
          processedBlocks += 1;
        }
        deviceEvents.set(
          "diskAudioBatch",
          (deviceEvents.get("diskAudioBatch") ?? 0) + 1
        );
        deviceEvents.set(
          "diskAudioBlock",
          (deviceEvents.get("diskAudioBlock") ?? 0) + processedBlocks
        );

        nextDiskAudioCycle = diskAudioStreaming
          ? Math.ceil(scheduledCycle + timing.cyclesPerBatch)
          : null;
      }
    }

    function beginDiskCommand(observedCycles) {
      const command0 = view.getUint32(mmio + 0x6008, false);
      const command1 = view.getUint32(mmio + 0x600c, false);
      const command2 = view.getUint32(mmio + 0x6010, false);
      const opcode = command0 >>> 24;
      const dmaBase = view.getUint32(mmio + 0x6014, false);
      const dmaLength = view.getUint32(mmio + 0x6018, false);
      let details = {};

      if (opcode !== 0xe0) diskLastError = 0;

      if (opcode === 0x12) {
        const target = ramPointer(dmaBase, dmaLength);
        check(target !== null && dmaLength === 32, "invalid DI identify DMA target");
        bytes.set([
          0x00, 0x00, 0x00, 0x00,
          0x20, 0x02, 0x04, 0x02,
          0x61, 0x00, 0x00, 0x00,
        ], target);
        bytes.fill(0, target + 12, target + dmaLength);
        diskTransfer = {
          opcode,
          completionCycle: observedCycles + 10000,
          ready: true,
          interruptStatus: diTransferInterrupt,
        };
        deviceEvents.set("diskIdentify", (deviceEvents.get("diskIdentify") ?? 0) + 1);
      } else if (opcode === 0xa8) {
        const offset = command1 * 4;
        const length = command2;
        const target = ramPointer(dmaBase, dmaLength);
        check(target !== null && dmaLength === length, "invalid DI read DMA target");
        const transfer = {
          opcode,
          offset,
          length,
          dmaBase,
          completionCycle: observedCycles + 10000,
          ready: false,
          interruptStatus: diTransferInterrupt,
          error: null,
          data: null,
          promise: null,
          waited: false,
        };
        diskTransfer = transfer;
        details = { offset, length };
        deviceEvents.set("diskRead", (deviceEvents.get("diskRead") ?? 0) + 1);
        transfer.promise = Promise.resolve()
          .then(() => {
            if (discSource === null) throw new Error("disc read requested without a disc source");
            return discSource.read(offset, length);
          })
          .then(data => {
            if (diskTransfer !== transfer) return;
            if (data.length !== length) throw new Error("short browser disc read");
            transfer.data = data;
            transfer.ready = true;
          })
          .catch(error => {
            transfer.error = String(error?.message ?? error);
            transfer.ready = true;
          });
      } else {
        const transfer = {
          opcode,
          completionCycle: observedCycles + diMinimumCommandLatencyCycles,
          ready: true,
          interruptStatus: diTransferInterrupt,
        };
        const audioSubcommand = (command0 >>> 16) & 0xff;

        switch (opcode) {
          case 0xab: {
            const offset = command1 * 4;
            transfer.offset = offset;
            details = { offset };
            deviceEvents.set("diskSeek", (deviceEvents.get("diskSeek") ?? 0) + 1);
            break;
          }
          case 0xe0: {
            const result = (((diskDriveState & 0xff) << 24) | (diskLastError & 0x00ffffff)) >>> 0;
            view.setUint32(mmio + 0x6020, result, false);
            diskLastError = 0;
            details = { result: "0x" + result.toString(16).padStart(8, "0") };
            deviceEvents.set(
              "diskRequestError",
              (deviceEvents.get("diskRequestError") ?? 0) + 1
            );
            break;
          }
          case 0xe1: {
            if (!diskAudioEnabled) {
              diskLastError = diErrorNoAudioBuffer;
              transfer.interruptStatus = diDeviceErrorInterrupt;
              details = { subcommand: audioSubcommand, reason: "audio-disabled" };
              break;
            }
            if (audioSubcommand === 0x00) {
              const wasStreaming = diskAudioStreaming;
              const offset = command1 * 4;
              const length = command2;
              if (offset === 0 && length === 0) {
                diskAudioStopAtTrackEnd = true;
              } else if (!diskAudioStopAtTrackEnd) {
                diskAudioNextStart = offset;
                diskAudioNextLength = length;
                if (!diskAudioStreaming) {
                  diskAudioStart = offset;
                  diskAudioLength = length;
                  diskAudioPosition = offset;
                  diskAudioStreaming = true;
                }
              }
              updateDiskAudioSchedule(
                observedCycles,
                !wasStreaming && diskAudioStreaming
              );
              details = { subcommand: audioSubcommand, offset, length };
              deviceEvents.set(
                "diskAudioStreamStart",
                (deviceEvents.get("diskAudioStreamStart") ?? 0) + 1
              );
            } else if (audioSubcommand === 0x01) {
              diskAudioStopAtTrackEnd = false;
              diskAudioStreaming = false;
              updateDiskAudioSchedule(observedCycles, false);
              details = { subcommand: audioSubcommand };
              deviceEvents.set(
                "diskAudioStreamStop",
                (deviceEvents.get("diskAudioStreamStop") ?? 0) + 1
              );
            } else {
              diskLastError = diErrorInvalidAudioCommand;
              transfer.interruptStatus = diDeviceErrorInterrupt;
              details = { subcommand: audioSubcommand, reason: "invalid-audio-command" };
            }
            break;
          }
          case 0xe2: {
            let result = 0;
            if (!diskAudioEnabled) {
              diskLastError = diErrorNoAudioBuffer;
              transfer.interruptStatus = diDeviceErrorInterrupt;
              details = { subcommand: audioSubcommand, reason: "audio-disabled" };
              break;
            }
            if (audioSubcommand === 0x00) {
              result = diskAudioStreaming ? 1 : 0;
            } else if (audioSubcommand === 0x01) {
              result = (diskAudioPosition & 0xffff8000) >>> 2;
            } else if (audioSubcommand === 0x02) {
              result = Math.floor(diskAudioStart / 4) >>> 0;
            } else if (audioSubcommand === 0x03) {
              result = diskAudioLength >>> 0;
            } else {
              diskLastError = diErrorInvalidAudioCommand;
              transfer.interruptStatus = diDeviceErrorInterrupt;
              details = { subcommand: audioSubcommand, reason: "invalid-audio-status" };
              break;
            }
            view.setUint32(mmio + 0x6020, result, false);
            details = {
              subcommand: audioSubcommand,
              result: "0x" + result.toString(16).padStart(8, "0"),
            };
            deviceEvents.set(
              "diskAudioStatus",
              (deviceEvents.get("diskAudioStatus") ?? 0) + 1
            );
            break;
          }
          case 0xe3:
            diskAudioStopAtTrackEnd = false;
            diskAudioStreaming = false;
            updateDiskAudioSchedule(observedCycles, false);
            diskDriveState = 4;
            view.setUint32(mmio + 0x6020, 0, false);
            deviceEvents.set("diskStopMotor", (deviceEvents.get("diskStopMotor") ?? 0) + 1);
            break;
          case 0xe4:
            diskAudioEnabled = ((command0 >>> 16) & 1) !== 0;
            diskAudioBufferLength = command0 & 0x0f;
            if (!diskAudioEnabled) {
              diskAudioStopAtTrackEnd = false;
              diskAudioStreaming = false;
            }
            updateDiskAudioSchedule(observedCycles, false);
            details = {
              enabled: diskAudioEnabled,
              bufferLength: diskAudioBufferLength,
            };
            deviceEvents.set(
              "diskAudioConfig",
              (deviceEvents.get("diskAudioConfig") ?? 0) + 1
            );
            break;
          default:
            diskLastError = diErrorInvalidCommand;
            transfer.interruptStatus = diDeviceErrorInterrupt;
            details = { reason: "unsupported-opcode" };
            deviceEvents.set(
              "diskUnsupportedCommand",
              (deviceEvents.get("diskUnsupportedCommand") ?? 0) + 1
            );
            break;
        }
        diskTransfer = transfer;
      }

      recordDiskCommand(observedCycles, diskTransfer, {
        command0: "0x" + command0.toString(16).padStart(8, "0"),
        command1: "0x" + command1.toString(16).padStart(8, "0"),
        command2: "0x" + command2.toString(16).padStart(8, "0"),
        ...details,
      });
    }

    function serviceDisk(observedCycles) {
      serviceDiskAudio(observedCycles);
      let control = view.getUint32(mmio + 0x601c, false);
      if (diskTransfer === null && (control & 1) !== 0) {
        beginDiskCommand(observedCycles);
      }

      if (
        diskTransfer !== null
        && diskTransfer.ready
        && observedCycles >= diskTransfer.completionCycle
      ) {
        if (diskTransfer.error !== null && diskTransfer.error !== undefined) {
          throw new Error(diskTransfer.error);
        }
        if (diskTransfer.opcode === 0xa8) {
          const data = diskTransfer.data;
          const target = ramPointer(diskTransfer.dmaBase, diskTransfer.length);
          check(data !== null && target !== null, "missing browser disc DMA payload");
          bytes.set(data, target);
          const hashLength = Math.min(data.length, 1024 * 1024 - diskHashedBytes);
          for (let index = 0; index < hashLength; index += 1) {
            diskReadHash = Math.imul(diskReadHash ^ data[index], 0x01000193) >>> 0;
          }
          diskHashedBytes += hashLength;
          diskReadBytes += data.length;
        }
        control = view.getUint32(mmio + 0x601c, false) & ~1;
        view.setUint32(mmio + 0x601c, control, false);
        view.setUint32(mmio + 0x6018, 0, false);
        view.setUint32(
          mmio + 0x6000,
          view.getUint32(mmio + 0x6000, false) | diskTransfer.interruptStatus,
          false
        );
        if (diskTransfer.interruptStatus === diDeviceErrorInterrupt) {
          deviceEvents.set(
            "diskDeviceError",
            (deviceEvents.get("diskDeviceError") ?? 0) + 1
          );
        }
        deviceEvents.set("diskComplete", (deviceEvents.get("diskComplete") ?? 0) + 1);
        diskTransfer = null;
      }

      const active = recomputeDiskInterruptLevel();

      const mask = view.getUint32(mmio + 0x3004, false);
      const msr = view.getUint32(cpu + msrOffset, true);
      if (
        active
        && (mask & piDiskInterruptCause) !== 0
        && (msr & 0x00008000) !== 0
      ) {
        deviceEvents.set(
          "diskInterrupt",
          (deviceEvents.get("diskInterrupt") ?? 0) + 1
        );
        raiseException(cpu, 0x0500);
      }
    }

    function raiseException(registers, exception) {
      const oldPc = view.getUint32(registers + pcOffset, true);
      const oldMsr = view.getUint32(registers + msrOffset, true);
      const exceptionName = "0x" + exception.toString(16).padStart(4, "0");
      exceptionCounts.set(exceptionName, (exceptionCounts.get(exceptionName) ?? 0) + 1);
      const sample = {
        exception: exceptionName,
        pc: "0x" + oldPc.toString(16).padStart(8, "0"),
        instruction: "0x" + fetchWord(oldPc).toString(16).padStart(8, "0"),
        msr: "0x" + oldMsr.toString(16).padStart(8, "0"),
        dar: "0x" + view.getUint32(registers + darOffset, true).toString(16).padStart(8, "0"),
        dispatch: dispatches,
      };
      if (exceptionFirstByVector[exceptionName] === undefined) {
        exceptionFirstByVector[exceptionName] = {
          ...sample,
          lr: hex32(view.getUint32(registers + lrOffset, true)),
          ctr: hex32(view.getUint32(registers + ctrOffset, true)),
          gpr: Object.fromEntries(Array.from({ length: 32 }, (_unused, index) => [
            "r" + index,
            hex32(view.getUint32(registers + gprOffsets[index], true)),
          ])),
          recentPcs: recentPcs.map(hex32),
          unmappedAccess: lastUnmappedAccess,
        };
      }
      if (exception === 0x0300 && firstDsi === null) {
        firstDsi = exceptionFirstByVector[exceptionName];
      }
      if (exceptionFirstTrace.length < 24) exceptionFirstTrace.push(sample);
      exceptionTrace.push(sample);
      if (exceptionTrace.length > 16) exceptionTrace.shift();
      let srr1 = view.getUint32(registers + srr1Offset, true);
      const msrToSrr1Mask = 0x07c0ffff;
      const specialSrr1Mask = 0x783c0000;
      srr1 = ((srr1 & ~msrToSrr1Mask) | (oldMsr & msrToSrr1Mask)) & ~specialSrr1Mask;
      view.setUint32(registers + srr0Offset, oldPc + (exception === 0x0c00 ? 4 : 0), true);
      view.setUint32(registers + srr1Offset, srr1, true);

      const exceptionMsr = ((oldMsr >>> 16) & 1) | (oldMsr & 0x00011040);
      const vectorBase = (oldMsr & 0x40) === 0 ? 0 : 0xfff00000;
      view.setUint32(registers + msrOffset, exceptionMsr, true);
      view.setUint32(registers + pcOffset, vectorBase | exception, true);
    }

    function elapsedTimeBase() {
      return BigInt(Math.floor(cycles / timeBaseRatio));
    }

    function updateTimeBase() {
      const now = elapsedTimeBase();
      const current = view.getBigUint64(cpu + timeBaseOffset, true);
      view.setBigUint64(cpu + timeBaseOffset, current + now - timeBaseLastCycle, true);
      timeBaseLastCycle = now;
    }

    function timeBaseChanged() {
      timeBaseLastCycle = elapsedTimeBase();
    }

    function updateDecrementer(observedCycles) {
      const elapsedTicks = Math.floor(
        (observedCycles - decrementerLastCycle) / timeBaseRatio
      );
      if (elapsedTicks <= 0) return;
      const current = view.getUint32(cpu + decrementerOffset, true);
      view.setUint32(
        cpu + decrementerOffset,
        (current - (elapsedTicks >>> 0)) >>> 0,
        true
      );
      decrementerLastCycle += elapsedTicks * timeBaseRatio;
    }

    function decrementerChanged() {
      decrementerLastCycle = cycles;
      const value = view.getUint32(cpu + decrementerOffset, true);
      nextDecrementerCycle = (value & 0x80000000) === 0
        ? cycles + value * timeBaseRatio
        : null;
    }

    function serviceDecrementer(observedCycles) {
      if (
        !decrementerPending
        && nextDecrementerCycle !== null
        && observedCycles >= nextDecrementerCycle
      ) {
        const overdueTicks = Math.floor(
          (observedCycles - nextDecrementerCycle) / timeBaseRatio
        );
        view.setUint32(
          cpu + decrementerOffset,
          (0xffffffff - overdueTicks) >>> 0,
          true
        );
        decrementerLastCycle = nextDecrementerCycle + overdueTicks * timeBaseRatio;
        nextDecrementerCycle = null;
        decrementerPending = true;
        deviceEvents.set(
          "decrementerUnderflow",
          (deviceEvents.get("decrementerUnderflow") ?? 0) + 1
        );
      }
      if (!decrementerPending) return;

      const msr = view.getUint32(cpu + msrOffset, true);
      if ((msr & 0x00008000) !== 0) {
        decrementerPending = false;
        deviceEvents.set(
          "decrementerInterrupt",
          (deviceEvents.get("decrementerInterrupt") ?? 0) + 1
        );
        raiseException(cpu, 0x0900);
      }
    }

    function loopSkipBudget(requested, modeledCycles, maximumExecuted) {
      const eventCycle = nextRuntimeEventCycle();
      if (eventCycle === null) return requested;
      const finalBlockCycles = maximumExecuted >>> 16;
      return Math.min(
        requested,
        Math.max(0, Math.floor((eventCycle - cycles - finalBlockCycles) / modeledCycles))
      );
    }

    function decodeMemset32ByteLoop(currentPc) {
      const firstStore = fetchWord(currentPc);
      const decrement = fetchWord(currentPc + 4);
      const valueRegister = (firstStore >>> 21) & 31;
      const baseRegister = (firstStore >>> 16) & 31;
      const counterRegister = (decrement >>> 21) & 31;
      if (
        (firstStore >>> 26) !== 36
        || (firstStore & 0xffff) !== 4
        || (decrement >>> 26) !== 13
        || ((decrement >>> 16) & 31) !== counterRegister
        || (decrement & 0xffff) !== 0xffff
      ) return null;
      for (let index = 1; index < 7; index += 1) {
        const store = fetchWord(currentPc + 4 + index * 4);
        if (
          (store >>> 26) !== 36
          || ((store >>> 21) & 31) !== valueRegister
          || ((store >>> 16) & 31) !== baseRegister
          || (store & 0xffff) !== (index + 1) * 4
        ) return null;
      }
      const finalStore = fetchWord(currentPc + 0x20);
      if (
        (finalStore >>> 26) !== 37
        || ((finalStore >>> 21) & 31) !== valueRegister
        || ((finalStore >>> 16) & 31) !== baseRegister
        || (finalStore & 0xffff) !== 32
        || fetchWord(currentPc + 0x24) !== 0x4082ffdc
      ) return null;
      return { baseRegister, counterRegister, valueRegister };
    }

    function isCacheLineLoop(currentPc) {
      const cacheInstruction = fetchWord(currentPc);
      return [0x7c0018ac, 0x7c00186c, 0x7c001bac, 0x7c001fec, 0x7c001fac]
        .includes(cacheInstruction)
        && fetchWord(currentPc + 4) === 0x38630020
        && fetchWord(currentPc + 8) === 0x4200fff8;
    }

    function fastForwardRecognizedLoop(currentPc, maximumExecuted) {
      const cacheInstruction = fetchWord(currentPc);
      if (isCacheLineLoop(currentPc)) {
        const groups = view.getUint32(cpu + ctrOffset, true);
        if (groups > 1) {
          const skipped = loopSkipBudget(groups - 1, 6, maximumExecuted);
          if (skipped === 0) return;
          const guestStart = readGpr(3);
          if (cacheInstruction === 0x7c001fec) {
            const byteCount = skipped * 32;
            const target = ramPointer(guestStart & ~31, byteCount);
            if (target === null) return;
            bytes.fill(0, target, target + byteCount);
          }
          view.setUint32(cpu + gprOffsets[3], (guestStart + skipped * 32) >>> 0, true);
          view.setUint32(cpu + ctrOffset, groups - skipped, true);
          instructions += skipped * 3;
          cycles += skipped * 6;
          const operation = new Map([
            [0x7c0018ac, "dcbfCacheLines"],
            [0x7c00186c, "dcbstCacheLines"],
            [0x7c001bac, "dcbiCacheLines"],
            [0x7c001fec, "dcbzCacheLines"],
            [0x7c001fac, "icbiCacheLines"],
          ]).get(cacheInstruction);
          accelerations.set(operation, (accelerations.get(operation) ?? 0) + skipped);
          return;
        }
      }

      const memsetLoop = decodeMemset32ByteLoop(currentPc);
      if (memsetLoop === null) return;
      const groups = readGpr(memsetLoop.counterRegister);
      if (groups <= 1) return;
      const fillWord = readGpr(memsetLoop.valueRegister);
      const fillByte = fillWord & 0xff;
      if (fillWord !== Math.imul(fillByte, 0x01010101) >>> 0) return;

      const skipped = loopSkipBudget(groups - 1, 20, maximumExecuted);
      if (skipped === 0) return;
      const byteCount = skipped * 32;
      const guestStart = (readGpr(memsetLoop.baseRegister) + 4) >>> 0;
      const target = ramPointer(guestStart, byteCount);
      if (target === null) return;

      bytes.fill(fillByte, target, target + byteCount);
      view.setUint32(
        cpu + gprOffsets[memsetLoop.counterRegister], groups - skipped, true
      );
      view.setUint32(
        cpu + gprOffsets[memsetLoop.baseRegister],
        (guestStart - 4 + byteCount) >>> 0,
        true
      );
      instructions += skipped * 10;
      cycles += skipped * 20;
      accelerations.set(
        "memset32ByteGroups",
        (accelerations.get("memset32ByteGroups") ?? 0) + skipped
      );
    }

    function isSemanticIdlePattern(pattern) {
      return [blockPattern.idleBasic, blockPattern.idleVolatileRead].includes(pattern);
    }

    function isRecognizedLoopPc(candidatePc) {
      return isSemanticIdlePattern(blocks.get(candidatePc)?.pattern)
        || isCacheLineLoop(candidatePc)
        || decodeMemset32ByteLoop(candidatePc) !== null;
    }

    function nextRuntimeEventCycle(includeCycleLimit = true) {
      ensureViSchedule(cycles);
      const candidates = [
        viTiming?.displayEnabled ? nextViCycle : null,
        viTiming?.displayEnabled ? nextViPresentCycle : null,
        nextSerialPollCycle,
        nextDecrementerCycle,
        diskTransfer?.completionCycle ?? null,
        nextDiskAudioCycle,
        serialTransfer?.completionCycle ?? null,
        peFinishCycle,
        dspScheduledMail?.completionCycle ?? null,
        nextDspAudioDmaInterruptCycle,
        nextDspAudioDmaCycle,
        aramTransfer?.completionCycle ?? null,
        nextAudioSampleCycle(),
        includeCycleLimit && Number.isFinite(cycleLimit) ? cycleLimit : null,
      ].filter(value => value !== null && value > cycles);
      return candidates.length === 0 ? null : Math.min(...candidates);
    }

    function compileBlock(compiler, inputPointer, pc) {
      const compilerView = new DataView(compiler.memory.buffer);
      for (let index = 0; index < 64; index += 1) {
        compilerView.setUint32(inputPointer + index * 4, fetchWord(pc + index * 4), true);
      }

      const succeeded = compiler.ppcwasmjit_compile(inputPointer, 64);
      if (succeeded !== 1) {
        const pointer = compiler.ppcwasmjit_error_pointer();
        const length = compiler.ppcwasmjit_error_length();
        const error = new TextDecoder().decode(
          new Uint8Array(compiler.memory.buffer, pointer, length)
        );
        throw new Error(error);
      }

      const pointer = compiler.ppcwasmjit_output_pointer();
      const length = compiler.ppcwasmjit_output_length();
      check(length !== 0, "browser JIT returned an empty module");
      return {
        maximum: compiler.ppcwasmjit_maximum_executed() >>> 0,
        pattern: compiler.ppcwasmjit_pattern() >>> 0,
        wasm: new Uint8Array(compiler.memory.buffer, pointer, length).slice(),
      };
    }

    async function linkCompiledRegion(compiler, inputPointer, pcs) {
      const compilerView = new DataView(compiler.memory.buffer);
      for (const [index, regionPc] of pcs.entries()) {
        const block = blocks.get(regionPc);
        check(block !== undefined, "cannot link an uncompiled region block");
        compilerView.setUint32(inputPointer + index * 8, regionPc, true);
        compilerView.setUint32(inputPointer + index * 8 + 4, block.maximum, true);
      }

      const succeeded = compiler.ppcwasmjit_link_region(inputPointer, pcs.length);
      if (succeeded !== 1) {
        const pointer = compiler.ppcwasmjit_error_pointer();
        const length = compiler.ppcwasmjit_error_length();
        const error = new TextDecoder().decode(
          new Uint8Array(compiler.memory.buffer, pointer, length)
        );
        throw new Error(error);
      }

      const pointer = compiler.ppcwasmjit_output_pointer();
      const length = compiler.ppcwasmjit_output_length();
      check(length !== 0, "browser JIT returned an empty region module");
      const wasm = new Uint8Array(compiler.memory.buffer, pointer, length).slice();
      const blockImports = Object.fromEntries(pcs.map((regionPc, index) => [
        "b" + index,
        blocks.get(regionPc).instance.exports.run,
      ]));
      const { instance } = await WebAssembly.instantiate(wasm, {
        lazuli: { memory },
        lazuli_blocks: blockImports,
      });
      return { instance, pcs };
    }

    function maybeLinkHotRegion(compiler, inputPointer, currentPc) {
      if (regionsByPc.has(currentPc) || isRecognizedLoopPc(currentPc)) return null;
      const previous = recentPcs.lastIndexOf(currentPc);
      if (previous < 0) return null;

      const pcs = [...new Set(recentPcs.slice(previous))];
      if (
        pcs.length === 0 || pcs.length > 16
        || pcs.some(regionPc => !blocks.has(regionPc) || isRecognizedLoopPc(regionPc))
      ) return null;

      const key = pcs.map(regionPc => regionPc.toString(16)).join(",");
      const hits = (regionCandidateHits.get(key) ?? 0) + 1;
      regionCandidateHits.set(key, hits);
      if (hits !== 8) return null;

      return linkCompiledRegion(compiler, inputPointer, pcs).then(region => {
        for (const regionPc of pcs) {
          if (!regionsByPc.has(regionPc)) regionsByPc.set(regionPc, region);
        }
        accelerations.set(
          "wasmRegionsLinked",
          (accelerations.get("wasmRegionsLinked") ?? 0) + 1
        );
      });
    }

    function maybeFuseRegionExit(compiler, inputPointer, sourceRegion, nextPc) {
      if (sourceRegion.pcs.includes(nextPc) || isRecognizedLoopPc(nextPc)) return null;

      const targetRegion = regionsByPc.get(nextPc);
      const targetPcs = targetRegion?.pcs ?? [nextPc];
      const pcs = [...new Set([...sourceRegion.pcs, ...targetPcs])];
      if (
        pcs.length === sourceRegion.pcs.length
        || pcs.some(regionPc => !blocks.has(regionPc) || isRecognizedLoopPc(regionPc))
      ) return null;

      const sourceAnchor = sourceRegion.pcs[0];
      const key = sourceAnchor.toString(16) + ">" + nextPc.toString(16);
      const hits = (regionFusionHits.get(key) ?? 0) + 1;
      regionFusionHits.set(key, hits);
      if (hits !== regionFusionHitThreshold) return null;

      if (pcs.length > maximumFusedRegionBlocks) {
        accelerations.set(
          "wasmRegionFusionLimitHits",
          (accelerations.get("wasmRegionFusionLimitHits") ?? 0) + 1
        );
        return null;
      }

      return linkCompiledRegion(compiler, inputPointer, pcs).then(region => {
        for (const regionPc of pcs) regionsByPc.set(regionPc, region);
        accelerations.set(
          "wasmRegionFusions",
          (accelerations.get("wasmRegionFusions") ?? 0) + 1
        );
        accelerations.set(
          "wasmFusedRegionBlocks",
          (accelerations.get("wasmFusedRegionBlocks") ?? 0) + pcs.length
        );
        accelerations.set(
          "wasmLargestRegionBlocks",
          Math.max(accelerations.get("wasmLargestRegionBlocks") ?? 0, pcs.length)
        );
      });
    }

    function finish(status, details) {
      const report = {
        status,
        title: boot.label,
        disc: {
          identifier: boot.identifier,
          revision: boot.version,
          source: discSource?.describe() ?? { kind: "none" },
        },
        input: __DOL_NAME__,
        runtime: navigator.userAgent,
        execution: {
          context: "web-worker",
          guestCore: "single Gekko",
          jit: "PPC-to-CLIF-to-Wasm",
          scheduler: {
            sliceMs: runnerSliceMs,
            restMs: runnerRestMs,
            blockChunk: runnerBlockChunk,
            renderEvery: runnerRenderEvery,
            rendererSync: {
              posted: rendererFrameSequence,
              acknowledged: rendererFramesAcknowledged,
              failed: rendererFrameFailures,
              inFlight: rendererFramesInFlight.size,
              highWater: rendererFrameHighWater,
              waits: rendererBackpressureWaits,
              resultMisses: rendererFrameResultMisses,
            },
          },
        },
        recentPcs: recentPcs.map(value => hex32(value)),
        bi2Address: "0x" + bi2Address.toString(16).padStart(8, "0"),
        bi2Bytes,
        dolBytes,
        fstBytes,
        fstAddress: "0x" + fstAddress.toString(16).padStart(8, "0"),
        compilerWasmBytes,
        limits: {
          dispatches: dispatchLimit,
          cycles: Number.isFinite(cycleLimit) ? cycleLimit : null,
        },
        hookCalls: Object.fromEntries(hookCalls),
        deviceEvents: Object.fromEntries(deviceEvents),
        accelerations: {
          ...Object.fromEntries(accelerations),
          wasmRegionContinuableHooks: regionContinuableHookCalls,
        },
        gxFifo: {
          stores: gxFifoStores,
          quantizedStores: gxFifoQuantizedStores,
          bytes: gxFifoBytes,
          hash: "0x" + gxFifoHash.toString(16).padStart(8, "0"),
          sample: gxFifoSample.map(byte => byte.toString(16).padStart(2, "0")).join(""),
          staging: {
            drains: gxFifoStagingDrains,
            stores: gxFifoStagingStores,
            quantizedStores: gxFifoStagingQuantizedStores,
            bytes: gxFifoStagingBytes,
            emergencyDrains: view.getUint32(gxFifoStagingMeta + 12, true),
            pendingBytes: view.getUint32(gxFifoStagingMeta, true),
          },
          decoder: {
            commands: gxDecodedCommands,
            bufferedBytes: gxDecodeBuffer.length,
            cpLoads: gxCpLoads,
            xfLoads: gxXfLoads,
            indexedXfLoads: gxIndexedXfLoads,
            bpLoads: gxBpLoads,
            displayLists: gxDisplayLists,
            displayListBytes: gxDisplayListBytes,
            displayListErrors: gxDisplayListErrors,
            primitives: gxPrimitives,
            vertices: gxVertices,
            decodedVertices: gxDecodedVertices,
            projectedVertices: gxProjectedVertices,
            droppedVertices: gxDroppedVertices,
            vertexDecodeErrors: gxVertexDecodeErrors,
            texgenTransforms: gxTexgenTransforms,
            texgenFallbacks: gxTexgenFallbacks,
            pendingFrameDrawCalls: gxFrameDraws.length,
            pendingFrameVertices: gxFrameDrawVertices,
            pendingFrameSkippedPrimitives: gxFrameSkippedPrimitives,
            unknownOpcodes: gxUnknownOpcodes,
            textures: {
              draws: gxTexturedDraws,
              decodes: gxTextureDecodes,
              cacheHits: gxTextureCacheHits,
              cacheEntries: gxTextureCache.size,
              cacheBytes: gxTextureCache.weight,
              cacheByteLimit: gxTextureCache.maximumWeight,
              cacheEvictions: gxTextureCache.evictions,
              decodedBytes: gxTextureDecodedBytes,
              decodeErrors: gxTextureDecodeErrors,
              formats: Object.fromEntries(gxTextureFormatCounts),
              tevModes: Object.fromEntries(gxTevModeCounts),
              tevCacheHits: gxTevTextureCacheHits,
              tevCacheEntries: gxTevTextureCache.size,
              tevCacheBytes: gxTevTextureCache.weight,
              tevCacheByteLimit: gxTevTextureCache.maximumWeight,
              tevCacheEvictions: gxTevTextureCache.evictions,
              tlutLoads: gxTlutLoads,
              tlutBytes: gxTlutBytes,
              tlutErrors: gxTlutErrors,
            },
            xfbCopyCount: gxXfbCopyCount,
            xfbFramesCaptured: gxXfbFramesCaptured,
            framesPresented: gxFramesPresented,
            framesSkipped: gxFramesSkipped,
            skippedGeometryPrimitives: gxSkippedGeometryPrimitives,
            skippedGeometryVertices: gxSkippedGeometryVertices,
            uncollectedNonClearingFrames: gxUncollectedNonClearingFrames,
            textureCopyCount: gxTextureCopyCount,
            textureCopyFramesPresented: gxTextureCopyFramesPresented,
            textureCopyCaptureThroughXfb: gxTextureCopyCaptureThroughXfb,
            textureCopyCaptureArms: gxTextureCopyCaptureArms,
            textureCopyCaptureDeferrals: gxTextureCopyCaptureDeferrals,
            textureCopyConsumers: gxTextureCopyConsumers.size,
            textureCopyProducerPreArms: gxTextureCopyProducerPreArms,
            textureCopyProducerLateArms: gxTextureCopyProducerLateArms,
            textureCopyProducerRecoveryArms: gxTextureCopyProducerRecoveryArms,
            textureCopyCapturedSurfacesRetained: gxTextureCopyCapturedSurfacesRetained,
            textureCopies: gxTextureCopies,
            xfbCopies: gxXfbCopies,
            primitiveSamples: gxPrimitiveSamples,
            recentPrimitiveSamples: gxRecentPrimitiveSamples,
            lastPrimitiveSample: gxRecentPrimitiveSamples.at(-1) ?? null,
            state: {
              cp: gxSparseRegisters(gxCpRegisters),
              bp: gxSparseRegisters(gxBpRegisters),
              xf: {
                dualTexTransform: hex32(gxXfRegisters[0x1012]),
                matrixIndexA: hex32(gxXfRegisters[0x1018]),
                matrixIndexB: hex32(gxXfRegisters[0x1019]),
                viewport: Array.from({ length: 6 }, (_unused, index) =>
                  gxXfFloat(0x101a + index)
                ),
                projection: Array.from({ length: 7 }, (_unused, index) =>
                  index === 6 ? gxXfRegisters[0x1026] : gxXfFloat(0x1020 + index)
                ),
                channels: Object.fromEntries(
                  Array.from({ length: 11 }, (_unused, index) => 0x1008 + index)
                    .map(address => [
                      "0x" + address.toString(16),
                      hex32(gxXfRegisters[address]),
                    ])
                ),
                texgen: Object.fromEntries(
                  [0x103f, ...Array.from({ length: 8 }, (_unused, index) => 0x1040 + index),
                    ...Array.from({ length: 8 }, (_unused, index) => 0x1050 + index)]
                    .map(address => [
                      "0x" + address.toString(16),
                      hex32(gxXfRegisters[address]),
                    ])
                ),
              },
            },
          },
        },
        lockedCache: {
          address: "0xe0000000",
          bytes: lockedCacheSize,
          reads: lockedCacheReads,
          readBytes: lockedCacheReadBytes,
          writes: lockedCacheWrites,
          writeBytes: lockedCacheWriteBytes,
          dmaToRam: lockedCacheDmaToRam,
          dmaFromRam: lockedCacheDmaFromRam,
          dmaBytes: lockedCacheDmaBytes,
          dmaUpper: hex32(view.getUint32(cpu + dmaUpperOffset, true)),
          dmaLower: hex32(view.getUint32(cpu + dmaLowerOffset, true)),
          dmaSample: lockedCacheDmaSample,
        },
        diskReads: {
          bytes: diskReadBytes,
          hashedBytes: diskHashedBytes,
          hash: "0x" + diskReadHash.toString(16).padStart(8, "0"),
        },
        diskCommands: {
          counts: Object.fromEntries(diskCommandCounts),
          lastError: "0x" + diskLastError.toString(16).padStart(8, "0"),
          driveState: diskDriveState,
          trace: diskCommandTrace,
          audio: {
            enabled: diskAudioEnabled,
            bufferLength: diskAudioBufferLength,
            streaming: diskAudioStreaming,
            stopAtTrackEnd: diskAudioStopAtTrackEnd,
            position: diskAudioPosition,
            start: diskAudioStart,
            length: diskAudioLength,
            nextStart: diskAudioNextStart,
            nextLength: diskAudioNextLength,
            nextCycle: nextDiskAudioCycle,
            ...diskAudioTiming(),
            output: "hardware-state-only",
          },
        },
        controller: {
          sequence: controllerSequence,
          appliedSequence: controllerAppliedSequence,
          pendingButtons: controllerQueue.reduce(
            (buttons, queued) => buttons | queued.state.buttons,
            0
          ),
          queuedStates: controllerQueue.length,
          queueCapacity: controllerQueueCapacity,
          queueHighWater: controllerQueueHighWater,
          queueCoalesces: controllerQueueCoalesces,
          queueOverflows: controllerQueueOverflows,
          queuedSequenceSample: controllerQueue.slice(0, 8).map(queued => ({
            sequence: queued.sequence,
            buttons: queued.state.buttons,
          })),
          lastPolledButtons: serialLastPolledButtons,
          lastPolledSequence: serialLastPolledSequence,
          lastRespondedChannels: serialLastRespondedChannels,
          lastPublishedChannels: serialLastPublishedChannels,
          lastUpdatedChannels: serialLastUpdatedChannels,
          lastEnabledChannels: serialLastEnabledChannels,
          guestPad: inspectSuperMonkeyBallPad0(),
          ...controllerState,
        },
        guestGame: inspectSuperMonkeyBallGameState(),
        serialInterface: {
          transferInterruptAcknowledgements: serialTransferInterruptAcknowledgements,
          noResponseByChannel: [...serialNoResponseByChannel],
          periodicNoResponseByChannel: [...serialPeriodicNoResponseByChannel],
          noResponseAcknowledgedByChannel: [...serialNoResponseAcknowledgedByChannel],
          controllerModes: [...serialControllerModes],
          controllerRumble: [...serialControllerRumble],
          outputCommandsByChannel: [...serialOutputCommandsByChannel],
          unknownOutputCommands: serialUnknownOutputCommands,
          pollCatchUpBatches: serialPollCatchUpBatches,
          pollCatchUpPolls: serialPollCatchUpPolls,
          pollMaxBatch: serialPollMaxBatch,
          pollMaxLateness: serialPollMaxLateness,
          pollTrace: serialPollTrace,
          interruptLevelActive: serialInterruptLevelActive,
          interruptLevelChanges: serialInterruptLevelChanges,
          interruptLevelReason: serialInterruptLevelReason,
          lastTransfer: serialLastTransfer,
        },
        exceptions: {
          counts: Object.fromEntries(exceptionCounts),
          firstByVector: exceptionFirstByVector,
          firstTrace: exceptionFirstTrace,
          lastTrace: exceptionTrace,
          vector0800: Array.from({ length: 64 }, (_unused, index) =>
            "0x" + view.getUint32(ram + 0x800 + index * 4, false).toString(16).padStart(8, "0")
          ),
        },
        osThreads: inspectOsThreads(),
        cpuState: {
          signature: hex32(cpuSignature()),
          pc: "0x" + view.getUint32(cpu + pcOffset, true).toString(16).padStart(8, "0"),
          msr: "0x" + view.getUint32(cpu + msrOffset, true).toString(16).padStart(8, "0"),
          lr: "0x" + view.getUint32(cpu + lrOffset, true).toString(16).padStart(8, "0"),
          ctr: "0x" + view.getUint32(cpu + ctrOffset, true).toString(16).padStart(8, "0"),
          srr0: "0x" + view.getUint32(cpu + srr0Offset, true).toString(16).padStart(8, "0"),
          srr1: "0x" + view.getUint32(cpu + srr1Offset, true).toString(16).padStart(8, "0"),
          gpr: Object.fromEntries(Array.from({ length: 32 }, (_unused, index) => [
            "r" + index,
            "0x" + readGpr(index).toString(16).padStart(8, "0"),
          ])),
          // Keep enough of the active frame to include ABI save areas from
          // larger variadic diagnostics such as OSPanic.
          stackWords: inspectRamWords(readGpr(1), 64),
        },
        mmioState: {
          commandProcessor: Object.fromEntries(
            [0x0000, 0x0002, 0x0004, 0x0030, 0x0032, 0x0034, 0x0036, 0x0038, 0x003a]
              .map(offset => [
                "0x" + offset.toString(16).padStart(4, "0"),
                "0x" + view.getUint16(mmio + offset, false).toString(16).padStart(4, "0"),
              ])
          ),
          pixelEngine: Object.fromEntries(
            [0x100a, 0x100e].map(offset => [
              "0x" + offset.toString(16),
              "0x" + view.getUint16(mmio + offset, false).toString(16).padStart(4, "0"),
            ])
          ),
          viTiming: viTiming === null ? decodeViTiming() : {
            ...viTiming,
            currentHalfLine: viCurrentHalfLine(cycles),
            currentVct: 1 + Math.floor(viCurrentHalfLine(cycles) / 2),
            currentFieldParity: viCurrentHalfLine(cycles) < viTiming.oddHalfLines
              ? "odd"
              : "even",
            epochCycle: viEpochCycle,
            epochHalfLine: viEpochHalfLine,
          },
          viInterruptModel: {
            comparatorMatches: viComparatorMatches,
            statusAssertions: viStatusAssertions,
            acknowledgements: viInterruptAcknowledgements,
            piDeliveries: viPiDeliveries,
            timingReschedules: viTimingReschedules,
            missedHalfLines: viMissedHalfLines,
            lastEventCycle: viLastEventCycle,
            lastEventInterval: viLastEventInterval,
            presentationCount: viPresentationCount,
            nextPresentationCycle: nextViPresentCycle,
            lastPresentationCycle: viLastPresentationCycle,
            lastPresentationField: viLastPresentationField,
            lastPresentationAddress: hex32(viLastPresentationAddress),
            serialPoll: {
              raw: hex32(view.getUint32(mmio + 0x6430, false)),
              xLines: (view.getUint32(mmio + 0x6430, false) >>> 16) & 0x03ff,
              yPolls: (view.getUint32(mmio + 0x6430, false) >>> 8) & 0x00ff,
            },
            trace: viTrace,
          },
          viDisplayConfig: "0x" + view.getUint16(mmio + 0x2002, false).toString(16).padStart(4, "0"),
          viXfbTop: "0x" + viXfbAddress(0x201c).toString(16).padStart(8, "0"),
          viXfbBottom: "0x" + viXfbAddress(0x2024).toString(16).padStart(8, "0"),
          viDisplayInterrupts: [0x2030, 0x2034, 0x2038, 0x203c].map(offset =>
            "0x" + view.getUint32(mmio + offset, false).toString(16).padStart(8, "0")
          ),
          piInterruptCause: "0x" + view.getUint32(mmio + 0x3000, false).toString(16).padStart(8, "0"),
          piInterruptMask: "0x" + view.getUint32(mmio + 0x3004, false).toString(16).padStart(8, "0"),
          disk: Array.from({ length: 10 }, (_unused, index) =>
            "0x" + view.getUint32(mmio + 0x6000 + index * 4, false).toString(16).padStart(8, "0")
          ),
          diskTransfer,
          serialTransfer,
          peFinishCycle,
          peFinishSignal,
          dspCurrentMail: hex32(dspCurrentMail),
          dspQueuedMails: dspMailQueue.length,
          dspScheduledMail,
          dspMode,
          dspTrace,
          dspAudioDma: {
            enabled: (view.getUint16(mmio + 0x5036, false) & 0x8000) !== 0,
            configuredBlocks: view.getUint16(mmio + 0x5036, false) & 0x7fff,
            remainingBlocks: dspAudioDmaRemainingBlocks,
            blocksLeft: dspAudioDmaBlocksLeft(),
            cyclesPerBlock: dspAudioDmaCyclesPerBlock(),
            nextInterruptCycle: nextDspAudioDmaInterruptCycle,
            nextCycle: nextDspAudioDmaCycle,
          },
          diskAudio: {
            streaming: diskAudioStreaming,
            position: diskAudioPosition,
            nextCycle: nextDiskAudioCycle,
            ...diskAudioTiming(),
            output: "hardware-state-only",
          },
          aramTransfer,
          nextViCycle,
          nextSerialPollCycle,
          nextAudioSampleCycle: nextAudioSampleCycle(),
          decrementer: "0x" + view.getUint32(cpu + decrementerOffset, true).toString(16).padStart(8, "0"),
          nextDecrementerCycle,
          decrementerPending,
          gpr26Plus12: inspectMmio(readGpr(26) + 12),
          gpr28Plus12: inspectMmio(readGpr(28) + 12),
          dsp: Object.fromEntries(
            [0x5000, 0x5002, 0x5004, 0x5006, 0x500a, 0x5012, 0x5016, 0x501a,
              0x5020, 0x5024, 0x5028, 0x502c, 0x5030, 0x5034, 0x5036, 0x503a]
              .map(offset => [
                "0x" + offset.toString(16),
                "0x" + view.getUint16(mmio + offset, false).toString(16).padStart(4, "0"),
              ])
          ),
          serial: Object.fromEntries(
            [0x6430, 0x6434, 0x6438].map(offset => [
              "0x" + offset.toString(16),
              "0x" + view.getUint32(mmio + offset, false).toString(16).padStart(8, "0"),
            ])
          ),
          serialInputHigh: Array.from({ length: 4 }, (_unused, channel) =>
            "0x" + view.getUint32(mmio + 0x6404 + channel * 12, false)
              .toString(16).padStart(8, "0")
          ),
          audio: Object.fromEntries(
            [0x6c00, 0x6c04, 0x6c08, 0x6c0c].map(offset => [
              "0x" + offset.toString(16),
              "0x" + view.getUint32(mmio + offset, false).toString(16).padStart(8, "0"),
            ])
          ),
        },
        ...details,
        lastPcs: recentPcs.map(pc => "0x" + pc.toString(16).padStart(8, "0")),
      };
      statusDataset.status = status;
      output.textContent = JSON.stringify(report, null, 2);
      console.log("BROWSER_BOOT_" + status.toUpperCase(), report);
    }

    async function honorRunnerControl() {
      if (runnerStopRequested) {
        await finishAfterRendererDrain("progress", {
          stage: "operator-stop",
          pc: hex32(pc),
          instructions,
          cycles,
          dispatches,
          compiledBlocks: blocks.size,
        });
        throw Symbol.for("reported");
      }
      if (!runnerPaused) return;
      statusDataset.status = "paused";
      await new Promise(resolve => {
        runnerResume = resolve;
      });
      runnerResume = null;
      if (runnerStopRequested) {
        await finishAfterRendererDrain("progress", {
          stage: "operator-stop",
          pc: hex32(pc),
          instructions,
          cycles,
          dispatches,
          compiledBlocks: blocks.size,
        });
        throw Symbol.for("reported");
      }
      statusDataset.status = "running";
      runnerYieldDeadline = Date.now() + runnerSliceMs;
    }

    async function honorRendererBackpressure(waitWhileStopping = false) {
      while (
        rendererFramesInFlight.size !== 0
        && rendererFailure === null
        && (waitWhileStopping || !runnerStopRequested)
      ) {
        rendererBackpressureWaits += 1;
        await new Promise(resolve => {
          rendererBackpressureResume = resolve;
        });
        rendererBackpressureResume = null;
      }
      if (rendererFailure !== null) {
        finish("stopped", {
          stage: "renderer",
          pc: hex32(pc),
          error: rendererFailure,
          instructions,
          cycles,
          dispatches,
          compiledBlocks: blocks.size,
        });
        throw Symbol.for("reported");
      }
      runnerYieldDeadline = Date.now() + runnerSliceMs;
    }

    async function finishAfterRendererDrain(status, details) {
      await honorRendererBackpressure(true);
      finish(status, details);
    }

    function publishRunnerSnapshot() {
      runnerSnapshotRequested = false;
      const status = runnerPaused ? "paused" : "running";
      finish(status, {
        stage: "snapshot",
        pc: hex32(pc),
        instructions,
        cycles,
        dispatches,
        compiledBlocks: blocks.size,
      });
      statusDataset.status = status;
    }

    let stage = "initialize";
    let pc = 0;
    let instructions = 0;
    let timeBaseLastCycle = 0n;
    let lastPc = null;
    let lastCpuSignature = null;
    let samePcCount = 0;
    const blocks = new Map();
    try {
      bytes.fill(0, ram, ram + ramSize);
      bytes.fill(0, mmio, mmio + mmioSize);
      // PI cause bit 16 is the active-low physical reset button input. Games
      // treat a cleared bit as a held reset button and eventually call
      // OSResetSystem, so power-on must expose the released state.
      view.setUint32(mmio + 0x3000, 0x00010000, false);
      view.setUint16(mmio + 0x5016, 1, false);
      pushDspMail(0x8071feed, false, "initialize");
      deviceEvents.set("dspInitialize", (deviceEvents.get("dspInitialize") ?? 0) + 1);
      initializeFastmem();
      bytes.fill(0, lockedCache, lockedCache + lockedCacheSize);
      bytes.fill(
        0,
        gxFifoStagingMeta,
        gxFifoStagingData + gxFifoStagingCapacity
      );
      initializeLowMemory();
      loadBootData();
      const bssTarget = dolU32(0xd8);
      const bssSize = dolU32(0xdc);
      if (bssSize !== 0) {
        const bssPointer = ramPointer(bssTarget, bssSize);
        check(bssPointer !== null, "DOL BSS extends past main RAM");
        bytes.fill(0, bssPointer, bssPointer + bssSize);
      }
      loadSections(0x00, 0x48, 0x90, 7);
      loadSections(0x1c, 0x64, 0xac, 11);
      pc = dolU32(0xe0);
      view.setUint32(cpu + pcOffset, pc, true);
      view.setUint32(cpu + msrOffset, 0x30, true);

      const { instance: compilerInstance } = await WebAssembly.instantiate(compilerWasm, {});
      compilerWasm = null;
      boot.bi2 = null;
      boot.dol = null;
      boot.fst = null;
      bi2 = null;
      dol = null;
      fst = null;
      const compiler = compilerInstance.exports;
      check(compiler.memory instanceof WebAssembly.Memory, "compiler did not export memory");
      const { instance: gxFifoHookInstance } = await WebAssembly.instantiate(
        gxFifoHookRuntimeWasm,
        {
          lazuli: { memory },
          lazuli_slow_hooks: hooks,
          lazuli_fifo: { flush: drainGxFifoStaging },
        }
      );
      const gxFifoHookExports = gxFifoHookInstance.exports;
      const jitHooks = new Proxy(hooks, {
        get(target, name) {
          return gxFifoHookExports[name] ?? Reflect.get(target, name);
        },
      });
      const inputPointer = compiler.ppcwasmjit_alloc_words(
        Math.max(64, maximumFusedRegionBlocks * 2)
      );
      statusDataset.cycleLimit = String(cycleLimit);
      statusDataset.dispatchLimit = String(dispatchLimit);
      statusDataset.status = "running";

      for (;;) {
        if (runnerSnapshotRequested) publishRunnerSnapshot();
        while (rendererFramesInFlight.size !== 0 || rendererFailure !== null) {
          await honorRendererBackpressure();
          if (runnerStopRequested) break;
          serviceVideoPresentation(cycles);
        }
        if (runnerPaused || runnerStopRequested) await honorRunnerControl();
        const reachedLimit = cycles >= cycleLimit
          ? "cycle-limit"
          : dispatches >= dispatchLimit
            ? "dispatch-limit"
            : null;
        if (reachedLimit !== null) {
          runnerPaused = true;
          finish("paused", {
            stage: reachedLimit,
            pc: "0x" + pc.toString(16).padStart(8, "0"),
            instructions,
            cycles,
            dispatches,
            compiledBlocks: blocks.size,
          });
          await honorRunnerControl();
          continue;
        }
        stage = "compile";
        let block = blocks.get(pc);
        if (block === undefined) {
          try {
            block = compileBlock(compiler, inputPointer, pc);
          } catch (error) {
            await finishAfterRendererDrain("stopped", {
              stage,
              pc: "0x" + pc.toString(16).padStart(8, "0"),
              instruction: "0x" + fetchWord(pc).toString(16).padStart(8, "0"),
              error: String(error?.message ?? error),
              instructions,
              cycles,
              dispatches,
              compiledBlocks: blocks.size,
            });
            throw Symbol.for("reported");
          }
          const { instance } = await WebAssembly.instantiate(block.wasm, {
            lazuli: { memory },
            lazuli_hooks: jitHooks,
          });
          block.instance = instance;
          delete block.wasm;
          blocks.set(pc, block);
        }

        stage = "link-region";
        const pendingRegion = maybeLinkHotRegion(compiler, inputPointer, pc);
        if (pendingRegion !== null) await pendingRegion;

        recentPcs.push(pc);
        if (recentPcs.length > 16) recentPcs.shift();
        const executedPc = pc;

        let executedInstructions = 0;
        let executedCycles = 0;
        let executedBlocks = 0;
        let executedRegion = false;
        let regionRequestedExit = false;
        const region = regionsByPc.get(pc);
        const eventCycle = nextRuntimeEventCycle();
        const regionCycleBudget = eventCycle === null
          ? 0x7fffffff
          : Math.min(0x7fffffff, eventCycle - cycles);
        const regionBlockBudget = Math.min(4096, dispatchLimit - dispatches);
        if (region !== undefined && regionCycleBudget > 0 && regionBlockBudget > 0) {
          stage = "execute-region";
          view.setUint32(regionControl, 0, true);
          view.setUint32(regionControl + 4, 0, true);
          regionRunning = true;
          try {
            const result = region.instance.exports.run(
              0,
              cpu,
              fastmem,
              pcOffset,
              regionControl,
              regionCycleBudget,
              regionBlockBudget
            );
            executedInstructions = result[0] >>> 0;
            executedCycles = result[1] >>> 0;
            executedBlocks = result[2] >>> 0;
          } finally {
            regionRunning = false;
          }
          if (executedBlocks !== 0) {
            executedRegion = true;
            regionRequestedExit = view.getUint32(regionControl + 4, true) !== 0;
            accelerations.set(
              "wasmRegionCalls",
              (accelerations.get("wasmRegionCalls") ?? 0) + 1
            );
            accelerations.set(
              "wasmRegionBlocks",
              (accelerations.get("wasmRegionBlocks") ?? 0) + executedBlocks
            );
          }
        }

        if (executedBlocks === 0) {
          stage = "execute";
          fastForwardRecognizedLoop(pc, block.maximum);
          try {
            const executed = block.instance.exports.run(0, cpu, fastmem) >>> 0;
            executedInstructions = executed & 0xffff;
            executedCycles = executed >>> 16;
            executedBlocks = 1;
          } catch (error) {
            await finishAfterRendererDrain("stopped", {
              stage,
              pc: "0x" + pc.toString(16).padStart(8, "0"),
              instruction: "0x" + fetchWord(pc).toString(16).padStart(8, "0"),
              error: String(error?.message ?? error),
              instructions,
              cycles,
              dispatches,
              compiledBlocks: blocks.size,
            });
            throw Symbol.for("reported");
          }
        }

        drainGxFifoStaging();

        const observedCycles = cycles + executedCycles;
        const diskWait = dueDiskTransferPromise(observedCycles);
        if (diskWait !== null) await diskWait;
        serviceMmio(observedCycles);
        instructions += executedInstructions;
        cycles = observedCycles;
        dispatches += executedBlocks;
        if (stopOnFirstDsi && firstDsi !== null) {
          await finishAfterRendererDrain("stopped", {
            stage: "first-dsi",
            pc: firstDsi.pc,
            instructions,
            cycles,
            dispatches,
            compiledBlocks: blocks.size,
            firstDsi,
          });
          throw Symbol.for("reported");
        }
        const nextPc = view.getUint32(cpu + pcOffset, true);
        if (executedRegion && !regionRequestedExit && region !== undefined) {
          stage = "fuse-region";
          const pendingFusion = maybeFuseRegionExit(
            compiler,
            inputPointer,
            region,
            nextPc
          );
          if (pendingFusion !== null) await pendingFusion;
        }
        const nextCpuSignature = cpuSignature();
        samePcCount = nextPc === lastPc && nextCpuSignature === lastCpuSignature
          ? samePcCount + 1
          : 0;
        lastPc = nextPc;
        lastCpuSignature = nextCpuSignature;
        pc = nextPc;

        const semanticIdle = !executedRegion
          && executedBlocks === 1
          && pc === executedPc
          && isSemanticIdlePattern(block.pattern);
        const stableWait = semanticIdle ? samePcCount >= 2 : samePcCount >= 128;
        if (stableWait) {
          const deviceEventCycle = nextRuntimeEventCycle(false);
          if (deviceEventCycle !== null) {
            const wakeCycle = Number.isFinite(cycleLimit)
              ? Math.min(deviceEventCycle, cycleLimit)
              : deviceEventCycle;
            const skipped = wakeCycle - cycles;
            cycles = wakeCycle;
            accelerations.set(
              "idleToInterruptCycles",
              (accelerations.get("idleToInterruptCycles") ?? 0) + skipped
            );
            accelerations.set(
              "idleToInterruptJumps",
              (accelerations.get("idleToInterruptJumps") ?? 0) + 1
            );
            const diskWait = dueDiskTransferPromise(cycles);
            if (diskWait !== null) await diskWait;
            serviceMmio(cycles);
            pc = view.getUint32(cpu + pcOffset, true);
            lastPc = null;
            lastCpuSignature = null;
            samePcCount = 0;
          }
        }

        if (pc === 0) {
          await finishAfterRendererDrain("stopped", {
            stage: "terminal-pc",
            pc: "0x00000000",
            instructions,
            cycles,
            dispatches,
            compiledBlocks: blocks.size,
          });
          throw Symbol.for("reported");
        }
        if (samePcCount >= 256 && diskTransfer === null && aramTransfer === null) {
          await finishAfterRendererDrain("progress", {
            stage: "stable-loop",
            pc: "0x" + pc.toString(16).padStart(8, "0"),
            instructions,
            cycles,
            dispatches,
            compiledBlocks: blocks.size,
          });
          throw Symbol.for("reported");
        }
        if (executedBlocks > 1 || (dispatches & 4095) === 0) {
          statusDataset.dispatches = String(dispatches);
          statusDataset.cycles = String(cycles);
          statusDataset.idleJumps = String(
            accelerations.get("idleToInterruptJumps") ?? 0
          );
        }
        runnerBlocksUntilYield -= Math.max(1, executedBlocks);
        if (runnerBlocksUntilYield <= 0) {
          const rest = runnerRestWhenDue(Date.now());
          if (rest !== null) {
            await yieldRunnerTask(rest);
            if (rest !== 0) {
              accelerations.set(
                "workerRestYields",
                (accelerations.get("workerRestYields") ?? 0) + 1
              );
            }
            runnerYieldDeadline = Date.now() + runnerSliceMs;
          }
          runnerBlocksUntilYield = runnerBlockChunk;
        }
      }

    } catch (error) {
      if (error !== Symbol.for("reported")) {
        try {
          await finishAfterRendererDrain("stopped", {
            stage,
            pc: "0x" + pc.toString(16).padStart(8, "0"),
            error: String(error?.stack ?? error),
            instructions,
            cycles,
            dispatches,
            compiledBlocks: blocks.size,
          });
        } catch (reportError) {
          if (reportError !== Symbol.for("reported")) throw reportError;
        }
      }
    }
  </script>
  <script type="module">
    import initBrowserRenderer, { WebGpuRenderer } from "/browser_renderer.js";

    const output = document.querySelector("#result") ?? { textContent: "" };
    const display = document.querySelector("#display");
    const runnerStatus = document.querySelector("#runner-status");
    let webGpuRenderer;
    try {
      await initBrowserRenderer();
      webGpuRenderer = await WebGpuRenderer.create(display);
      await webGpuRenderer.drain();
      webGpuRenderer.check_health();
      document.body.dataset.renderer = "wgpu-webgpu";
    } catch (error) {
      const failure = `WebGPU is required: ${String(error?.message ?? error)}`;
      document.body.dataset.status = "unsupported";
      document.body.dataset.renderer = "unavailable";
      runnerStatus.textContent = "WebGPU required";
      output.textContent = failure;
      throw new Error(failure, { cause: error });
    }
    let rendererOperationTail = Promise.resolve();
    function enqueueRendererOperation(operation) {
      const pending = rendererOperationTail.then(operation, operation);
      rendererOperationTail = pending.then(
        () => undefined,
        () => undefined
      );
      return pending;
    }
    function gxClearEfb(clearColor) {
      const [red, green, blue] = clearColor;
      webGpuRenderer.clear_efb(red, green, blue);
    }
    const source = document.querySelector("#runner-source").textContent;
    const debugSurface = document.querySelector(".shell").dataset.surface === "debug";
    const defaultDiscSourceConfig = __HAS_DISC__
      ? {
          kind: "logical-range-endpoint",
          url: new URL("/disc", location.href).href,
        }
      : __HAS_BOOT_ASSET__
        ? { kind: "boot-assets" }
        : null;
    const discStatus = document.querySelector("#disc-status");
    let worker = null;
    let workerUrl = null;

    function resetPresentation() {
      output.textContent = "STARTING";
      return enqueueRendererOperation(async () => {
        webGpuRenderer.reset();
        await drainWebGpuRenderer();
      }).catch(handleRendererError);
    }

    function startWorker(discConfig, label) {
      if (worker !== null) {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        resetPresentation();
      }
      const workerDiscConfig = discConfig.kind === "file"
        ? { kind: "file-message" }
        : discConfig;
      document.body.dataset.status = "loading";
      runnerStatus.textContent = "loading";
      const bootstrap = [
        `globalThis.runnerSearch = ${JSON.stringify(debugSurface ? location.search : "")};`,
        `globalThis.discSourceConfig = ${JSON.stringify(workerDiscConfig)};`,
        `globalThis.dolUrl = ${JSON.stringify(new URL("/boot.dol", location.href).href)};`,
        `globalThis.compilerWasmUrl = ${JSON.stringify(new URL("/ppcwasmjit.wasm", location.href).href)};`,
      ].join("\n");
      workerUrl = URL.createObjectURL(new Blob([bootstrap, "\n", source], {
        type: "text/javascript",
      }));
      worker = new Worker(workerUrl, { type: "module", name: "lazuli-cycle-runner" });
      worker.addEventListener("message", handleWorkerMessage);
      worker.addEventListener("error", handleWorkerError);
      if (discConfig.kind === "file") {
        worker.postMessage({ type: "disc-source-file", file: discConfig.file });
      }
      globalThis.lazuliWorker = worker;
      discStatus.textContent = label;
      queueMicrotask(() => { lastControllerPacket = ""; });
      return worker;
    }

    if (defaultDiscSourceConfig !== null) {
      startWorker(defaultDiscSourceConfig, "ready");
    } else {
      document.body.dataset.status = "waiting";
      runnerStatus.textContent = "waiting";
      discStatus.textContent = "open a disc";
      output.textContent = "Choose an ISO or CISO to begin.";
    }
    function postRunControl(message) {
      worker?.postMessage({ type: "run-control", ...message });
    }
    globalThis.lazuliCycleRunner = {
      pause() { postRunControl({ action: "pause" }); },
      resume() { postRunControl({ action: "resume" }); },
      extendCycles(cycles, dispatches) {
        postRunControl({ action: "extend", cycles, dispatches });
      },
      setRestMs(restMs) {
        postRunControl({ action: "throttle", restMs });
      },
      setRenderEvery(renderEvery) {
        postRunControl({ action: "presentation", renderEvery });
      },
      stop() { postRunControl({ action: "stop" }); },
      snapshot() { postRunControl({ action: "snapshot" }); },
    };
    const discFileInput = document.querySelector("#disc-file");
    discFileInput.addEventListener("click", event => {
      event.currentTarget.value = "";
    });
    discFileInput.addEventListener("change", event => {
      const file = event.currentTarget.files?.[0];
      if (file === undefined) return;
      startWorker({ kind: "file", file }, `local: ${file.name}`);
    });
    const pauseRunnerButton = document.querySelector("#pause-runner");
    if (pauseRunnerButton !== null) {
      const discUrlInput = document.querySelector("#disc-url");
      function loadDiscUrl() {
        try {
          const url = new URL(discUrlInput.value.trim());
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("unsupported protocol");
          }
          startWorker({ kind: "http-range", url: url.href }, `network: ${url.host}`);
        } catch (_error) {
          discStatus.textContent = "enter a valid HTTP URL";
          discUrlInput.focus();
        }
      }
      document.querySelector("#load-disc-url").addEventListener("click", loadDiscUrl);
      discUrlInput.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        loadDiscUrl();
      });
      pauseRunnerButton.addEventListener("click", () => {
        globalThis.lazuliCycleRunner.pause();
      });
      document.querySelector("#resume-runner").addEventListener("click", () => {
        globalThis.lazuliCycleRunner.resume();
      });
      document.querySelector("#extend-runner").addEventListener("click", () => {
        const cycles = Number(document.querySelector("#extend-cycles").value);
        const dispatchText = document.querySelector("#extend-dispatches").value.trim();
        const dispatches = dispatchText === "" ? undefined : Number(dispatchText);
        globalThis.lazuliCycleRunner.extendCycles(cycles, dispatches);
      });
      const runnerRestInput = document.querySelector("#runner-rest-ms");
      runnerRestInput.value = new URLSearchParams(location.search).get("restMs") ?? "0";
      document.querySelector("#apply-throttle").addEventListener("click", () => {
        globalThis.lazuliCycleRunner.setRestMs(Number(runnerRestInput.value));
      });
      const runnerRenderInput = document.querySelector("#runner-render-every");
      runnerRenderInput.value = new URLSearchParams(location.search).get("renderEvery") ?? "1";
      document.querySelector("#apply-presentation").addEventListener("click", () => {
        globalThis.lazuliCycleRunner.setRenderEvery(Number(runnerRenderInput.value));
      });
      document.querySelector("#snapshot-runner").addEventListener("click", () => {
        globalThis.lazuliCycleRunner.snapshot();
      });
      document.querySelector("#stop-runner").addEventListener("click", () => {
        globalThis.lazuliCycleRunner.stop();
      });
    }
    let controllerSequence = 0;
    let lastControllerPacket = "";
    let keyboardButtons = 0;
    let controllerPulseButtons = 0;
    const controllerPointers = new Map();
    const controllerPulseTimers = new Map();
    const controllerPulseStates = new Map();
    const controllerMinimumPointerPressMs = 250;
    // A human tap spans several 60 Hz game updates. Express that minimum in
    // guest SI publications so slow renderer backpressure cannot collapse it
    // into the single frame where an animated menu first notices the press.
    const controllerMinimumPulsePolls = 3;
    // A stalled guest must not turn a semantic click into long-lived input.
    const controllerPulseMaximumHoldMs = 2_000;
    function finishControllerPulse(button, pulse) {
      if (controllerPulseStates.get(button) !== pulse) return;
      clearTimeout(controllerPulseTimers.get(button));
      controllerPulseTimers.delete(button);
      controllerPulseStates.delete(button);
      controllerPulseButtons &= ~button;
      publishControllerState();
    }
    function scheduleControllerPulseTimer(button, pulse, duration) {
      clearTimeout(controllerPulseTimers.get(button));
      controllerPulseTimers.set(button, setTimeout(() => {
        if (controllerPulseStates.get(button) !== pulse) return;
        if (!pulse.minimumElapsed) {
          pulse.minimumElapsed = true;
          if (pulse.pollsRemaining > 0 && pulse.watchdogDelay > 0) {
            scheduleControllerPulseTimer(button, pulse, pulse.watchdogDelay);
            return;
          }
        }
        finishControllerPulse(button, pulse);
      }, Math.max(0, duration)));
    }
    function pulseControllerButton(
      button,
      duration = 250,
      minimumPolls = controllerMinimumPulsePolls
    ) {
      const previous = controllerPulseStates.get(button);
      if (previous !== undefined) finishControllerPulse(button, previous);
      controllerPulseButtons |= button;
      publishControllerState();
      const minimumDuration = Math.min(
        controllerPulseMaximumHoldMs,
        Math.max(0, Number(duration) || 0)
      );
      const pulse = {
        minimumElapsed: false,
        pollsRemaining: Math.max(0, minimumPolls),
        sequence: controllerSequence,
        watchdogDelay: controllerPulseMaximumHoldMs - minimumDuration,
      };
      controllerPulseStates.set(button, pulse);
      scheduleControllerPulseTimer(button, pulse, minimumDuration);
    }
    function acknowledgeControllerPoll(buttons, sequence) {
      if (!Number.isSafeInteger(sequence)) return;
      for (const active of controllerPointers.values()) {
        if ((buttons & active.button) !== 0 && sequence >= active.sequence) {
          active.polls += 1;
        }
      }
      for (const [button, pulse] of controllerPulseStates) {
        if (
          pulse.pollsRemaining <= 0
          || (buttons & button) === 0
          || sequence < pulse.sequence
        ) {
          continue;
        }
        pulse.pollsRemaining -= 1;
        if (pulse.pollsRemaining === 0 && pulse.minimumElapsed) {
          finishControllerPulse(button, pulse);
        }
      }
    }
    globalThis.lazuliController = {
      pulseUp(duration) { pulseControllerButton(0x0008, duration); },
      pulseDown(duration) { pulseControllerButton(0x0004, duration); },
      pulseLeft(duration) { pulseControllerButton(0x0001, duration); },
      pulseRight(duration) { pulseControllerButton(0x0002, duration); },
      pulseA(duration) { pulseControllerButton(0x0100, duration); },
      pulseB(duration) { pulseControllerButton(0x0200, duration); },
      pulseStart(duration) { pulseControllerButton(0x1000, duration); },
    };
    function releaseControllerPointer(event, preserveShortPress = false) {
      const active = controllerPointers.get(event.pointerId);
      if (active === undefined) return;
      if (preserveShortPress) {
        const elapsed = Number(event.timeStamp) - active.startedAt;
        const remaining = controllerMinimumPointerPressMs - (
          Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0
        );
        const remainingPolls = Math.max(
          0,
          controllerMinimumPulsePolls - active.polls
        );
        if (remaining > 0 || remainingPolls > 0) {
          pulseControllerButton(active.button, remaining, remainingPolls);
        }
      }
      controllerPointers.delete(event.pointerId);
      if (active.element.hasPointerCapture?.(event.pointerId)) {
        active.element.releasePointerCapture(event.pointerId);
      }
      publishControllerState();
    }
    function completeControllerPointer(event) {
      releaseControllerPointer(event, true);
    }
    function bindControllerButton(selector, button, pulse) {
      const element = document.querySelector(selector);
      element.style.touchAction = "none";
      element.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        const existingPulse = controllerPulseStates.get(button);
        if (existingPulse !== undefined) {
          finishControllerPulse(button, existingPulse);
        }
        const active = {
          button,
          element,
          polls: 0,
          sequence: controllerSequence,
          startedAt: Number(event.timeStamp),
        };
        controllerPointers.set(event.pointerId, active);
        try {
          element.setPointerCapture(event.pointerId);
        } catch (_error) {
          // Window-level release listeners below cover unsupported capture.
        }
        publishControllerState();
        active.sequence = controllerSequence;
        if (event.pointerType !== "mouse") event.preventDefault();
      });
      element.addEventListener("pointerup", completeControllerPointer);
      element.addEventListener("pointercancel", releaseControllerPointer);
      element.addEventListener("lostpointercapture", releaseControllerPointer);
      element.addEventListener("click", event => {
        // Native keyboard and assistive activation have no pointer click count.
        if (event.detail > 0) return;
        globalThis.lazuliController[pulse]();
      });
    }
    bindControllerButton("#controller-up", 0x0008, "pulseUp");
    bindControllerButton("#controller-down", 0x0004, "pulseDown");
    bindControllerButton("#controller-left", 0x0001, "pulseLeft");
    bindControllerButton("#controller-right", 0x0002, "pulseRight");
    bindControllerButton("#controller-a", 0x0100, "pulseA");
    bindControllerButton("#controller-b", 0x0200, "pulseB");
    bindControllerButton("#controller-start", 0x1000, "pulseStart");
    addEventListener("pointerup", releaseControllerPointer);
    addEventListener("pointercancel", releaseControllerPointer);
    const keyboardButtonMap = new Map([
      ["ArrowLeft", 0x0001],
      ["ArrowRight", 0x0002],
      ["ArrowDown", 0x0004],
      ["ArrowUp", 0x0008],
      ["KeyE", 0x0010],
      ["KeyW", 0x0020],
      ["KeyQ", 0x0040],
      ["KeyZ", 0x0100],
      ["KeyX", 0x0200],
      ["KeyA", 0x0400],
      ["KeyS", 0x0800],
      ["Enter", 0x1000],
    ]);
    function hasNativeKeyboardAction(target) {
      return target instanceof Element && target.closest(
        "a, button, input, select, summary, textarea, [contenteditable]"
      ) !== null;
    }
    addEventListener("keydown", event => {
      const button = keyboardButtonMap.get(event.code);
      if (button === undefined || hasNativeKeyboardAction(event.target)) return;
      keyboardButtons |= button;
      publishControllerState();
      event.preventDefault();
    });
    addEventListener("keyup", event => {
      const button = keyboardButtonMap.get(event.code);
      if (button === undefined) return;
      keyboardButtons &= ~button;
      publishControllerState();
      if (!hasNativeKeyboardAction(event.target)) event.preventDefault();
    });
    function clearControllerInput() {
      keyboardButtons = 0;
      controllerPulseButtons = 0;
      for (const timer of controllerPulseTimers.values()) clearTimeout(timer);
      controllerPulseTimers.clear();
      controllerPulseStates.clear();
      const activePointers = [...controllerPointers.entries()];
      controllerPointers.clear();
      for (const [pointerId, active] of activePointers) {
        if (active.element.hasPointerCapture?.(pointerId)) {
          active.element.releasePointerCapture(pointerId);
        }
      }
      publishControllerState();
    }
    addEventListener("blur", clearControllerInput);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) clearControllerInput();
    });
    function axisByte(value, invert = false) {
      const axis = Math.max(-1, Math.min(1, Number(value) || 0));
      return Math.max(0, Math.min(255, Math.round(0x80 + (invert ? -axis : axis) * 0x7f)));
    }
    function buttonPressed(gamepad, index) {
      return gamepad?.buttons[index]?.pressed === true;
    }
    function digitalAxisByte(buttons, negativeButton, positiveButton) {
      const negative = (buttons & negativeButton) !== 0;
      const positive = (buttons & positiveButton) !== 0;
      if (negative === positive) return 0x80;
      return negative ? 0x01 : 0xff;
    }
    function publishControllerState() {
      const gamepad = Array.from(navigator.getGamepads?.() ?? [])
        .find(candidate => candidate?.connected) ?? null;
      let virtualButtons = keyboardButtons | controllerPulseButtons;
      for (const active of controllerPointers.values()) virtualButtons |= active.button;
      let buttons = virtualButtons;
      if (buttonPressed(gamepad, 14)) buttons |= 0x0001;
      if (buttonPressed(gamepad, 15)) buttons |= 0x0002;
      if (buttonPressed(gamepad, 13)) buttons |= 0x0004;
      if (buttonPressed(gamepad, 12)) buttons |= 0x0008;
      if (buttonPressed(gamepad, 10)) buttons |= 0x0010;
      if (buttonPressed(gamepad, 5) || buttonPressed(gamepad, 7)) buttons |= 0x0020;
      if (buttonPressed(gamepad, 4) || buttonPressed(gamepad, 6)) buttons |= 0x0040;
      if (buttonPressed(gamepad, 0)) buttons |= 0x0100;
      if (buttonPressed(gamepad, 1)) buttons |= 0x0200;
      if (buttonPressed(gamepad, 2)) buttons |= 0x0400;
      if (buttonPressed(gamepad, 3)) buttons |= 0x0800;
      if (buttonPressed(gamepad, 9)) buttons |= 0x1000;
      const virtualDirections = virtualButtons & 0x000f;
      const state = {
        buttons,
        stickX: (virtualDirections & 0x0003) !== 0
          ? digitalAxisByte(virtualDirections, 0x0001, 0x0002)
          : axisByte(gamepad?.axes[0]),
        stickY: (virtualDirections & 0x000c) !== 0
          ? digitalAxisByte(virtualDirections, 0x0004, 0x0008)
          : axisByte(gamepad?.axes[1], true),
        cStickX: axisByte(gamepad?.axes[2]),
        cStickY: axisByte(gamepad?.axes[3], true),
        triggerL: Math.round((gamepad?.buttons[6]?.value ?? 0) * 0xff),
        triggerR: Math.round((gamepad?.buttons[7]?.value ?? 0) * 0xff),
        analogA: (buttons & 0x0100) !== 0 ? 0xff : 0,
        analogB: (buttons & 0x0200) !== 0 ? 0xff : 0,
      };
      const packet = JSON.stringify(state);
      if (packet !== lastControllerPacket) {
        lastControllerPacket = packet;
        controllerSequence += 1;
        worker?.postMessage({ type: "controller", sequence: controllerSequence, state });
      }
      return state;
    }
    function sampleController() {
      publishControllerState();
      requestAnimationFrame(sampleController);
    }
    sampleController();
    function queueGxDraw(draw) {
      const pipeline = draw.pipeline ?? {};
      const textureKeys = [];
      const textureMetadata = new Uint32Array(8 * 5);
      const texturePixels = [];
      for (let map = 0; map < 8; map += 1) {
        const texture = draw.textures?.[map] ?? {};
        const textureKey = String(texture.renderKey ?? texture.key ?? "");
        textureKeys.push(textureKey);
        const metadata = map * 5;
        textureMetadata[metadata] = texture.address ?? 0;
        textureMetadata[metadata + 1] = texture.textureCopyIndex ?? 0;
        textureMetadata[metadata + 2] = texture.width ?? 0;
        textureMetadata[metadata + 3] = texture.height ?? 0;
        // Keep the GX wrap and filter fields together so the renderer can
        // build the matching base-level WebGPU sampler without growing the ABI.
        textureMetadata[metadata + 4] = ((texture.wrapS ?? 0) & 3)
          | (((texture.wrapT ?? 0) & 3) << 2)
          | (texture.magFilter !== 0 ? 1 << 4 : 0)
          | (((texture.minFilter ?? 0) & 7) << 5);
        const sourcePixels = texture.pixels;
        const sourcePixelBytes = sourcePixels?.byteLength ?? sourcePixels?.length ?? 0;
        const decodedTextureIsResident = sourcePixelBytes > 0
          && textureKey !== ""
          && webGpuRenderer.has_decoded_texture(
            textureKey,
            textureMetadata[metadata + 2],
            textureMetadata[metadata + 3]
          );
        const pixels = decodedTextureIsResident || sourcePixels === undefined
          ? new Uint8Array()
          : sourcePixels instanceof Uint8Array
            ? sourcePixels
            : new Uint8Array(sourcePixels);
        texturePixels.push(pixels);
      }
      webGpuRenderer.push_tev_draw(
        draw.topology,
        draw.vertices instanceof Float32Array
          ? draw.vertices
          : new Float32Array(draw.vertices),
        draw.tevState instanceof Uint8Array
          ? draw.tevState
          : new Uint8Array(draw.tevState ?? []),
        textureKeys,
        textureMetadata,
        texturePixels,
        pipeline.zMode ?? 0,
        pipeline.blendMode ?? 0x18,
        pipeline.alphaTest ?? 0x003f0000,
        pipeline.cullMode ?? 0,
        pipeline.scissorX ?? 0,
        pipeline.scissorY ?? 0,
        pipeline.scissorWidth ?? 640,
        pipeline.scissorHeight ?? 528
      );
    }
    function queueGxGeometry(frame) {
      webGpuRenderer.begin_segment();
      for (const draw of frame.geometry.draws) queueGxDraw(draw);
    }
    async function drainWebGpuRenderer() {
      await webGpuRenderer.drain();
      webGpuRenderer.check_health();
    }
    function handleRendererFrame(message, render, sourceWorker = worker) {
      const rendererSequence = Number(message.rendererSequence);
      const isCurrentWorker = () => worker === sourceWorker;
      const fail = error => {
        if (!isCurrentWorker()) return { ok: false, value: null };
        const detail = String(error?.message ?? error);
        if (Number.isSafeInteger(rendererSequence)) {
          sourceWorker?.postMessage({
            type: "renderer-frame-failed",
            rendererSequence,
            error: detail,
          });
        }
        handleRendererError(error, false);
        return { ok: false, value: null };
      };
      return enqueueRendererOperation(() => {
        if (!isCurrentWorker()) return { ok: false, value: null };
        let value;
        try {
          value = render();
        } catch (error) {
          return fail(error);
        }
        return drainWebGpuRenderer().then(() => {
          if (!isCurrentWorker()) return { ok: false, value: null };
          if (Number.isSafeInteger(rendererSequence)) {
            sourceWorker?.postMessage({
              type: "renderer-frame-complete",
              rendererSequence,
            });
          }
          return { ok: true, value };
        }, fail);
      });
    }
    function handleRendererOperation(render, sourceWorker = worker) {
      return enqueueRendererOperation(() => {
        if (worker !== sourceWorker) return { ok: false, value: null };
        let value;
        try {
          value = render();
        } catch (error) {
          if (worker === sourceWorker) handleRendererError(error);
          return { ok: false, value: null };
        }
        return drainWebGpuRenderer().then(
          () => worker === sourceWorker
            ? { ok: true, value }
            : { ok: false, value: null },
          error => {
            if (worker === sourceWorker) handleRendererError(error);
            return { ok: false, value: null };
          }
        );
      });
    }
    function handleWorkerMessage(event) {
      const sourceWorker = event.currentTarget ?? worker;
      if (sourceWorker !== worker) return;
      const message = event.data;
      if (message?.type === "controller-poll") {
        acknowledgeControllerPoll(message.buttons, message.sequence);
      } else if (message?.type === "dataset") {
        document.body.dataset[message.name] = message.value;
        if (message.name === "status") runnerStatus.textContent = message.value;
      } else if (message?.type === "efb-clear") {
        return handleRendererOperation(() => gxClearEfb(message.clearColor), sourceWorker);
      } else if (message?.type === "texture-copy") {
        const frame = message.frame;
        return handleRendererFrame(message, () => {
          queueGxGeometry(frame);
          webGpuRenderer.copy_texture(
            frame.sourceX,
            frame.sourceY,
            frame.width,
            frame.sourceHeight,
            frame.destination,
            frame.index,
            frame.clear,
            frame.clearColor[0],
            frame.clearColor[1],
            frame.clearColor[2]
          );
          document.body.dataset.gxTextureCopies = String(frame.index);
        }, sourceWorker);
      } else if (message?.type === "xfb-copy") {
        const frame = message.frame;
        return handleRendererFrame(message, () => {
          queueGxGeometry(frame);
          webGpuRenderer.copy_xfb(
            frame.sourceX,
            frame.sourceY,
            frame.width,
            frame.sourceHeight,
            frame.width,
            frame.height,
            frame.destination,
            frame.stride,
            frame.index,
            frame.clear,
            frame.clearColor[0],
            frame.clearColor[1],
            frame.clearColor[2]
          );
          document.body.dataset.xfbCopies = String(frame.index);
          document.body.dataset.gxDrawCalls = String(frame.geometry.drawCalls);
          document.body.dataset.gxVertices = String(frame.geometry.vertices);
        }, sourceWorker);
      } else if (message?.type === "vi-present") {
        const frame = message.frame;
        return handleRendererFrame(message, () =>
          webGpuRenderer.present_xfb(
            frame.address,
            frame.copyIndex,
            frame.copyRow,
            Math.max(0, Math.min(1024, frame.width)),
            Math.max(0, Math.min(1024, frame.height))
          ),
          sourceWorker
        ).then(presentation => {
          if (!presentation.ok) return;
          const presented = presentation.value;
          document.body.dataset.viField = frame.field;
          document.body.dataset.viXfbAddress =
            "0x" + frame.address.toString(16).padStart(8, "0");
          document.body.dataset.viCopyIndex = String(frame.copyIndex);
          document.body.dataset.viCopyRow = String(frame.copyRow);
          document.body.dataset.viFields = String(
            Number(document.body.dataset.viFields ?? 0) + 1
          );
          if (presented) {
            document.body.dataset.viPresents = String(
              Number(document.body.dataset.viPresents ?? 0) + 1
            );
          }
        });
      } else if (message?.type === "finish") {
        output.textContent = message.text;
      }
    }
    function handleWorkerError(event) {
      if (event.currentTarget !== undefined && event.currentTarget !== worker) return;
      const message = String(event.message || "unknown worker error");
      document.body.dataset.status = "stopped";
      runnerStatus.textContent = "worker error";
      discStatus.textContent = message;
      output.textContent = JSON.stringify({
        status: "stopped",
        stage: "worker",
        error: message,
      }, null, 2);
    }
    function handleRendererError(error, notifyWorker = true) {
      const detail = String(error?.message ?? error);
      if (notifyWorker) {
        worker?.postMessage({ type: "renderer-failed", error: detail });
      }
      handleWorkerError({
        message: `WebGPU renderer failed: ${detail}`,
      });
    }
    addEventListener("beforeunload", () => {
      worker?.terminate();
      if (workerUrl !== null) URL.revokeObjectURL(workerUrl);
    }, { once: true });
  </script>
</body>
</html>
"##;
