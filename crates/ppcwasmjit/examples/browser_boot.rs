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
const GX_FIFO_STAGING_CAPACITY: usize = 64 * 1024;
const FASTMEM_PAGE_SHIFT: u32 = 17;
const FASTMEM_LUT_COUNT: usize = 1 << 15;
const DISC_BI2_OFFSET: u64 = 0x440;
const DISC_BI2_SIZE: usize = 0x2000;
const DISC_SOURCE_RUNTIME: &str = include_str!("browser_disc_source.mjs");
const IPL_IMAGE_SIZE: usize = 2 * 1024 * 1024;
const IPL_FONT_JAPANESE_OFFSET: usize = 0x1a_ff00;
const IPL_FONT_JAPANESE: &[u8] = include_bytes!("../../../resources/ipl/font_japanese.bin");
const IPL_FONT_WESTERN_OFFSET: usize = 0x1f_cf00;
const IPL_FONT_WESTERN: &[u8] = include_bytes!("../../../resources/ipl/font_western.bin");

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
    let segment_register_offsets = Reg::SR
        .map(|register| register.offset().to_string())
        .join(",");
    let instruction_bat_offsets = [
        [SPR::IBAT0L, SPR::IBAT0U],
        [SPR::IBAT1L, SPR::IBAT1U],
        [SPR::IBAT2L, SPR::IBAT2U],
        [SPR::IBAT3L, SPR::IBAT3U],
    ]
    .map(|[lower, upper]| format!("[{},{}]", lower.offset(), upper.offset()))
    .join(",");
    let data_bat_offsets = [
        [SPR::DBAT0L, SPR::DBAT0U],
        [SPR::DBAT1L, SPR::DBAT1U],
        [SPR::DBAT2L, SPR::DBAT2U],
        [SPR::DBAT3L, SPR::DBAT3U],
    ]
    .map(|[lower, upper]| format!("[{},{}]", lower.offset(), upper.offset()))
    .join(",");
    let gx_fifo_runtime = gx_fifo_hook_runtime(
        GX_FIFO_STAGING_META_PTR as u32,
        GX_FIFO_STAGING_DATA_PTR as u32,
        GX_FIFO_STAGING_CAPACITY as u32,
    );
    assert!(
        IPL_FONT_JAPANESE_OFFSET + IPL_FONT_JAPANESE.len() <= IPL_FONT_WESTERN_OFFSET,
        "bundled Japanese IPL font overlaps the western font"
    );
    assert!(
        IPL_FONT_WESTERN_OFFSET + IPL_FONT_WESTERN.len() <= IPL_IMAGE_SIZE,
        "bundled western IPL font exceeds the virtual IPL image"
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
        .replace("__IPL_FONT_JAPANESE__", &hex(IPL_FONT_JAPANESE))
        .replace(
            "__IPL_FONT_JAPANESE_OFFSET__",
            &IPL_FONT_JAPANESE_OFFSET.to_string(),
        )
        .replace("__IPL_FONT_WESTERN__", &hex(IPL_FONT_WESTERN))
        .replace(
            "__IPL_FONT_WESTERN_OFFSET__",
            &IPL_FONT_WESTERN_OFFSET.to_string(),
        )
        .replace("__FST_MAX_SIZE__", &disc.filesystem_max_size.to_string())
        .replace("__GPR_OFFSETS__", &gpr_offsets)
        .replace("__SR_OFFSETS__", &segment_register_offsets)
        .replace("__IBAT_OFFSETS__", &instruction_bat_offsets)
        .replace("__DBAT_OFFSETS__", &data_bat_offsets)
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
        .replace("__SDR1_OFFSET__", &SPR::SDR1.offset().to_string())
        .replace("__LR_OFFSET__", &SPR::LR.offset().to_string())
        .replace("__DAR_OFFSET__", &SPR::DAR.offset().to_string())
        .replace("__DSISR_OFFSET__", &SPR::DSISR.offset().to_string())
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
    button:focus-visible, .button:focus-visible, .file-picker:focus-within,
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

    .file-picker {
      position: relative;
      overflow: hidden;
    }

    .file-picker input[type="file"] {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      cursor: pointer;
    }

    #disc-status, #ipl-status {
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

    .shell[data-surface="release"] #disc-status,
    .shell[data-surface="release"] #ipl-status {
      max-width: min(36vw, 24rem);
      color: #8f98a6;
      font-size: 0.75rem;
    }

    .shell[data-surface="release"] .file-picker {
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

    body:not([data-status="waiting"]) .shell[data-surface="release"] .file-picker {
      border-color: rgba(255, 255, 255, 0.14);
      background: rgba(14, 15, 18, 0.64);
      color: #d9dde4;
      opacity: 0.56;
      backdrop-filter: blur(1rem) saturate(125%);
      transition: opacity 150ms ease, background 150ms ease;
    }

    body:not([data-status="waiting"]) .shell[data-surface="release"] .file-picker:hover,
    body:not([data-status="waiting"]) .shell[data-surface="release"] .file-picker:focus-within {
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

    body[data-status="waiting"] .shell[data-surface="release"] .file-picker {
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

    body[data-compositor-capture="enabled"] .shell {
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

    body[data-compositor-capture="enabled"] .shell > header,
    body[data-compositor-capture="enabled"] .shell > .play-controls,
    body[data-compositor-capture="enabled"] .shell > details,
    body[data-compositor-capture="enabled"] .shell > footer {
      display: none !important;
    }

    body[data-compositor-capture="enabled"] .stage {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 0;
      border-radius: 0;
      box-shadow: none;
    }

    body[data-compositor-capture="enabled"] .shell #display {
      width: auto;
      height: auto;
      max-width: none;
      max-height: none;
      aspect-ratio: auto;
      object-fit: fill;
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
        <span aria-hidden="true">·</span>
        <span id="ipl-status">bundled font</span>
      </div>
      <label class="button primary file-picker disc-picker">
        Open ISO or CISO
        <input id="disc-file" type="file" aria-label="Open ISO or CISO" accept=".iso,.ciso,.cso,application/octet-stream">
      </label>
      <label class="button file-picker ipl-picker">
        <span id="ipl-picker-label">Use local IPL</span>
        <input id="ipl-file" type="file" aria-label="Use local IPL" accept=".bin,application/octet-stream">
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
    const rendererViFrames = new Map();
    let rendererBackpressureResume = null;
    let rendererBackpressureWaits = 0;
    let rendererFramesAcknowledged = 0;
    let rendererFrameFailures = 0;
    let rendererFrameHighWater = 0;
    let rendererFrameResultMisses = 0;
    let rendererFailure = null;
    let rendererResidentTextureKeys = new Set();
    const exiIplImageBytes = 2 * 1024 * 1024;
    const exiSramBase = 0x00800000;
    const exiSramBytes = 0x44;
    const exiSramSettingsBase = exiSramBase + 4;
    const exiRtcStartSeconds = 0;
    const exiRtcCyclesPerSecond = 486_000_000;
    const workerExecutionTimingSampleStride = 1024;
    let workerExecutionTimingEligibleCalls = 0;
    function newWorkerPhaseTiming(sampleStride) {
      return { eligibleCalls: 0, sampleStride, samples: 0, totalMs: 0, maxMs: 0 };
    }
    function newWorkerHostTimings() {
      return {
        execution: newWorkerPhaseTiming(1024),
        fifoStagingDrainInclusive: newWorkerPhaseTiming(256),
        fifoDecode: newWorkerPhaseTiming(1024),
        gxPacketPacking: newWorkerPhaseTiming(64),
        rendererBackpressure: newWorkerPhaseTiming(1),
      };
    }
    function beginWorkerPhaseTiming(timing) {
      const eligibleCall = timing.eligibleCalls;
      timing.eligibleCalls += 1;
      return eligibleCall % timing.sampleStride === 0 ? performance.now() : null;
    }
    function beginWorkerExecutionTiming() {
      const eligibleCall = workerExecutionTimingEligibleCalls;
      workerExecutionTimingEligibleCalls += 1;
      return (eligibleCall & (workerExecutionTimingSampleStride - 1)) === 0
        ? performance.now()
        : null;
    }
    function recordWorkerPhaseTiming(timing, startedAt, endedAt) {
      if (startedAt === null) return;
      const stoppedAt = endedAt === undefined ? performance.now() : endedAt;
      const durationMs = stoppedAt - startedAt;
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      timing.samples += 1;
      timing.totalMs = Math.min(Number.MAX_VALUE, timing.totalMs + durationMs);
      timing.maxMs = Math.max(timing.maxMs, durationMs);
    }
    function snapshotWorkerHostTimings(
      timings = workerHostTimings,
      executionEligibleCalls = workerExecutionTimingEligibleCalls
    ) {
      return {
        execution: { ...timings.execution, eligibleCalls: executionEligibleCalls },
        fifoStagingDrainInclusive: { ...timings.fifoStagingDrainInclusive },
        fifoDecode: { ...timings.fifoDecode },
        gxPacketPacking: { ...timings.gxPacketPacking },
        rendererBackpressure: { ...timings.rendererBackpressure },
      };
    }
    const workerHostTimings = newWorkerHostTimings();
    const smbTemporalXfbCaptureCapacity = 8;
    let smbTemporalXfbCapturesPosted = 0;
    const smbSustainedViReceiptCapacity = 120;
    let smbSustainedViReceiptsPosted = 0;
    const smbSustainedViReceipts = [];
    const smbSustainedViPending = new Map();
    let smbSustainedViFailure = null;
    let smbReadyPlayAnchor = null;
    let wariowareLastActiveGameplayInput = null;
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
    const requestedControllerScenario = new URLSearchParams(
      globalThis.runnerSearch
    ).get("scenario");
    let controllerScenarioInputExclusive = false;
    let controllerQueueHighWater = 0;
    let controllerQueueCoalesces = 0;
    let controllerQueueOverflows = 0;
    let serialLastPollSignature = null;
    let controllerPollIndex = 0;
    let serialLastPolledButtons = 0;
    let serialLastPolledSequence = 0;
    let serialLastPolledOrigin = "host";
    let serialLastActiveHostPublication = null;
    let serialLastRespondedChannels = 0;
    let serialLastPublishedChannels = 0;
    let serialLastUpdatedChannels = 0;
    let serialLastEnabledChannels = 0;
    const cpStatusHighWatermark = 0x0001;
    const cpStatusLowWatermark = 0x0002;
    const cpStatusReadIdle = 0x0004;
    const cpStatusCommandIdle = 0x0008;
    const cpStatusBreakpoint = 0x0010;
    const cpControlReadEnable = 0x0001;
    const cpControlBreakpointEnable = 0x0002;
    const cpControlHighWatermarkInterruptEnable = 0x0004;
    const cpControlLowWatermarkInterruptEnable = 0x0008;
    const cpControlMask = 0x003f;
    const cpControlLinkEnable = 0x0010;
    const cpControlBreakpointInterruptEnable = 0x0020;
    const cpClearHighWatermarkInterrupt = 0x0001;
    const cpClearLowWatermarkInterrupt = 0x0002;
    const cpClearPerformanceMetrics = 0x0004;
    const cpFifoAddressMask = 0x03ffffe0;
    const cpFifoLowWordMask = 0xffe0;
    const cpFifoHighWordMask = 0x03ff;
    const piFifoEndMask = 0x07ffffe0;
    const piFifoRedirectEnd = 0x04000000;
    const piFifoWrap = 0x20000000;
    const gxWriteGatherBurstBytes = 32;
    const commandProcessorServiceBudgetBytes = 256 * 1024;
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
    const piExternalInterfaceInterruptCause = 0x00000010;
    const piCommandProcessorInterruptCause = 0x00000800;
    const exiDeviceInterruptMask = 0x00000001;
    const exiDeviceInterrupt = 0x00000002;
    const exiTransferInterruptMask = 0x00000004;
    const exiTransferInterrupt = 0x00000008;
    const exiClockMask = 0x00000070;
    const exiDeviceSelectMask = 0x00000380;
    const exiAttachInterruptMask = 0x00000400;
    const exiAttachInterrupt = 0x00000800;
    const exiDeviceConnected = 0x00001000;
    const exiRomDisable = 0x00002000;
    const exiDmaRegisterMask = 0x03ffffe0;
    const exiTransferControlMask = 0x0000003f;
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
    function normalizeControllerState(state) {
      if (state === null || typeof state !== "object" || Array.isArray(state)) {
        throw new TypeError("controller state must be an object");
      }
      const integer = (name, maximum) => {
        const value = state[name];
        if (!Number.isSafeInteger(value)) {
          throw new TypeError(`controller state ${name} must be a safe integer`);
        }
        if (value < 0 || value > maximum) {
          throw new RangeError(
            `controller state ${name} must be between 0 and ${maximum}`
          );
        }
        return value;
      };
      return {
        buttons: integer("buttons", 0xffff),
        stickX: integer("stickX", 0xff),
        stickY: integer("stickY", 0xff),
        cStickX: integer("cStickX", 0xff),
        cStickY: integer("cStickY", 0xff),
        triggerL: integer("triggerL", 0xff),
        triggerR: integer("triggerR", 0xff),
        analogA: integer("analogA", 0xff),
        analogB: integer("analogB", 0xff),
      };
    }
    function controllerStatesEqual(left, right) {
      return left.buttons === right.buttons
        && left.stickX === right.stickX
        && left.stickY === right.stickY
        && left.cStickX === right.cStickX
        && left.cStickY === right.cStickY
        && left.triggerL === right.triggerL
        && left.triggerR === right.triggerR
        && left.analogA === right.analogA
        && left.analogB === right.analogB;
    }
    function matchControllerScenarioInputRequest(scenario, message) {
      const pulse = scenario?.pulse;
      if (
        scenario?.status !== "running"
        || pulse?.owner !== "page"
      ) return null;
      const input = message.scenarioInput;
      if (
        input === null
        || typeof input !== "object"
        || Array.isArray(input)
      ) return null;
      if (
        input.scenario !== scenario.id
        || input.step !== scenario.definition.steps[scenario.stepIndex]?.id
        || input.phase !== pulse.state
        || input.requestSequence !== pulse.requestSequence
      ) return null;
      const entry = scenario.steps.at(-1);
      const record = entry?.[pulse.state];
      if (record === undefined || record.sequence !== null) return null;
      return { input, record };
    }
    function enqueueControllerState(message) {
      const scenarioRequest = controllerScenarioInputExclusive
        ? matchControllerScenarioInputRequest(controllerScenario, message)
        : null;
      if (controllerScenarioInputExclusive && scenarioRequest === null) return;
      if (!Number.isSafeInteger(message.sequence) || message.sequence < 1) {
        throw new TypeError("controller sequence must be a positive safe integer");
      }
      if (message.sequence <= controllerSequence) return;
      const state = normalizeControllerState(message.state);
      if (
        scenarioRequest !== null
        && !controllerStatesEqual(state, scenarioRequest.record.state)
      ) {
        throw new TypeError("controller scenario state does not match its request");
      }
      const queued = {
        sequence: message.sequence,
        state,
      };
      if (scenarioRequest !== null) {
        scenarioRequest.record.sequence = queued.sequence;
        scenarioRequest.record.receivedCycle = cycles;
        queued.scenarioInput = {
          scenario: scenarioRequest.input.scenario,
          step: scenarioRequest.input.step,
          phase: scenarioRequest.input.phase,
          requestSequence: scenarioRequest.input.requestSequence,
        };
      }
      controllerSequence = queued.sequence;
      const previous = controllerQueue.at(-1);
      if (
        previous !== undefined
        && controllerStatesEqual(previous.state, queued.state)
      ) {
        controllerQueue[controllerQueue.length - 1] = queued;
        controllerQueueCoalesces += 1;
      } else if (
        controllerQueue.length === 0
        && controllerStatesEqual(controllerState, queued.state)
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
        // Full controller-state ordering is a correctness boundary. Surface
        // bounded queue exhaustion instead of silently merging or dropping input.
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

    function claimSmbTemporalXfbCapture() {
      const step = controllerScenario?.definition.steps[controllerScenario.stepIndex] ?? null;
      if (
        (
          controllerScenario?.id !== "smb-ready-play"
          && controllerScenario?.id !== "smb-sustained-play"
        )
        || step?.id !== "post-play-presented"
        || smbTemporalXfbCapturesPosted >= smbTemporalXfbCaptureCapacity
      ) return null;
      smbTemporalXfbCapturesPosted += 1;
      return {
        // Keep the v3 ready-to-PLAY anchor byte-compatible inside the v4 run.
        scenario: "smb-ready-play",
        step: step.id,
        ordinal: smbTemporalXfbCapturesPosted,
        capacity: smbTemporalXfbCaptureCapacity,
      };
    }

    function snapshotSmbSustainedGameplayState() {
      return {
        gameModeRequest: guestS16(0x802f1b90),
        gameMode: guestS16(0x802f1b92),
        gameSubmodeRequest: guestS16(0x802f1b8c),
        gameSubmode: guestS16(0x802f1b8e),
        infoTimer: guestS16(0x801f3a5c),
        attempts: guestS16(0x801f3a76),
        floor: guestS16(0x801f3a78),
      };
    }

    function claimSmbSustainedViReceipt(fieldPair) {
      const step = controllerScenario?.definition.steps[controllerScenario.stepIndex] ?? null;
      if (
        controllerScenario?.id !== "smb-sustained-play"
        || step?.id !== "sustained-play-presented"
        || (
          smbSustainedViReceiptsPosted === 0
          && fieldPair?.pairCompleting !== false
        )
        || smbSustainedViReceiptsPosted >= smbSustainedViReceiptCapacity
      ) return null;
      smbSustainedViReceiptsPosted += 1;
      return {
        scenario: controllerScenario.id,
        step: step.id,
        ordinal: smbSustainedViReceiptsPosted,
        capacity: smbSustainedViReceiptCapacity,
        gameplay: snapshotSmbSustainedGameplayState(),
      };
    }

    function postRendererFrame(type, frame, transfer = []) {
      const rendererSequence = ++rendererFrameSequence;
      rendererFramesInFlight.add(rendererSequence);
      if (type === "vi-present") rendererViFrames.set(rendererSequence, frame);
      if (type === "vi-present" && frame.sustainedPlayReceipt !== undefined) {
        smbSustainedViPending.set(rendererSequence, frame.sustainedPlayReceipt);
      }
      rendererFrameHighWater = Math.max(
        rendererFrameHighWater,
        rendererFramesInFlight.size
      );
      try {
        if (type === "gx-frame") {
          postMessage({
            type,
            packet: frame.packet,
            diagnostics: frame.diagnostics,
            rendererSequence,
          }, transfer);
        } else {
          postMessage({ type, frame, rendererSequence }, transfer);
        }
      } catch (error) {
        rendererFramesInFlight.delete(rendererSequence);
        rendererViFrames.delete(rendererSequence);
        smbSustainedViPending.delete(rendererSequence);
        throw error;
      }
    }

    function gxStrictV7RenderKey(key) {
      const domainTag = "~LZGX7:";
      if (
        typeof key !== "string"
        || key.length === 0
        || key.includes(domainTag)
      ) {
        return null;
      }
      // Keep the original numeric decoded-image key as the sort prefix so the
      // renderer's lexicographic-min eviction policy has no global V6/V7
      // domain bias. The reserved suffix and encoded source length keep the
      // V7 mapping injective and disjoint from generated legacy identities.
      return `${key}${domainTag}${key.length}`;
    }

    function gxStrictV7TextureSnapshotClassification(texture) {
      if (texture === null || typeof texture !== "object") return null;
      const key = texture.renderKey ?? texture.key;
      if (
        typeof key !== "string"
        || key.length === 0
        || key.includes("~LZGX7:")
      ) {
        return null;
      }
      const preflight = texture.strictV7Preflight;
      if (
        preflight === null
        || typeof preflight !== "object"
        || preflight.accepted !== true
        || preflight.mode0 !== texture.mode0
        || preflight.mode1 !== texture.mode1
        || preflight.format !== texture.format
        || preflight.width !== texture.width
        || preflight.height !== texture.height
        || preflight.levelCount !== texture.levelCount
      ) {
        return null;
      }
      const canonicalPreflight = gxStrictV7TexturePreflight(
        texture.mode0,
        texture.mode1,
        texture.format,
        texture.width,
        texture.height
      );
      if (
        canonicalPreflight.accepted !== true
        || preflight.classification !== canonicalPreflight.classification
        || preflight.mode0 !== canonicalPreflight.mode0
        || preflight.mode1 !== canonicalPreflight.mode1
        || preflight.format !== canonicalPreflight.format
        || preflight.width !== canonicalPreflight.width
        || preflight.height !== canonicalPreflight.height
        || preflight.levelCount !== canonicalPreflight.levelCount
        || preflight.minFilter !== canonicalPreflight.minFilter
        || preflight.mipMode !== canonicalPreflight.mipMode
        || preflight.magLinear !== canonicalPreflight.magLinear
        || preflight.minLinear !== canonicalPreflight.minLinear
        || preflight.diagonalLod !== canonicalPreflight.diagonalLod
        || preflight.lodBiasRaw !== canonicalPreflight.lodBiasRaw
        || preflight.lodBiasSixteenths
          !== canonicalPreflight.lodBiasSixteenths
        || preflight.lodMinRaw !== canonicalPreflight.lodMinRaw
        || preflight.lodMaxRaw !== canonicalPreflight.lodMaxRaw
        || preflight.effectiveLodMinRaw
          !== canonicalPreflight.effectiveLodMinRaw
        || preflight.effectiveLodMaxRaw
          !== canonicalPreflight.effectiveLodMaxRaw
        || preflight.wrapS !== canonicalPreflight.wrapS
        || preflight.wrapT !== canonicalPreflight.wrapT
      ) {
        return null;
      }
      const genuineMip =
        preflight.classification === "genuine-mip"
        && preflight.mipMode !== 0
        && preflight.levelCount > 1;
      const baseOnlyCompanion =
        preflight.classification === "base-only-companion"
        && (
          preflight.mipMode === 0
          || preflight.levelCount === 1
        );
      if (genuineMip) return "genuine-mip";
      if (baseOnlyCompanion) return "base-only-companion";
      return null;
    }

    function gxPrepareStrictV7Frame(frame) {
      const geometry = frame?.geometry;
      if (geometry === null || typeof geometry !== "object") return null;
      if (!Array.isArray(geometry.draws)) return null;

      // Pass zero is the allocation-free legacy hot path. An authentic live
      // producer always labels its genuine snapshot here; an untrusted label
      // can only request the strict validation pass, never bypass it.
      let hasGenuineMip = false;
      for (let drawIndex = 0; drawIndex < geometry.draws.length; drawIndex += 1) {
        const draw = geometry.draws[drawIndex];
        if (draw === null || typeof draw !== "object") return null;
        const textures = draw.textures;
        if (textures === undefined || textures === null) continue;
        if (!Array.isArray(textures) || textures.length > 8) return null;
        for (let textureMap = 0; textureMap < textures.length; textureMap += 1) {
          const texture = textures[textureMap];
          if (texture === undefined || texture === null) continue;
          if (typeof texture !== "object") return null;

          const key = texture.renderKey ?? texture.key;
          // V4-V7 all treat an empty key as an unused slot.
          if (key === undefined || key === null || key === "") continue;
          const preflight = texture.strictV7Preflight;
          hasGenuineMip ||= (
            preflight !== null
            && typeof preflight === "object"
            && preflight.accepted === true
            && preflight.classification === "genuine-mip"
            && preflight.mipMode !== 0
            && preflight.levelCount > 1
          );
        }
      }
      if (!hasGenuineMip) return null;

      // Pass one recomputes canonical preflight for every bound snapshot only
      // after a potential genuine chain has made the frame a V7 candidate.
      hasGenuineMip = false;
      for (let drawIndex = 0; drawIndex < geometry.draws.length; drawIndex += 1) {
        const draw = geometry.draws[drawIndex];
        const textures = draw.textures;
        if (textures === undefined || textures === null) continue;
        for (let textureMap = 0; textureMap < textures.length; textureMap += 1) {
          const texture = textures[textureMap];
          if (texture === undefined || texture === null) continue;
          const key = texture.renderKey ?? texture.key;
          if (key === undefined || key === null || key === "") continue;
          // This snapshot was produced from the raw BP words before the
          // legacy sampler mask. Recheck every occurrence, including repeated
          // image keys whose draw-local sampler state can differ.
          const classification =
            gxStrictV7TextureSnapshotClassification(texture);
          if (classification === null) return null;
          hasGenuineMip ||= classification === "genuine-mip";
        }
      }
      if (!hasGenuineMip) return null;

      // Pass two is V7-only. Clone the frame structure, but allocate a new
      // texture object only for genuine chains that require a disjoint layout
      // identity. Base-only companions retain their V6 cache identity.
      const draws = new Array(geometry.draws.length);
      for (let drawIndex = 0; drawIndex < geometry.draws.length; drawIndex += 1) {
        const draw = geometry.draws[drawIndex];
        const textures = draw.textures ?? [];
        const preparedTextures = textures.slice();
        for (let textureMap = 0; textureMap < textures.length; textureMap += 1) {
          const texture = textures[textureMap];
          if (texture === undefined || texture === null) continue;
          const key = texture.renderKey ?? texture.key;
          if (key === undefined || key === null || key === "") continue;
          if (texture.strictV7Preflight.classification !== "genuine-mip") {
            continue;
          }
          const renderKey = gxStrictV7RenderKey(key);
          if (renderKey === null) {
            throw new Error("strict GX mip key changed after preflight");
          }
          // Base-only resources have the same one-level layout in V6 and V7,
          // so they intentionally share legacy residency. Only a genuine mip
          // chain needs a disjoint renderer-cache identity.
          preparedTextures[textureMap] = { ...texture, renderKey };
        }
        draws[drawIndex] = { ...draw, textures: preparedTextures };
      }
      return {
        ...frame,
        geometry: {
          ...geometry,
          draws,
        },
      };
    }

    function packGxFramePacketForRenderer(
      copyKind,
      frame,
      residentTextureKeys = null
    ) {
      const v7Frame = gxPrepareStrictV7Frame(frame);
      if (v7Frame === null) {
        return packGxFramePacketV6(copyKind, frame, residentTextureKeys);
      }
      const packet = packGxFramePacketV7(
        copyKind,
        v7Frame,
        residentTextureKeys
      );
      if (new DataView(packet).getUint16(0x04, true) !== 7) {
        // Eligibility promised a genuine chain. A legacy result is therefore
        // a producer bug, not a reason to retry with a different cache layout.
        throw new Error("strict GX mip activation did not produce LZGX v7");
      }
      return packet;
    }

    function postGxFrame(copyKind, frame) {
      const diagnostics = {
        copyKind,
        index: frame.index,
        drawCalls: frame.geometry.drawCalls,
        vertices: frame.geometry.vertices,
      };
      // A FIFO drain can produce more than one copy before the async renderer
      // acknowledgement runs. Only omit payloads against a residency snapshot
      // when no earlier packet can still change that cache.
      const residentTextureKeys = rendererFramesInFlight.size === 0
        ? rendererResidentTextureKeys
        : null;
      const packingStartedAt = beginWorkerPhaseTiming(
        workerHostTimings.gxPacketPacking
      );
      let packet;
      try {
        packet = packGxFramePacketForRenderer(
          copyKind,
          frame,
          residentTextureKeys
        );
      } finally {
        recordWorkerPhaseTiming(workerHostTimings.gxPacketPacking, packingStartedAt);
      }
      postRendererFrame("gx-frame", { packet, diagnostics }, [packet]);
    }

    function gxFramePacketInteger(value, name, maximum = 0xffffffff) {
      if (
        !Number.isSafeInteger(value)
        || value < 0
        || value > maximum
      ) {
        throw new RangeError(
          `GX frame packet ${name} must be an integer from 0 through ${maximum}`
        );
      }
      return value;
    }

    function gxFramePacketAdd(left, right, name) {
      const sum = left + right;
      return gxFramePacketInteger(sum, name);
    }

    function gxFramePacketMultiply(left, right, name) {
      const product = left * right;
      return gxFramePacketInteger(product, name);
    }

    function gxFramePacketAlign16(value, name) {
      const padding = (16 - value % 16) % 16;
      return gxFramePacketAdd(value, padding, name);
    }

    function gxFramePacketBytes(value, name) {
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (!ArrayBuffer.isView(value)) {
        throw new TypeError(`GX frame packet ${name} must be an ArrayBuffer view`);
      }
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }

    function gxFramePacketEqualBytes(left, right) {
      if (left.byteLength !== right.byteLength) return false;
      if (left.buffer === right.buffer && left.byteOffset === right.byteOffset) return true;
      for (let index = 0; index < left.byteLength; index += 1) {
        if (left[index] !== right[index]) return false;
      }
      return true;
    }

    function gxFramePacketKeyBytes(key, encoder, name) {
      for (let index = 0; index < key.length; index += 1) {
        const codeUnit = key.charCodeAt(index);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
          const trailing = key.charCodeAt(index + 1);
          if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) {
            throw new TypeError(`GX frame packet ${name} contains an unpaired surrogate`);
          }
          index += 1;
        } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
          throw new TypeError(`GX frame packet ${name} contains an unpaired surrogate`);
        }
      }
      return encoder.encode(key);
    }

    function gxFramePacketSampler(texture, name) {
      const wrapS = gxFramePacketInteger(texture.wrapS ?? 0, `${name}.wrapS`, 3);
      const wrapT = gxFramePacketInteger(texture.wrapT ?? 0, `${name}.wrapT`, 3);
      const magFilter = gxFramePacketInteger(
        texture.magFilter ?? 0,
        `${name}.magFilter`,
        1
      );
      const minFilter = gxFramePacketInteger(
        texture.minFilter ?? 0,
        `${name}.minFilter`,
        7
      );
      const maxAnisotropy = gxFramePacketInteger(
        texture.maxAnisotropy ?? 0,
        `${name}.maxAnisotropy`,
        3
      );
      return (
        wrapS
        | (wrapT << 2)
        | (magFilter << 4)
        | (minFilter << 5)
        | (maxAnisotropy << 19)
      ) >>> 0;
    }

    function gxFramePacketPostCullEvidence(
      value,
      topology,
      vertexCount,
      cullMode,
      name
    ) {
      if (value === undefined || value === null) return null;
      if (Object.prototype.toString.call(value) !== "[object Uint8Array]") {
        throw new TypeError(
          `GX frame packet ${name}.postCullEvidence must be a Uint8Array`
        );
      }
      const triangleCount = gxSourceTriangleCount(topology, vertexCount);
      if (topology > 4 || triangleCount === 0) {
        throw new Error(
          `GX frame packet ${name}.postCullEvidence requires a nonempty triangle topology`
        );
      }
      const expectedBytes = Math.ceil(triangleCount / 4);
      if (value.byteLength !== expectedBytes) {
        throw new RangeError(
          `GX frame packet ${name}.postCullEvidence must contain ${expectedBytes} bytes`
        );
      }
      const evidence = new Uint8Array(value);
      const finalActions = triangleCount % 4;
      if (
        finalActions !== 0
        && (evidence[evidence.length - 1] >>> (finalActions * 2)) !== 0
      ) {
        throw new Error(
          `GX frame packet ${name}.postCullEvidence has nonzero high padding bits`
        );
      }
      for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        const action =
          (evidence[triangle >>> 2] >>> ((triangle & 3) * 2)) & 3;
        const permitted = cullMode === 0
          ? action >= 2
          : cullMode === 1
            ? action === 0 || action === 3
            : cullMode === 2
              ? action === 1 || action === 2
              : action <= 1;
        if (!permitted) {
          throw new Error(
            `GX frame packet ${name}.postCullEvidence action ${action} conflicts with cull mode ${cullMode}`
          );
        }
      }
      return evidence;
    }

    // LZGX v4 is the deterministic Worker-to-renderer boundary. The packet is
    // deliberately self-contained: one transferable ArrayBuffer, fixed-size
    // little-endian records, and byte sections whose padding is always zero.
    // Textures are emitted in first-use draw/slot order and referenced by
    // table index so repeated TEV bindings do not duplicate pixel payloads.
    // A compact tail can certify homogeneous cull/reorder decisions while raw
    // topology, cull state, and vertices remain unchanged for native fallback.
    function packGxFramePacketV4(copyKind, frame, residentTextureKeys = null) {
      copyKind = gxFramePacketInteger(copyKind, "copyKind", 2);
      if (copyKind !== 1 && copyKind !== 2) {
        throw new RangeError("GX frame packet copyKind must be 1 or 2");
      }
      if (frame === null || typeof frame !== "object") {
        throw new TypeError("GX frame packet frame must be an object");
      }
      if (frame.copyToXfb !== undefined) {
        if (typeof frame.copyToXfb !== "boolean") {
          throw new TypeError("GX frame packet frame.copyToXfb must be boolean");
        }
        if (frame.copyToXfb !== (copyKind === 2)) {
          throw new Error("GX frame packet copyKind conflicts with frame.copyToXfb");
        }
      }

      const geometry = frame.geometry;
      if (geometry === null || typeof geometry !== "object") {
        throw new TypeError("GX frame packet frame.geometry must be an object");
      }
      const draws = geometry.draws;
      if (!Array.isArray(draws)) {
        throw new TypeError("GX frame packet frame.geometry.draws must be an array");
      }
      const drawCount = gxFramePacketInteger(draws.length, "drawCount");
      if (
        geometry.drawCalls !== undefined
        && gxFramePacketInteger(geometry.drawCalls, "geometry.drawCalls") !== drawCount
      ) {
        throw new Error("GX frame packet geometry.drawCalls does not match draws.length");
      }

      const encoder = new TextEncoder();
      const scalarBits = new DataView(new ArrayBuffer(4));
      const textures = [];
      const textureByKey = new Map();
      const normalizedDraws = [];
      let totalVertexCount = 0;
      let vertexBytes = 0;
      let keyBytes = 0;
      let pixelBytes = 0;
      let evidenceBytes = 0;

      for (let drawIndex = 0; drawIndex < drawCount; drawIndex += 1) {
        const draw = draws[drawIndex];
        const name = `draws[${drawIndex}]`;
        if (draw === null || typeof draw !== "object") {
          throw new TypeError(`GX frame packet ${name} must be an object`);
        }
        const topology = gxFramePacketInteger(draw.topology, `${name}.topology`, 7);
        if (Object.prototype.toString.call(draw.vertices) !== "[object Float32Array]") {
          throw new TypeError(`GX frame packet ${name}.vertices must be a Float32Array`);
        }
        const vertices = gxFramePacketBytes(draw.vertices, `${name}.vertices`);
        if (vertices.byteLength % 144 !== 0) {
          throw new RangeError(
            `GX frame packet ${name}.vertices must contain 144 bytes per vertex`
          );
        }
        const vertexCount = vertices.byteLength / 144;
        if (
          draw.vertexCount !== undefined
          && gxFramePacketInteger(draw.vertexCount, `${name}.vertexCount`) !== vertexCount
        ) {
          throw new Error(`GX frame packet ${name}.vertexCount does not match vertices`);
        }
        totalVertexCount = gxFramePacketAdd(
          totalVertexCount,
          vertexCount,
          "totalVertexCount"
        );
        vertexBytes = gxFramePacketAdd(vertexBytes, vertices.byteLength, "vertexBytes");

        const tevState = gxFramePacketBytes(draw.tevState, `${name}.tevState`);
        if (tevState.byteLength !== 464) {
          throw new RangeError(`GX frame packet ${name}.tevState must be 464 bytes`);
        }
        const pipeline = draw.pipeline ?? {};
        if (pipeline === null || typeof pipeline !== "object") {
          throw new TypeError(`GX frame packet ${name}.pipeline must be an object`);
        }
        const drawTextures = draw.textures ?? [];
        if (!Array.isArray(drawTextures) || drawTextures.length > 8) {
          throw new RangeError(`GX frame packet ${name}.textures must have at most 8 slots`);
        }
        const textureReferences = [];
        for (let slot = 0; slot < 8; slot += 1) {
          const texture = drawTextures[slot];
          const textureName = `${name}.textures[${slot}]`;
          if (texture === undefined || texture === null) {
            textureReferences.push({ index: 0xffffffff, sampler: 0 });
            continue;
          }
          if (typeof texture !== "object") {
            throw new TypeError(`GX frame packet ${textureName} must be an object or null`);
          }
          const key = texture.renderKey ?? texture.key;
          if (key === undefined || key === null || key === "") {
            textureReferences.push({ index: 0xffffffff, sampler: 0 });
            continue;
          }
          if (typeof key !== "string") {
            throw new TypeError(`GX frame packet ${textureName} key must be a string`);
          }
          const sampler = gxFramePacketSampler(texture, textureName);
          const address = gxFramePacketInteger(
            texture.address ?? 0,
            `${textureName}.address`
          );
          const generation = gxFramePacketInteger(
            texture.textureCopyIndex ?? 0,
            `${textureName}.textureCopyIndex`
          );
          const width = gxFramePacketInteger(
            texture.width,
            `${textureName}.width`,
            1024
          );
          const height = gxFramePacketInteger(
            texture.height,
            `${textureName}.height`,
            1024
          );
          if (width === 0 || height === 0) {
            throw new RangeError(`GX frame packet ${textureName} dimensions must be nonzero`);
          }
          const sourcePixels = gxFramePacketBytes(
            texture.pixels === undefined ? new Uint8Array() : texture.pixels,
            `${textureName}.pixels`
          );
          const expectedPixels = gxFramePacketMultiply(
            gxFramePacketMultiply(width, height, `${textureName} pixel count`),
            4,
            `${textureName} pixel bytes`
          );
          if (
            sourcePixels.byteLength !== 0
            && sourcePixels.byteLength !== expectedPixels
          ) {
            throw new RangeError(
              `GX frame packet ${textureName}.pixels must be empty or width * height * 4 bytes`
            );
          }
          const pixels = residentTextureKeys?.has(key)
            ? new Uint8Array()
            : sourcePixels;

          let normalizedTexture = textureByKey.get(key);
          if (normalizedTexture === undefined) {
            const encodedKey = gxFramePacketKeyBytes(key, encoder, `${textureName} key`);
            if (encodedKey.byteLength === 0) {
              throw new Error(`GX frame packet ${textureName} key must encode to bytes`);
            }
            const pixelRelativeOffset = pixels.byteLength === 0
              ? 0
              : gxFramePacketAlign16(pixelBytes, "pixel relative offset");
            if (pixels.byteLength !== 0) {
              pixelBytes = gxFramePacketAdd(
                pixelRelativeOffset,
                pixels.byteLength,
                "pixelBytes"
              );
            }
            normalizedTexture = {
              index: textures.length,
              key,
              encodedKey,
              keyRelativeOffset: keyBytes,
              pixelRelativeOffset,
              address,
              generation,
              width,
              height,
              pixels,
            };
            keyBytes = gxFramePacketAdd(keyBytes, encodedKey.byteLength, "keyBytes");
            textures.push(normalizedTexture);
            textureByKey.set(key, normalizedTexture);
          } else if (
            normalizedTexture.address !== address
            || normalizedTexture.generation !== generation
            || normalizedTexture.width !== width
            || normalizedTexture.height !== height
            || !gxFramePacketEqualBytes(normalizedTexture.pixels, pixels)
          ) {
            throw new Error(
              `GX frame packet texture key ${JSON.stringify(key)} has conflicting contents`
            );
          }
          textureReferences.push({ index: normalizedTexture.index, sampler });
        }

        const tevView = new DataView(
          tevState.buffer,
          tevState.byteOffset,
          tevState.byteLength
        );
        const tevStageCount = tevView.getUint32(448, true);
        if (tevStageCount > 16) {
          throw new RangeError(`GX frame packet ${name}.tevState has too many stages`);
        }
        for (let offset = 452; offset < 464; offset += 1) {
          if (tevState[offset] !== 0) {
            throw new Error(`GX frame packet ${name}.tevState has nonzero padding`);
          }
        }
        for (let stage = 0; stage < 16; stage += 1) {
          const offset = stage * 16;
          if (stage >= tevStageCount) {
            for (let byte = offset; byte < offset + 16; byte += 1) {
              if (tevState[byte] !== 0) {
                throw new Error(
                  `GX frame packet ${name}.tevState has nonzero inactive stages`
                );
              }
            }
            continue;
          }
          const fields = [
            [offset, 0x00ffffff],
            [offset + 4, 0x00ffffff],
            [offset + 8, 0x000003ff],
            [offset + 12, 0x000003ff],
          ];
          for (const [fieldOffset, mask] of fields) {
            if ((tevView.getUint32(fieldOffset, true) & ~mask) !== 0) {
              throw new Error(
                `GX frame packet ${name}.tevState has noncanonical stage fields`
              );
            }
          }
        }
        for (let offset = 384; offset < 448; offset += 4) {
          if (tevView.getUint32(offset, true) > 3) {
            throw new Error(
              `GX frame packet ${name}.tevState has invalid swap-table channels`
            );
          }
        }
        const requiredTextureMaps = new Set();
        for (let stage = 0; stage < tevStageCount; stage += 1) {
          const references = tevView.getUint32(stage * 16 + 8, true);
          if ((references & (1 << 6)) === 0) continue;
          const textureMap = references & 7;
          requiredTextureMaps.add(textureMap);
          if (textureReferences[textureMap].index === 0xffffffff) {
            throw new Error(
              `GX frame packet ${name} TEV stage ${stage} requires missing texture map ${textureMap}`
            );
          }
        }
        for (let textureMap = 0; textureMap < 8; textureMap += 1) {
          if (
            !requiredTextureMaps.has(textureMap)
            && textureReferences[textureMap].index !== 0xffffffff
          ) {
            throw new Error(
              `GX frame packet ${name} provides unused texture map ${textureMap}`
            );
          }
        }

        const fogRangeBase = gxFramePacketInteger(
          pipeline.fogRangeBase ?? 0,
          `${name}.fogRangeBase`,
          0x00ffffff
        );
        const viewportHalfWidthBits = gxFramePacketInteger(
          pipeline.viewportHalfWidthBits ?? 0,
          `${name}.viewportHalfWidthBits`
        );
        if ((fogRangeBase & (1 << 10)) !== 0) {
          scalarBits.setUint32(0, viewportHalfWidthBits, true);
          const viewportHalfWidth = scalarBits.getFloat32(0, true);
          if (!Number.isFinite(viewportHalfWidth) || viewportHalfWidth === 0) {
            throw new RangeError(
              `GX frame packet ${name}.viewportHalfWidthBits must encode a finite nonzero f32 when fog range adjustment is enabled`
            );
          }
        }
        const cullMode = gxFramePacketInteger(
          pipeline.cullMode ?? 0,
          `${name}.cullMode`,
          3
        );
        const postCullEvidence = gxFramePacketPostCullEvidence(
          draw.postCullEvidence,
          topology,
          vertexCount,
          cullMode,
          name
        );
        const evidenceRelativeOffset = evidenceBytes;
        if (postCullEvidence !== null) {
          evidenceBytes = gxFramePacketAdd(
            evidenceBytes,
            postCullEvidence.byteLength,
            "post-cull evidence bytes"
          );
        }
        normalizedDraws.push({
          topology,
          vertexCount,
          vertexRelativeOffset: vertexBytes - vertices.byteLength,
          vertexValues: draw.vertices,
          tevState,
          textureReferences,
          cullMode,
          postCullEvidence,
          evidenceRelativeOffset,
          zMode: gxFramePacketInteger(
            pipeline.zMode ?? 0,
            `${name}.zMode`,
            0x00ffffff
          ),
          blendMode: gxFramePacketInteger(
            pipeline.blendMode ?? 0x18,
            `${name}.blendMode`,
            0x00ffffff
          ),
          alphaTest: gxFramePacketInteger(
            pipeline.alphaTest ?? 0x003f0000,
            `${name}.alphaTest`,
            0x00ffffff
          ),
          scissorX: gxFramePacketInteger(pipeline.scissorX ?? 0, `${name}.scissorX`),
          scissorY: gxFramePacketInteger(pipeline.scissorY ?? 0, `${name}.scissorY`),
          scissorWidth: gxFramePacketInteger(
            pipeline.scissorWidth ?? 640,
            `${name}.scissorWidth`
          ),
          scissorHeight: gxFramePacketInteger(
            pipeline.scissorHeight ?? 528,
            `${name}.scissorHeight`
          ),
          pixelControl: gxFramePacketInteger(
            pipeline.pixelControl ?? 0,
            `${name}.pixelControl`,
            0x00ffffff
          ),
          constantAlpha: gxFramePacketInteger(
            pipeline.constantAlpha ?? 0,
            `${name}.constantAlpha`,
            0x00ffffff
          ),
          zTextureBias: gxFramePacketInteger(
            pipeline.zTextureBias ?? 0,
            `${name}.zTextureBias`,
            0x00ffffff
          ),
          zTextureMode: gxFramePacketInteger(
            pipeline.zTextureMode ?? 0,
            `${name}.zTextureMode`,
            0x00ffffff
          ),
          fogRangeBase,
          fogRangeK: Array.from({ length: 5 }, (_unused, index) =>
            gxFramePacketInteger(
              pipeline.fogRangeK?.[index] ?? 0,
              `${name}.fogRangeK[${index}]`,
              0x00ffffff
            )
          ),
          fogWords: Array.from({ length: 5 }, (_unused, index) =>
            gxFramePacketInteger(
              pipeline.fogWords?.[index] ?? 0,
              `${name}.fogWords[${index}]`,
              0x00ffffff
            )
          ),
          viewportHalfWidthBits,
        });
      }

      if (
        geometry.vertices !== undefined
        && gxFramePacketInteger(geometry.vertices, "geometry.vertices") !== totalVertexCount
      ) {
        throw new Error("GX frame packet geometry.vertices does not match draw vertices");
      }

      const textureCount = gxFramePacketInteger(textures.length, "textureCount");
      const drawTableBytes = gxFramePacketMultiply(drawCount, 176, "drawTableBytes");
      const textureTableBytes = gxFramePacketMultiply(
        textureCount,
        64,
        "textureTableBytes"
      );
      const tevBytes = gxFramePacketMultiply(drawCount, 464, "tevBytes");
      pixelBytes = gxFramePacketAlign16(pixelBytes, "pixelBytes");
      const drawTableOffset = 160;
      const textureTableOffset = gxFramePacketAdd(
        drawTableOffset,
        drawTableBytes,
        "textureTableOffset"
      );
      const tevOffset = gxFramePacketAdd(
        textureTableOffset,
        textureTableBytes,
        "tevOffset"
      );
      const vertexOffset = gxFramePacketAdd(tevOffset, tevBytes, "vertexOffset");
      const keyOffset = gxFramePacketAdd(vertexOffset, vertexBytes, "keyOffset");
      const pixelOffset = gxFramePacketAlign16(
        gxFramePacketAdd(keyOffset, keyBytes, "key section end"),
        "pixelOffset"
      );
      const evidenceOffset = gxFramePacketAdd(
        pixelOffset,
        pixelBytes,
        "post-cull evidence offset"
      );
      const packetBytes = gxFramePacketAlign16(
        gxFramePacketAdd(evidenceOffset, evidenceBytes, "packet section end"),
        "packetBytes"
      );

      const sourceX = gxFramePacketInteger(frame.sourceX, "frame.sourceX");
      const sourceY = gxFramePacketInteger(frame.sourceY, "frame.sourceY");
      const sourceWidth = gxFramePacketInteger(
        frame.sourceWidth ?? frame.width,
        "frame.sourceWidth"
      );
      const sourceHeight = gxFramePacketInteger(frame.sourceHeight, "frame.sourceHeight");
      const outputWidth = copyKind === 2
        ? gxFramePacketInteger(frame.outputWidth ?? frame.width, "frame.outputWidth", 1024)
        : 0;
      const outputHeight = copyKind === 2
        ? gxFramePacketInteger(frame.outputHeight ?? frame.height, "frame.outputHeight", 1024)
        : 0;
      const destination = gxFramePacketInteger(frame.destination, "frame.destination");
      const stride = copyKind === 2
        ? gxFramePacketInteger(frame.stride, "frame.stride")
        : 0;
      if (sourceWidth === 0 || sourceHeight === 0) {
        throw new RangeError("GX frame packet source dimensions must be nonzero");
      }
      if (copyKind === 2 && (outputWidth === 0 || outputHeight === 0 || stride === 0)) {
        throw new RangeError(
          "GX frame packet XFB output dimensions and stride must be nonzero"
        );
      }
      const generation = gxFramePacketInteger(frame.index, "frame.index");
      if (typeof frame.clear !== "boolean") {
        throw new TypeError("GX frame packet frame.clear must be boolean");
      }
      const copyState = frame.copyState;
      if (copyState === null || typeof copyState !== "object") {
        throw new TypeError("GX frame packet frame.copyState must be an object");
      }
      const clearRgba = copyState.clearRgba;
      if (clearRgba === null || clearRgba === undefined || clearRgba.length !== 4) {
        throw new RangeError(
          "GX frame packet frame.copyState.clearRgba must have four bytes"
        );
      }
      const rgba = Array.from(clearRgba, (component, index) =>
        gxFramePacketInteger(
          component,
          `frame.copyState.clearRgba[${index}]`,
          0xff
        )
      );
      const terminalZMode = gxFramePacketInteger(
        copyState.zMode,
        "frame.copyState.zMode",
        0x00ffffff
      );
      const terminalBlendMode = gxFramePacketInteger(
        copyState.blendMode,
        "frame.copyState.blendMode",
        0x00ffffff
      );
      const pixelControl = gxFramePacketInteger(
        copyState.pixelControl,
        "frame.copyState.pixelControl",
        0x00ffffff
      );
      const copyCommand = gxFramePacketInteger(
        copyState.copyCommand,
        "frame.copyState.copyCommand",
        0x00ffffff
      );
      const clearDepth = gxFramePacketInteger(
        copyState.clearDepth,
        "frame.copyState.clearDepth",
        0x00ffffff
      );
      const copyScale = gxFramePacketInteger(
        copyState.copyScale,
        "frame.copyState.copyScale",
        0x00ffffff
      );
      const copyFilter = copyState.copyFilter;
      if (copyFilter === null || copyFilter === undefined || copyFilter.length !== 2) {
        throw new RangeError(
          "GX frame packet frame.copyState.copyFilter must have two registers"
        );
      }
      const copyFilter0 = gxFramePacketInteger(
        copyFilter[0],
        "frame.copyState.copyFilter[0]",
        0x00ffffff
      );
      const copyFilter1 = gxFramePacketInteger(
        copyFilter[1],
        "frame.copyState.copyFilter[1]",
        0x00ffffff
      );
      if (frame.clear !== ((copyCommand & 0x0800) !== 0)) {
        throw new Error("GX frame packet clear flag conflicts with copy command");
      }
      if ((copyKind === 2) !== ((copyCommand & 0x4000) !== 0)) {
        throw new Error("GX frame packet copyKind conflicts with copy command");
      }

      const packet = new ArrayBuffer(packetBytes);
      const bytes = new Uint8Array(packet);
      const header = new DataView(packet);
      bytes.set([0x4c, 0x5a, 0x47, 0x58], 0x00);
      header.setUint16(0x04, 4, true);
      header.setUint16(0x06, 160, true);
      header.setUint32(0x08, packetBytes, true);
      header.setUint32(0x0c, 0, true);
      header.setUint32(0x10, copyKind, true);
      header.setUint32(0x14, drawCount, true);
      header.setUint32(0x18, textureCount, true);
      header.setUint32(0x1c, drawTableOffset, true);
      header.setUint32(0x20, textureTableOffset, true);
      header.setUint32(0x24, tevOffset, true);
      header.setUint32(0x28, vertexOffset, true);
      header.setUint32(0x2c, keyOffset, true);
      header.setUint32(0x30, pixelOffset, true);
      header.setUint32(0x34, drawTableBytes, true);
      header.setUint32(0x38, textureTableBytes, true);
      header.setUint32(0x3c, tevBytes, true);
      header.setUint32(0x40, vertexBytes, true);
      header.setUint32(0x44, keyBytes, true);
      header.setUint32(0x48, pixelBytes, true);
      header.setUint32(0x4c, sourceX, true);
      header.setUint32(0x50, sourceY, true);
      header.setUint32(0x54, sourceWidth, true);
      header.setUint32(0x58, sourceHeight, true);
      header.setUint32(0x5c, outputWidth, true);
      header.setUint32(0x60, outputHeight, true);
      header.setUint32(0x64, destination, true);
      header.setUint32(0x68, stride, true);
      header.setUint32(0x6c, generation, true);
      header.setUint32(0x70, frame.clear ? 1 : 0, true);
      bytes.set(rgba, 0x74);
      header.setUint16(0x78, 176, true);
      header.setUint16(0x7a, 64, true);
      header.setUint32(0x7c, totalVertexCount, true);
      header.setUint32(0x80, terminalZMode, true);
      header.setUint32(0x84, terminalBlendMode, true);
      header.setUint32(0x88, pixelControl, true);
      header.setUint32(0x8c, copyCommand, true);
      header.setUint32(0x90, clearDepth, true);
      header.setUint32(0x94, copyScale, true);
      header.setUint32(0x98, copyFilter0, true);
      header.setUint32(0x9c, copyFilter1, true);

      for (let drawIndex = 0; drawIndex < drawCount; drawIndex += 1) {
        const draw = normalizedDraws[drawIndex];
        const recordOffset = drawTableOffset + drawIndex * 176;
        bytes[recordOffset] = draw.topology;
        bytes[recordOffset + 1] = draw.cullMode;
        header.setUint16(
          recordOffset + 0x02,
          draw.postCullEvidence === null ? 0 : 1,
          true
        );
        header.setUint32(recordOffset + 0x04, draw.vertexCount, true);
        header.setUint32(recordOffset + 0x08, draw.vertexRelativeOffset, true);
        header.setUint32(recordOffset + 0x0c, drawIndex * 464, true);
        header.setUint32(recordOffset + 0x10, draw.zMode, true);
        header.setUint32(recordOffset + 0x14, draw.blendMode, true);
        header.setUint32(recordOffset + 0x18, draw.alphaTest, true);
        header.setUint32(recordOffset + 0x1c, draw.scissorX, true);
        header.setUint32(recordOffset + 0x20, draw.scissorY, true);
        header.setUint32(recordOffset + 0x24, draw.scissorWidth, true);
        header.setUint32(recordOffset + 0x28, draw.scissorHeight, true);
        header.setUint32(recordOffset + 0x2c, 0, true);
        for (let slot = 0; slot < 8; slot += 1) {
          const reference = draw.textureReferences[slot];
          const referenceOffset = recordOffset + 0x30 + slot * 8;
          header.setUint32(referenceOffset, reference.index, true);
          header.setUint32(referenceOffset + 4, reference.sampler, true);
        }
        header.setUint32(recordOffset + 0x70, draw.pixelControl, true);
        header.setUint32(recordOffset + 0x74, draw.constantAlpha, true);
        header.setUint32(recordOffset + 0x78, draw.zTextureBias, true);
        header.setUint32(recordOffset + 0x7c, draw.zTextureMode, true);
        header.setUint32(recordOffset + 0x80, draw.fogRangeBase, true);
        for (let index = 0; index < 5; index += 1) {
          header.setUint32(
            recordOffset + 0x84 + index * 4,
            draw.fogRangeK[index],
            true
          );
          header.setUint32(
            recordOffset + 0x98 + index * 4,
            draw.fogWords[index],
            true
          );
        }
        header.setUint32(
          recordOffset + 0xac,
          draw.viewportHalfWidthBits,
          true
        );
        bytes.set(draw.tevState, tevOffset + drawIndex * 464);
        const drawVertexOffset = vertexOffset + draw.vertexRelativeOffset;
        for (let component = 0; component < draw.vertexValues.length; component += 1) {
          const value = draw.vertexValues[component];
          if (Number.isNaN(value)) {
            header.setUint32(drawVertexOffset + component * 4, 0x7fc00000, true);
          } else {
            header.setFloat32(drawVertexOffset + component * 4, value, true);
          }
        }
      }

      for (let textureIndex = 0; textureIndex < textureCount; textureIndex += 1) {
        const texture = textures[textureIndex];
        const recordOffset = textureTableOffset + textureIndex * 64;
        header.setUint32(recordOffset + 0x00, texture.keyRelativeOffset, true);
        header.setUint32(recordOffset + 0x04, texture.encodedKey.byteLength, true);
        header.setUint32(recordOffset + 0x08, texture.pixelRelativeOffset, true);
        header.setUint32(recordOffset + 0x0c, texture.pixels.byteLength, true);
        header.setUint32(recordOffset + 0x10, texture.address, true);
        header.setUint32(recordOffset + 0x14, texture.generation, true);
        header.setUint32(recordOffset + 0x18, texture.width, true);
        header.setUint32(recordOffset + 0x1c, texture.height, true);
        header.setUint32(
          recordOffset + 0x20,
          texture.pixels.byteLength === 0 ? 0 : 1,
          true
        );
        bytes.set(texture.encodedKey, keyOffset + texture.keyRelativeOffset);
        bytes.set(texture.pixels, pixelOffset + texture.pixelRelativeOffset);
      }
      for (const draw of normalizedDraws) {
        if (draw.postCullEvidence === null) continue;
        bytes.set(
          draw.postCullEvidence,
          evidenceOffset + draw.evidenceRelativeOffset
        );
      }
      return packet;
    }

    function gxFramePacketExactClipInput(
      value,
      topology,
      vertexCount,
      cullMode,
      viewportHalfWidthBits,
      name
    ) {
      if (value === undefined || value === null) return null;
      if (typeof value !== "object") {
        throw new TypeError(
          `GX frame packet ${name}.exactClipInput must be an object`
        );
      }
      if (
        topology > 4
        || gxSourceTriangleCount(topology, vertexCount) === 0
      ) {
        throw new Error(
          `GX frame packet ${name}.exactClipInput requires a nonempty triangle topology`
        );
      }
      if (
        Object.prototype.toString.call(value.clipPositions)
        !== "[object Float32Array]"
      ) {
        throw new TypeError(
          `GX frame packet ${name}.exactClipInput.clipPositions must be a Float32Array`
        );
      }
      if (value.clipPositions.length !== vertexCount * 4) {
        throw new RangeError(
          `GX frame packet ${name}.exactClipInput.clipPositions must contain four f32 values per source vertex`
        );
      }
      const clipPositions = new Float32Array(value.clipPositions);
      if (!clipPositions.every(Number.isFinite)) {
        throw new RangeError(
          `GX frame packet ${name}.exactClipInput.clipPositions must be finite`
        );
      }
      if (
        Object.prototype.toString.call(value.viewport)
        !== "[object Float32Array]"
        || value.viewport.length !== 6
      ) {
        throw new TypeError(
          `GX frame packet ${name}.exactClipInput.viewport must be a six-f32 Float32Array`
        );
      }
      const viewport = new Float32Array(value.viewport);
      if (
        !viewport.every(Number.isFinite)
        || viewport[0] === 0
        || viewport[1] === 0
      ) {
        throw new RangeError(
          `GX frame packet ${name}.exactClipInput.viewport must be finite with nonzero X/Y scales`
        );
      }
      const scalarBits = new DataView(new ArrayBuffer(4));
      scalarBits.setFloat32(0, viewport[0], true);
      if (scalarBits.getUint32(0, true) !== viewportHalfWidthBits) {
        throw new Error(
          `GX frame packet ${name}.exactClipInput viewport X conflicts with the draw viewport`
        );
      }
      const bpGenMode = gxFramePacketInteger(
        value.bpGenMode,
        `${name}.exactClipInput.bpGenMode`,
        0x00ffffff
      );
      if (((bpGenMode >>> 14) & 3) !== cullMode) {
        throw new Error(
          `GX frame packet ${name}.exactClipInput BP0 cull mode conflicts with the draw`
        );
      }
      return {
        bpGenMode,
        bpScissorTopLeft: gxFramePacketInteger(
          value.bpScissorTopLeft,
          `${name}.exactClipInput.bpScissorTopLeft`,
          0x00ffffff
        ),
        bpScissorBottomRight: gxFramePacketInteger(
          value.bpScissorBottomRight,
          `${name}.exactClipInput.bpScissorBottomRight`,
          0x00ffffff
        ),
        bpScissorOffset: gxFramePacketInteger(
          value.bpScissorOffset,
          `${name}.exactClipInput.bpScissorOffset`,
          0x00ffffff
        ),
        xfClipDisable: gxFramePacketInteger(
          value.xfClipDisable,
          `${name}.exactClipInput.xfClipDisable`,
          7
        ),
        viewport,
        clipPositions,
      };
    }

    // LZGX v5 extends a complete, canonical v4 packet only when at least one
    // draw carries exact source clip inputs. The aligned v4 action prefix and
    // every native vertex remain unchanged for strict WebGPU-path preservation.
    function packGxFramePacketV5(copyKind, frame, residentTextureKeys = null) {
      const v4 = packGxFramePacketV4(copyKind, frame, residentTextureKeys);
      const exactInputs = [];
      let exactBytes = 0;
      let exactCount = 0;
      for (let drawIndex = 0; drawIndex < frame.geometry.draws.length; drawIndex += 1) {
        const draw = frame.geometry.draws[drawIndex];
        const name = `draws[${drawIndex}]`;
        const topology = gxFramePacketInteger(draw.topology, `${name}.topology`, 7);
        const vertexCount = draw.vertices.length / 36;
        const pipeline = draw.pipeline ?? {};
        const cullMode = gxFramePacketInteger(
          pipeline.cullMode ?? 0,
          `${name}.cullMode`,
          3
        );
        const viewportHalfWidthBits = gxFramePacketInteger(
          pipeline.viewportHalfWidthBits ?? 0,
          `${name}.viewportHalfWidthBits`
        );
        const exactInput = gxFramePacketExactClipInput(
          draw.exactClipInput,
          topology,
          vertexCount,
          cullMode,
          viewportHalfWidthBits,
          name
        );
        if (exactInput !== null) {
          if (draw.postCullEvidence !== undefined && draw.postCullEvidence !== null) {
            throw new Error(
              `GX frame packet ${name} cannot carry both post-cull and exact-clip evidence`
            );
          }
          if (!draw.vertices.every(Number.isFinite)) {
            throw new RangeError(
              `GX frame packet ${name}.exactClipInput requires finite source vertices`
            );
          }
          exactCount += 1;
          exactBytes = gxFramePacketAdd(
            exactBytes,
            gxFramePacketAdd(
              48,
              exactInput.clipPositions.byteLength,
              `${name} exact-clip chunk bytes`
            ),
            "exact-clip evidence bytes"
          );
        }
        exactInputs.push(exactInput);
      }
      if (exactCount === 0) return v4;

      const packetBytes = gxFramePacketAlign16(
        gxFramePacketAdd(v4.byteLength, exactBytes, "v5 packet bytes"),
        "v5 packetBytes"
      );
      const packet = new ArrayBuffer(packetBytes);
      const bytes = new Uint8Array(packet);
      bytes.set(new Uint8Array(v4));
      const view = new DataView(packet);
      view.setUint16(0x04, 5, true);
      view.setUint32(0x08, packetBytes, true);

      const drawTableOffset = view.getUint32(0x1c, true);
      const drawRecordBytes = view.getUint16(0x78, true);
      let exactOffset = v4.byteLength;
      for (let drawIndex = 0; drawIndex < exactInputs.length; drawIndex += 1) {
        const exactInput = exactInputs[drawIndex];
        if (exactInput === null) continue;
        const recordOffset = drawTableOffset + drawIndex * drawRecordBytes;
        const flags = view.getUint16(recordOffset + 0x02, true);
        if (flags !== 0) {
          throw new Error(
            `GX frame packet draws[${drawIndex}] exact-clip evidence requires zero legacy flags`
          );
        }
        view.setUint16(recordOffset + 0x02, 2, true);
        view.setUint32(exactOffset + 0x00, 1, true);
        view.setUint32(exactOffset + 0x04, exactInput.bpGenMode, true);
        view.setUint32(
          exactOffset + 0x08,
          exactInput.bpScissorTopLeft,
          true
        );
        view.setUint32(
          exactOffset + 0x0c,
          exactInput.bpScissorBottomRight,
          true
        );
        view.setUint32(
          exactOffset + 0x10,
          exactInput.bpScissorOffset,
          true
        );
        view.setUint32(exactOffset + 0x14, exactInput.xfClipDisable, true);
        for (let component = 0; component < 6; component += 1) {
          view.setFloat32(
            exactOffset + 0x18 + component * 4,
            exactInput.viewport[component],
            true
          );
        }
        for (
          let component = 0;
          component < exactInput.clipPositions.length;
          component += 1
        ) {
          view.setFloat32(
            exactOffset + 0x30 + component * 4,
            exactInput.clipPositions[component],
            true
          );
        }
        exactOffset += 48 + exactInput.clipPositions.byteLength;
      }
      if (exactOffset !== packetBytes) {
        throw new Error("GX frame packet v5 exact-clip layout is not canonical");
      }
      return packet;
    }

    // LZGX v6 is negotiated only when a producer marks at least one exact
    // source draw as required. Optional exact inputs remain canonical v5 and
    // frames without exact inputs remain byte-identical canonical v4.
    function packGxFramePacketV6(copyKind, frame, residentTextureKeys = null) {
      const packet = packGxFramePacketV5(
        copyKind,
        frame,
        residentTextureKeys
      );
      const requiredDraws = [];
      let requiredCount = 0;
      for (
        let drawIndex = 0;
        drawIndex < frame.geometry.draws.length;
        drawIndex += 1
      ) {
        const draw = frame.geometry.draws[drawIndex];
        const name = `draws[${drawIndex}]`;
        const hasRequired = "exactGeometryRequired" in draw;
        if (
          hasRequired
          && typeof draw.exactGeometryRequired !== "boolean"
        ) {
          throw new TypeError(
            `GX frame packet ${name}.exactGeometryRequired must be a boolean`
          );
        }
        const required = hasRequired && draw.exactGeometryRequired;
        if (required) {
          if (
            draw.postCullEvidence !== undefined
            && draw.postCullEvidence !== null
          ) {
            throw new Error(
              `GX frame packet ${name} required exact geometry cannot carry post-cull evidence`
            );
          }
          if (
            draw.exactClipInput === undefined
            || draw.exactClipInput === null
          ) {
            throw new Error(
              `GX frame packet ${name}.exactGeometryRequired requires exactClipInput`
            );
          }
          requiredCount += 1;
        }
        requiredDraws.push(required);
      }
      if (requiredCount === 0) return packet;

      const view = new DataView(packet);
      if (view.getUint16(0x04, true) !== 5) {
        throw new Error(
          "GX frame packet required exact geometry requires canonical LZGX v5"
        );
      }
      const drawTableOffset = view.getUint32(0x1c, true);
      const drawRecordBytes = view.getUint16(0x78, true);
      for (let drawIndex = 0; drawIndex < requiredDraws.length; drawIndex += 1) {
        if (!requiredDraws[drawIndex]) continue;
        const flagsOffset = drawTableOffset + drawIndex * drawRecordBytes + 0x02;
        if (view.getUint16(flagsOffset, true) !== 2) {
          throw new Error(
            `GX frame packet draws[${drawIndex}] required exact geometry needs exact-only flags`
          );
        }
        view.setUint16(flagsOffset, 6, true);
      }
      view.setUint16(0x04, 6, true);
      return packet;
    }

    function gxFramePacketMipLayout(width, height, mode0, mode1, name) {
      const mipMode = (mode0 >>> 5) & 3;
      if (mipMode === 3) {
        throw new Error(`GX frame packet ${name}.mode0 uses reserved mip mode 3`);
      }
      const theoreticalLevels =
        Math.floor(Math.log2(Math.max(width, height))) + 1;
      const requestedLevels = Math.ceil(((mode1 >>> 8) & 0xff) / 16) + 1;
      const levelCount = mipMode === 0
        ? 1
        : Math.min(theoreticalLevels, requestedLevels);
      let levelWidth = width;
      let levelHeight = height;
      let decodedBytes = 0;
      let baseBytes = 0;
      for (let level = 0; level < levelCount; level += 1) {
        const levelBytes = gxFramePacketMultiply(
          gxFramePacketMultiply(
            levelWidth,
            levelHeight,
            `${name} mip level ${level} pixel count`
          ),
          4,
          `${name} mip level ${level} pixel bytes`
        );
        if (level === 0) baseBytes = levelBytes;
        decodedBytes = gxFramePacketAdd(
          decodedBytes,
          levelBytes,
          `${name} decoded mip bytes`
        );
        levelWidth = Math.max(1, Math.floor(levelWidth / 2));
        levelHeight = Math.max(1, Math.floor(levelHeight / 2));
      }
      return { levelCount, baseBytes, decodedBytes };
    }

    function gxFramePacketMipTexture(texture, legacyMode0, name) {
      const mode0 = texture.mode0 === undefined
        ? legacyMode0
        : gxFramePacketInteger(texture.mode0, `${name}.mode0`);
      if ((mode0 & (~0x0039ffff >>> 0)) !== 0) {
        throw new Error(
          `GX frame packet ${name}.mode0 has noncanonical bits outside 0x0039ffff`
        );
      }
      const mode1 = texture.mode1 === undefined
        ? 0
        : gxFramePacketInteger(texture.mode1, `${name}.mode1`);
      if ((mode1 & (~0x0000ffff >>> 0)) !== 0) {
        throw new Error(
          `GX frame packet ${name}.mode1 has noncanonical bits outside 0x0000ffff`
        );
      }
      const width = gxFramePacketInteger(texture.width, `${name}.width`, 1024);
      const height = gxFramePacketInteger(texture.height, `${name}.height`, 1024);
      const layout = gxFramePacketMipLayout(width, height, mode0, mode1, name);
      if (
        layout.levelCount > 1
        && texture.levelCount === undefined
      ) {
        throw new Error(
          `GX frame packet ${name}.levelCount must declare the derived mip count`
        );
      }
      if (texture.levelCount !== undefined) {
        const declaredLevelCount = gxFramePacketInteger(
          texture.levelCount,
          `${name}.levelCount`,
          32
        );
        if (declaredLevelCount !== layout.levelCount) {
          throw new Error(
            `GX frame packet ${name}.levelCount ${declaredLevelCount}`
            + ` conflicts with derived count ${layout.levelCount}`
          );
        }
      }

      const basePixels = gxFramePacketBytes(
        texture.pixels === undefined ? new Uint8Array() : texture.pixels,
        `${name}.pixels`
      );
      if (
        basePixels.byteLength !== 0
        && basePixels.byteLength !== layout.baseBytes
      ) {
        throw new RangeError(
          `GX frame packet ${name}.pixels must be empty or contain`
          + ` ${layout.baseBytes} level-0 bytes`
        );
      }
      let mipPixels;
      if (texture.mipPixels === undefined) {
        if (layout.levelCount > 1) {
          throw new TypeError(
            `GX frame packet ${name}.mipPixels is required for a mip chain`
          );
        }
        mipPixels = basePixels;
      } else {
        mipPixels = gxFramePacketBytes(texture.mipPixels, `${name}.mipPixels`);
        if (mipPixels.byteLength !== layout.decodedBytes) {
          throw new RangeError(
            `GX frame packet ${name}.mipPixels must contain`
            + ` ${layout.decodedBytes} decoded mip bytes`
          );
        }
        if (
          basePixels.byteLength !== 0
          && !gxFramePacketEqualBytes(
            basePixels,
            mipPixels.subarray(0, layout.baseBytes)
          )
        ) {
          throw new Error(
            `GX frame packet ${name}.pixels conflicts with the mipPixels prefix`
          );
        }
      }
      if (
        mipPixels.byteLength !== 0
        && mipPixels.byteLength !== layout.decodedBytes
      ) {
        throw new RangeError(
          `GX frame packet ${name} decoded payload must contain`
          + ` ${layout.decodedBytes} bytes`
        );
      }
      return {
        mode0,
        mode1,
        levelCount: layout.levelCount,
        decodedBytes: layout.decodedBytes,
        mipPixels,
      };
    }

    function gxFramePacketEqualMipTexture(left, right) {
      return (
        left.levelCount === right.levelCount
        && left.decodedBytes === right.decodedBytes
        && gxFramePacketEqualBytes(left.mipPixels, right.mipPixels)
      );
    }

    // LZGX v7 extends the canonical v4-v6 packet only for a referenced,
    // derived mip chain. Texture records retain their 64-byte ABI while +0x24
    // declares the level count, payloads contain tightly packed decoded
    // levels, draw sampler words carry full canonical MODE0, and an aligned
    // 32-byte-per-draw tail carries MODE1 after all exact-clip chunks.
    function packGxFramePacketV7(copyKind, frame, residentTextureKeys = null) {
      const legacy = packGxFramePacketV6(
        copyKind,
        frame,
        residentTextureKeys
      );
      const legacyBytes = new Uint8Array(legacy);
      const legacyView = new DataView(legacy);
      const drawCount = legacyView.getUint32(0x14, true);
      const textureCount = legacyView.getUint32(0x18, true);
      const drawTableOffset = legacyView.getUint32(0x1c, true);
      const textureTableOffset = legacyView.getUint32(0x20, true);
      const pixelOffset = legacyView.getUint32(0x30, true);
      const legacyPixelBytes = legacyView.getUint32(0x48, true);
      const drawRecordBytes = legacyView.getUint16(0x78, true);
      const textureRecordBytes = legacyView.getUint16(0x7a, true);
      if (
        legacyView.getUint16(0x06, true) !== 160
        || drawRecordBytes !== 176
        || textureRecordBytes !== 64
      ) {
        throw new Error("GX frame packet v7 requires the fixed legacy record ABI");
      }

      const textures = new Array(textureCount);
      const drawMode0 = Array.from(
        { length: drawCount },
        () => new Uint32Array(8)
      );
      const drawMode1 = Array.from(
        { length: drawCount },
        () => new Uint32Array(8)
      );
      let evidenceBytes = 0;
      let hasMipChain = false;
      for (let drawIndex = 0; drawIndex < drawCount; drawIndex += 1) {
        const draw = frame.geometry.draws[drawIndex];
        const drawTextures = draw.textures ?? [];
        const recordOffset = drawTableOffset + drawIndex * drawRecordBytes;
        const flags = legacyView.getUint16(recordOffset + 0x02, true);
        if (flags !== 0 && flags !== 1 && flags !== 2 && flags !== 6) {
          throw new Error(
            `GX frame packet draws[${drawIndex}] has unsupported v7 flags ${flags}`
          );
        }
        if (flags === 1) {
          const topology = legacyBytes[recordOffset];
          const vertexCount = legacyView.getUint32(recordOffset + 0x04, true);
          evidenceBytes = gxFramePacketAdd(
            evidenceBytes,
            Math.ceil(gxSourceTriangleCount(topology, vertexCount) / 4),
            "v7 post-cull evidence bytes"
          );
        }
        for (let textureMap = 0; textureMap < 8; textureMap += 1) {
          const referenceOffset = recordOffset + 0x30 + textureMap * 8;
          const textureIndex = legacyView.getUint32(referenceOffset, true);
          const legacyMode0 = legacyView.getUint32(referenceOffset + 4, true);
          if (textureIndex === 0xffffffff) {
            if (legacyMode0 !== 0) {
              throw new Error(
                `GX frame packet draws[${drawIndex}] unused texture map`
                + ` ${textureMap} must have zero MODE0`
              );
            }
            continue;
          }
          if (textureIndex >= textureCount) {
            throw new RangeError(
              `GX frame packet draws[${drawIndex}] texture map ${textureMap}`
              + " has an out-of-range texture index"
            );
          }
          const texture = drawTextures[textureMap];
          const name = `draws[${drawIndex}].textures[${textureMap}]`;
          if (texture === null || typeof texture !== "object") {
            throw new TypeError(`GX frame packet ${name} must be an object`);
          }
          const normalized = gxFramePacketMipTexture(texture, legacyMode0, name);
          drawMode0[drawIndex][textureMap] = normalized.mode0;
          drawMode1[drawIndex][textureMap] = normalized.mode1;
          hasMipChain ||= normalized.levelCount > 1;
          if (textures[textureIndex] === undefined) {
            const key = texture.renderKey ?? texture.key;
            textures[textureIndex] = { ...normalized, key };
          } else if (
            !gxFramePacketEqualMipTexture(textures[textureIndex], normalized)
          ) {
            const key = texture.renderKey ?? texture.key;
            throw new Error(
              `GX frame packet texture key ${JSON.stringify(key)}`
              + " has conflicting mip contents"
            );
          }
        }
      }
      if (!hasMipChain) return legacy;
      if (textures.includes(undefined)) {
        throw new Error("GX frame packet v7 texture table has an unreferenced entry");
      }

      let pixelBytes = 0;
      for (let textureIndex = 0; textureIndex < textureCount; textureIndex += 1) {
        const texture = textures[textureIndex];
        const resident = residentTextureKeys?.has(texture.key) ?? false;
        if (!resident && texture.mipPixels.byteLength !== texture.decodedBytes) {
          throw new RangeError(
            `GX frame packet texture ${textureIndex} has an incomplete mip payload`
          );
        }
        texture.pixels = resident ? new Uint8Array() : texture.mipPixels;
        texture.pixelRelativeOffset = texture.pixels.byteLength === 0
          ? 0
          : gxFramePacketAlign16(pixelBytes, "v7 texture pixel relative offset");
        if (texture.pixels.byteLength !== 0) {
          pixelBytes = gxFramePacketAdd(
            texture.pixelRelativeOffset,
            texture.pixels.byteLength,
            "v7 pixel bytes"
          );
        }
      }
      pixelBytes = gxFramePacketAlign16(pixelBytes, "v7 pixelBytes");

      const legacyEvidenceOffset = gxFramePacketAdd(
        pixelOffset,
        legacyPixelBytes,
        "legacy evidence offset"
      );
      const legacyExactOffset = gxFramePacketAlign16(
        gxFramePacketAdd(
          legacyEvidenceOffset,
          evidenceBytes,
          "legacy exact-clip offset"
        ),
        "legacy exact-clip offset"
      );
      if (legacyExactOffset > legacy.byteLength) {
        throw new Error("GX frame packet legacy evidence layout is not canonical");
      }
      const exactBytes = legacy.byteLength - legacyExactOffset;
      const evidenceOffset = gxFramePacketAdd(
        pixelOffset,
        pixelBytes,
        "v7 evidence offset"
      );
      const exactOffset = gxFramePacketAlign16(
        gxFramePacketAdd(evidenceOffset, evidenceBytes, "v7 exact-clip offset"),
        "v7 exact-clip offset"
      );
      const mode1Offset = gxFramePacketAdd(
        exactOffset,
        exactBytes,
        "v7 MODE1 offset"
      );
      const mode1Bytes = gxFramePacketMultiply(
        drawCount,
        32,
        "v7 MODE1 bytes"
      );
      const packetBytes = gxFramePacketAdd(
        mode1Offset,
        mode1Bytes,
        "v7 packet bytes"
      );
      const packet = new ArrayBuffer(packetBytes);
      const bytes = new Uint8Array(packet);
      const view = new DataView(packet);
      bytes.set(legacyBytes.subarray(0, pixelOffset));
      bytes.set(
        legacyBytes.subarray(
          legacyEvidenceOffset,
          legacyEvidenceOffset + evidenceBytes
        ),
        evidenceOffset
      );
      bytes.set(legacyBytes.subarray(legacyExactOffset), exactOffset);

      view.setUint16(0x04, 7, true);
      view.setUint32(0x08, packetBytes, true);
      view.setUint32(0x48, pixelBytes, true);
      for (let drawIndex = 0; drawIndex < drawCount; drawIndex += 1) {
        const recordOffset = drawTableOffset + drawIndex * drawRecordBytes;
        for (let textureMap = 0; textureMap < 8; textureMap += 1) {
          view.setUint32(
            recordOffset + 0x34 + textureMap * 8,
            drawMode0[drawIndex][textureMap],
            true
          );
          view.setUint32(
            mode1Offset + drawIndex * 32 + textureMap * 4,
            drawMode1[drawIndex][textureMap],
            true
          );
        }
      }
      for (let textureIndex = 0; textureIndex < textureCount; textureIndex += 1) {
        const texture = textures[textureIndex];
        const recordOffset =
          textureTableOffset + textureIndex * textureRecordBytes;
        view.setUint32(recordOffset + 0x08, texture.pixelRelativeOffset, true);
        view.setUint32(recordOffset + 0x0c, texture.pixels.byteLength, true);
        view.setUint32(
          recordOffset + 0x20,
          texture.pixels.byteLength === 0 ? 0 : 1,
          true
        );
        view.setUint32(recordOffset + 0x24, texture.levelCount, true);
        bytes.set(texture.pixels, pixelOffset + texture.pixelRelativeOffset);
      }
      return packet;
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
      const viFrame = rendererViFrames.get(rendererSequence) ?? null;
      rendererViFrames.delete(rendererSequence);
      const sustainedRequest = smbSustainedViPending.get(rendererSequence) ?? null;
      smbSustainedViPending.delete(rendererSequence);
      if (message.type === "renderer-frame-failed") {
        rendererFrameFailures += 1;
        recordRendererFailure(message.error);
        if (sustainedRequest !== null) {
          failSmbSustainedViReceipt(
            null,
            `$.sustainedPlay.receipts[${sustainedRequest.ordinal - 1}].renderer`,
            sustainedRequest.ordinal,
            "a drained successful WebGPU presentation",
            String(message.error ?? "renderer frame failed"),
            smbSustainedViReceipts.at(-1)?.rendererSequence ?? null
          );
        }
      } else {
        if (viFrame !== null) {
          if (!acceptViPresentationResult(
            message.viPresentationResult,
            viFrame,
            rendererSequence
          )) return;
        } else if (message.viPresentationResult !== undefined) {
          rendererFrameFailures += 1;
          recordRendererFailure("non-VI renderer frame returned a VI result");
          return;
        }
        if (message.residentTextureKeys !== undefined) {
          if (
            !Array.isArray(message.residentTextureKeys)
            || message.residentTextureKeys.some(key => typeof key !== "string")
          ) {
            rendererFrameFailures += 1;
            recordRendererFailure("WebGPU renderer returned invalid texture residency");
            return;
          }
          rendererResidentTextureKeys = new Set(message.residentTextureKeys);
        }
        rendererFramesAcknowledged += 1;
        if (
          sustainedRequest !== null
          || message.sustainedPlayReceipt !== undefined
        ) {
          acceptSmbSustainedViReceipt(
            message.sustainedPlayReceipt,
            sustainedRequest,
            rendererSequence
          );
        }
        if (rendererFramesInFlight.size === 0) rendererBackpressureResume?.();
      }
    }

    function acceptViPresentationResult(result, frame, rendererSequence) {
      const valid = result !== null
        && typeof result === "object"
        && !Array.isArray(result)
        && typeof result.accepted === "boolean"
        && typeof result.presented === "boolean"
        && typeof result.status === "string"
        && result.status.length !== 0
        && Number.isSafeInteger(result.pairEpoch)
        && result.pairEpoch === frame.pairEpoch
        && result.pairEpoch >= 1
        && result.pairEpoch <= 0xffff_ffff
        && (
          result.presentationSerial === null
          || (
            result.presented === true
            && Number.isSafeInteger(result.presentationSerial)
            && result.presentationSerial >= 1
          )
        )
        && !(result.presented && !result.accepted)
        && (
          !result.accepted
          || result.presented === frame.pairCompleting
        );
      if (!valid) {
        rendererFrameFailures += 1;
        recordRendererFailure("WebGPU renderer returned invalid VI pairing state");
        return false;
      }
      viLastResultStatus = result.status;
      viLastResultPairEpoch = result.pairEpoch;
      viResultCounts.set(result.status, (viResultCounts.get(result.status) ?? 0) + 1);
      if (result.presented) {
        viHostPresentationCount += 1;
        viLastHostPresentationCycle = frame.scheduledCycle;
        viLastHostPresentationField = frame.field;
        viLastHostPresentationAddress = frame.address;
        viLastHostPresentationCopyIndex = frame.copyIndex;
        viLastHostPresentationCopyRow = frame.copyRow;
        viLastHostPresentationPairEpoch = result.pairEpoch;
        viLastHostPresentationSerial = result.presentationSerial;
        deviceEvents.set(
          "viHostPresent",
          (deviceEvents.get("viHostPresent") ?? 0) + 1
        );
      } else if (result.accepted) {
        viFieldStagedCount += 1;
        if (result.status === "vi-field-pair-superseded") {
          viFieldSupersededCount += 1;
          deviceEvents.set(
            "viPairSuperseded",
            (deviceEvents.get("viPairSuperseded") ?? 0) + 1
          );
        }
        deviceEvents.set(
          "viFieldStaged",
          (deviceEvents.get("viFieldStaged") ?? 0) + 1
        );
      } else {
        viFieldRejectedCount += 1;
        if (viPendingFieldPair?.pairEpoch === result.pairEpoch) {
          viPendingFieldPair = null;
        }
        deviceEvents.set(
          "viFieldRejected",
          (deviceEvents.get("viFieldRejected") ?? 0) + 1
        );
      }
      traceVi("field-result", cycles, {
        rendererSequence,
        field: frame.field,
        pairEpoch: result.pairEpoch,
        accepted: result.accepted,
        presented: result.presented,
        status: result.status,
        presentationSerial: result.presentationSerial,
      });
      return true;
    }

    function recordRendererFailure(error) {
      if (rendererFailure === null) {
        rendererFailure = String(error || "WebGPU renderer failed");
      }
      rendererBackpressureResume?.();
    }

    function describeSmbSustainedViValue(value) {
      if (value === undefined) return "undefined";
      try {
        return JSON.stringify(value);
      } catch (_error) {
        return String(value);
      }
    }

    function failSmbSustainedViReceipt(
      receipt,
      path,
      ordinal,
      expected,
      actual,
      previous = null
    ) {
      if (smbSustainedViFailure !== null) return false;
      if (receipt !== null && typeof receipt === "object") {
        smbSustainedViReceipts.push(receipt);
      }
      const failure = {
        path,
        ordinal: Number.isSafeInteger(ordinal) ? ordinal : null,
        expected,
        actual,
        previous,
        reason: `sustained PLAY receipt ${Number.isSafeInteger(ordinal) ? ordinal : "?"} `
          + `at ${path}: expected ${describeSmbSustainedViValue(expected)}, `
          + `got ${describeSmbSustainedViValue(actual)} `
          + `(previous ${describeSmbSustainedViValue(previous)})`,
      };
      smbSustainedViFailure = failure;
      if (
        controllerScenario?.id === "smb-sustained-play"
        && controllerScenario.status === "running"
      ) {
        const step = controllerScenario.definition.steps[controllerScenario.stepIndex] ?? null;
        controllerScenario.status = "failed";
        controllerScenario.failure = {
          step: step?.id ?? null,
          cycle: cycles,
          pollIndex: controllerScenario.pollIndex,
          ...failure,
        };
        controllerScenario.pulse = null;
      }
      return false;
    }

    function acceptSmbSustainedViReceipt(receipt, request, rendererSequence) {
      const ordinal = Number(receipt?.ordinal ?? request?.ordinal);
      const path = `$.sustainedPlay.receipts[${Math.max(0, (ordinal || 1) - 1)}]`;
      const reject = (suffix, expected, actual, previous = null) =>
        failSmbSustainedViReceipt(
          receipt ?? null,
          `${path}${suffix}`,
          ordinal,
          expected,
          actual,
          previous
        );
      if (request === null) return reject(".request", "a pending worker request", null);
      if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
        return reject("", "a drained VI receipt object", receipt);
      }
      if (receipt.scenario !== request.scenario) {
        return reject(".scenario", request.scenario, receipt.scenario);
      }
      if (receipt.step !== request.step) {
        return reject(".step", request.step, receipt.step);
      }
      const expectedOrdinal = smbSustainedViReceipts.length + 1;
      if (ordinal !== expectedOrdinal || ordinal !== request.ordinal) {
        return reject(".ordinal", expectedOrdinal, receipt.ordinal);
      }
      if (receipt.capacity !== smbSustainedViReceiptCapacity) {
        return reject(".capacity", smbSustainedViReceiptCapacity, receipt.capacity);
      }
      if (receipt.rendererSequence !== rendererSequence) {
        return reject(".rendererSequence", rendererSequence, receipt.rendererSequence);
      }
      if (receipt.drained !== true) return reject(".drained", true, receipt.drained);
      if (receipt.accepted !== true) return reject(".accepted", true, receipt.accepted);

      const presentation = receipt.presentation;
      if (
        presentation === null
        || typeof presentation !== "object"
        || Array.isArray(presentation)
      ) return reject(".presentation", "an object", presentation);
      if (presentation.mode !== "interlaced") {
        return reject(".presentation.mode", "interlaced", presentation.mode);
      }
      const pairCompleting = presentation.pairCompleting;
      if (typeof pairCompleting !== "boolean") {
        return reject(
          ".presentation.pairCompleting",
          "a boolean",
          pairCompleting
        );
      }
      const expectedPresented = pairCompleting;
      if (receipt.presented !== expectedPresented) {
        return reject(".presented", expectedPresented, receipt.presented);
      }
      const expectedStatus = pairCompleting
        ? "vi-interlaced-frame-ready"
        : "vi-field-pair-awaiting";
      if (receipt.status !== expectedStatus) {
        return reject(".status", expectedStatus, receipt.status);
      }
      if (
        !Number.isSafeInteger(receipt.pairEpoch)
        || receipt.pairEpoch < 1
        || receipt.pairEpoch > 0xffff_ffff
      ) {
        return reject(".pairEpoch", "a positive u32", receipt.pairEpoch);
      }
      if (pairCompleting) {
        if (
          !Number.isSafeInteger(receipt.presentationSerial)
          || receipt.presentationSerial < 1
        ) {
          return reject(
            ".presentationSerial",
            "a positive safe integer",
            receipt.presentationSerial
          );
        }
      } else if (receipt.presentationSerial !== null) {
        return reject(".presentationSerial", null, receipt.presentationSerial);
      }
      const previousReceipt = smbSustainedViReceipts.at(-1) ?? null;
      if (previousReceipt === null && pairCompleting) {
        return reject(".presentation.pairCompleting", false, pairCompleting);
      }
      if (previousReceipt !== null) {
        if (pairCompleting === previousReceipt.presentation.pairCompleting) {
          return reject(
            ".presentation.pairCompleting",
            !previousReceipt.presentation.pairCompleting,
            pairCompleting,
            previousReceipt.presentation.pairCompleting
          );
        }
        const expectedPairEpoch = pairCompleting
          ? previousReceipt.pairEpoch
          : previousReceipt.pairEpoch + 1;
        if (receipt.pairEpoch !== expectedPairEpoch) {
          return reject(
            ".pairEpoch",
            expectedPairEpoch,
            receipt.pairEpoch,
            previousReceipt.pairEpoch
          );
        }
        if (
          pairCompleting
          && previousReceipt.presentationSerial !== null
        ) {
          return reject(
            ".presentationSerial",
            "the first serial in its pair",
            receipt.presentationSerial,
            previousReceipt.presentationSerial
          );
        }
        const previousPresented = smbSustainedViReceipts
          .filter(candidate => candidate.presented)
          .at(-1);
        if (
          pairCompleting
          && previousPresented !== undefined
          && receipt.presentationSerial <= previousPresented.presentationSerial
        ) {
          return reject(
            ".presentationSerial",
            `a value greater than ${previousPresented.presentationSerial}`,
            receipt.presentationSerial,
            previousPresented.presentationSerial
          );
        }
      }
      const previousField = smbSustainedViReceipts.at(-1)?.presentation?.field ?? null;
      const expectedField = previousField === null
        ? presentation.field
        : previousField === "top" ? "bottom" : "top";
      if (
        (presentation.field !== "top" && presentation.field !== "bottom")
        || presentation.field !== expectedField
      ) {
        return reject(
          ".presentation.field",
          previousField === null ? "top or bottom" : expectedField,
          presentation.field,
          previousField
        );
      }
      const expectedRow = expectedField === "top" ? 0 : 1;
      if (presentation.copyRow !== expectedRow) {
        return reject(".presentation.copyRow", expectedRow, presentation.copyRow,
          smbSustainedViReceipts.at(-1)?.presentation?.copyRow ?? null);
      }
      if (presentation.width !== 640) {
        return reject(".presentation.width", 640, presentation.width,
          smbSustainedViReceipts.at(-1)?.presentation?.width ?? null);
      }
      if (presentation.height !== 448) {
        return reject(".presentation.height", 448, presentation.height,
          smbSustainedViReceipts.at(-1)?.presentation?.height ?? null);
      }
      if (typeof presentation.address !== "string" || !/^0x[0-9a-f]{8}$/.test(
        presentation.address
      )) {
        return reject(
          ".presentation.address",
          "a lowercase 32-bit hexadecimal address",
          presentation.address
        );
      }
      const sameParity = smbSustainedViReceipts.find(candidate =>
        candidate.presentation.field === expectedField);
      if (
        sameParity !== undefined
        && presentation.address !== sameParity.presentation.address
      ) {
        return reject(
          ".presentation.address",
          sameParity.presentation.address,
          presentation.address,
          sameParity.presentation.address
        );
      }
      const oppositeParity = smbSustainedViReceipts.find(candidate =>
        candidate.presentation.field !== expectedField);
      if (
        sameParity === undefined
        && oppositeParity !== undefined
        && presentation.address === oppositeParity.presentation.address
      ) {
        return reject(
          ".presentation.address",
          `an address distinct from ${oppositeParity.presentation.address}`,
          presentation.address,
          oppositeParity.presentation.address
        );
      }
      if (
        !Number.isSafeInteger(presentation.copyIndex)
        || presentation.copyIndex < 1
      ) {
        return reject(".presentation.copyIndex", "a positive safe integer",
          presentation.copyIndex);
      }
      const previousCopyIndex = previousReceipt?.presentation?.copyIndex ?? null;
      if (
        previousCopyIndex !== null
        && presentation.copyIndex <= previousCopyIndex
      ) {
        return reject(
          ".presentation.copyIndex",
          `a value greater than ${previousCopyIndex}`,
          presentation.copyIndex,
          previousCopyIndex
        );
      }

      const gameplay = receipt.gameplay;
      if (gameplay === null || typeof gameplay !== "object" || Array.isArray(gameplay)) {
        return reject(".gameplay", "an object", gameplay);
      }
      for (const [field, expected] of [
        ["gameModeRequest", -1],
        ["gameMode", 2],
        ["gameSubmodeRequest", -1],
        ["gameSubmode", 51],
        ["attempts", 1],
        ["floor", 1],
      ]) {
        if (gameplay[field] !== expected) {
          return reject(`.gameplay.${field}`, expected, gameplay[field],
            previousReceipt?.gameplay?.[field] ?? null);
        }
      }
      if (!Number.isSafeInteger(gameplay.infoTimer)) {
        return reject(".gameplay.infoTimer", "a safe integer", gameplay.infoTimer,
          previousReceipt?.gameplay?.infoTimer ?? null);
      }
      if (
        previousReceipt !== null
        && gameplay.infoTimer !== previousReceipt.gameplay.infoTimer - 1
      ) {
        return reject(
          ".gameplay.infoTimer",
          previousReceipt.gameplay.infoTimer - 1,
          gameplay.infoTimer,
          previousReceipt.gameplay.infoTimer
        );
      }
      if (rendererFailure !== null) {
        return reject(".renderer.failure", null, rendererFailure);
      }
      if (rendererFramesInFlight.size !== 0) {
        return reject(".renderer.inFlight", 0, rendererFramesInFlight.size);
      }
      smbSustainedViReceipts.push(receipt);
      return true;
    }

    function controllerPacketForPoll(
      channel = 0,
      scheduledCycle = cycles,
      observedCycle = scheduledCycle,
      source = "periodic"
    ) {
      const queued = controllerQueue.shift();
      if (queued !== undefined) {
        controllerState = queued.state;
        controllerAppliedSequence = queued.sequence;
      }
      controllerPollIndex += 1;
      const scenarioButtons = pollControllerScenario(
        controllerScenario,
        channel,
        controllerPollIndex,
        scheduledCycle,
        observedCycle,
        source
      );
      const scenarioOwnsInput = scenarioButtons !== null;
      serialLastPolledOrigin = scenarioOwnsInput ? "scenario" : "host";
      const rawButtons = (
        scenarioOwnsInput ? scenarioButtons : controllerState.buttons
      ) & 0xffff;
      const buttons = (rawButtons | padUseOrigin) & 0xffff;
      const stickX = scenarioOwnsInput ? 0x80 : controllerState.stickX & 0xff;
      const stickY = scenarioOwnsInput ? 0x80 : controllerState.stickY & 0xff;
      const cStickX = scenarioOwnsInput ? 0x80 : controllerState.cStickX & 0xff;
      const cStickY = scenarioOwnsInput ? 0x80 : controllerState.cStickY & 0xff;
      const triggerL = scenarioOwnsInput ? 0 : controllerState.triggerL & 0xff;
      const triggerR = scenarioOwnsInput ? 0 : controllerState.triggerR & 0xff;
      const analogA = (
        !scenarioOwnsInput
          ? controllerState.analogA ?? ((rawButtons & 0x0100) !== 0 ? 0xff : 0)
          : (rawButtons & 0x0100) !== 0 ? 0xff : 0
      ) & 0xff;
      const analogB = (
        !scenarioOwnsInput
          ? controllerState.analogB ?? ((rawButtons & 0x0200) !== 0 ? 0xff : 0)
          : (rawButtons & 0x0200) !== 0 ? 0xff : 0
      ) & 0xff;
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
        stickX,
        stickY,
        ...low,
      ];
    }

    function postControllerPollAcknowledgement(
      packet,
      source = "periodic",
      scheduledCycle = cycles,
      observedCycle = scheduledCycle
    ) {
      const buttons = ((packet[0] << 8) | packet[1]) & ~padUseOrigin;
      if (buttons !== 0) {
        if (serialLastPolledOrigin === "host") {
          serialLastActiveHostPublication = {
            source,
            pollIndex: controllerPollIndex,
            scheduledCycle,
            observedCycle,
            buttons,
            sequence: serialLastPolledSequence,
          };
        }
        globalThis.postMessage?.({
          type: "controller-poll",
          buttons,
          sequence: serialLastPolledSequence,
        });
      }
      return buttons;
    }

    const controllerScenarioDefinitions = new Map();

    function controllerScenarioInteger(value, name, minimum = 0) {
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new TypeError(`${name} must be a safe integer >= ${minimum}`);
      }
      return value;
    }

    function registerControllerScenario(definition) {
      if (definition === null || typeof definition !== "object") {
        throw new TypeError("controller scenario definition must be an object");
      }
      if (
        typeof definition.id !== "string"
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(definition.id)
      ) {
        throw new TypeError("controller scenario id must be lowercase kebab-case");
      }
      if (
        typeof definition.gameIdentifier !== "string"
        || definition.gameIdentifier.length === 0
      ) {
        throw new TypeError("controller scenario gameIdentifier must be nonempty");
      }
      controllerScenarioInteger(definition.hardCycleLimit, "hardCycleLimit", 1);
      if (definition.gameVersion !== undefined) {
        controllerScenarioInteger(definition.gameVersion, "gameVersion");
        if (definition.gameVersion > 0xff) {
          throw new RangeError("controller scenario gameVersion exceeds 8 bits");
        }
      }
      if (typeof definition.sample !== "function") {
        throw new TypeError("controller scenario sample must be a function");
      }
      if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
        throw new TypeError("controller scenario steps must be a nonempty array");
      }
      const ids = new Set();
      for (const step of definition.steps) {
        if (step === null || typeof step !== "object") {
          throw new TypeError("controller scenario step must be an object");
        }
        if (typeof step.id !== "string" || step.id.length === 0 || ids.has(step.id)) {
          throw new TypeError("controller scenario step ids must be unique and nonempty");
        }
        ids.add(step.id);
        if (typeof step.ready !== "function") {
          throw new TypeError(`controller scenario step ${step.id} needs a ready predicate`);
        }
        if (step.missed !== undefined && typeof step.missed !== "function") {
          throw new TypeError(`controller scenario step ${step.id} missed must be a function`);
        }
        if (step.input !== undefined) {
          if (
            step.input === null
            || typeof step.input !== "object"
            || Array.isArray(step.input)
            || step.input.owner !== "page"
          ) {
            throw new TypeError(
              `controller scenario step ${step.id} input must be page-owned`
            );
          }
          if (step.button !== undefined) {
            throw new TypeError(
              `controller scenario step ${step.id} cannot combine button and state input`
            );
          }
          const active = normalizeControllerState(step.input.active);
          const neutral = normalizeControllerState(step.input.neutral);
          if (step.input.activePolls !== undefined) {
            controllerScenarioInteger(
              step.input.activePolls,
              `controller scenario step ${step.id} activePolls`,
              1
            );
          }
          if (controllerStatesEqual(active, neutral)) {
            throw new TypeError(
              `controller scenario step ${step.id} active and neutral states must differ`
            );
          }
          const activeObserved = step.input.activeObserved;
          const neutralObserved = step.input.neutralObserved;
          if (
            (activeObserved === undefined) !== (neutralObserved === undefined)
            || (activeObserved !== undefined && typeof activeObserved !== "function")
            || (neutralObserved !== undefined && typeof neutralObserved !== "function")
          ) {
            throw new TypeError(
              `controller scenario step ${step.id} needs paired guest predicates`
            );
          }
        } else if (step.button !== null) {
          controllerScenarioInteger(
            step.button,
            `controller scenario step ${step.id} button`,
            1
          );
          if (step.button > 0xffff) {
            throw new RangeError(`controller scenario step ${step.id} button exceeds 16 bits`);
          }
        }
      }
      if (controllerScenarioDefinitions.has(definition.id)) {
        throw new Error(`duplicate controller scenario ${definition.id}`);
      }
      controllerScenarioDefinitions.set(definition.id, definition);
      return definition;
    }

    function createControllerScenario(definition, startCycle = 0) {
      controllerScenarioInteger(startCycle, "controller scenario startCycle");
      const pressPolls = controllerScenarioInteger(
        definition.pressPolls ?? 3,
        "controller scenario pressPolls",
        1
      );
      const minimumNeutralPolls = controllerScenarioInteger(
        definition.minimumNeutralPolls ?? 3,
        "controller scenario minimumNeutralPolls",
        1
      );
      const maximumNeutralPolls = controllerScenarioInteger(
        definition.maximumNeutralPolls ?? 120,
        "controller scenario maximumNeutralPolls",
        1
      );
      if (maximumNeutralPolls < minimumNeutralPolls) {
        throw new RangeError(
          "controller scenario maximumNeutralPolls must be >= minimumNeutralPolls"
        );
      }
      return {
        definition,
        id: definition.id,
        gameIdentifier: definition.gameIdentifier,
        hardCycleLimit: definition.hardCycleLimit,
        pressPolls,
        minimumNeutralPolls,
        maximumNeutralPolls,
        status: "running",
        startCycle,
        completedCycle: null,
        failure: null,
        stepIndex: 0,
        pollIndex: 0,
        nextSequence: 1,
        nextRequestSequence: 1,
        pulse: null,
        steps: [],
        lastState: null,
      };
    }

    function selectControllerScenario(
      name,
      gameIdentifier,
      startCycle = 0,
      gameVersion,
      optional = false
    ) {
      if (name === null || name === "") return null;
      const definition = controllerScenarioDefinitions.get(name);
      if (definition === undefined) throw new Error(`unsupported controller scenario ${name}`);
      if (definition.gameIdentifier !== gameIdentifier) {
        if (optional) return null;
        throw new Error(
          `controller scenario ${name} requires ${definition.gameIdentifier}, got ${gameIdentifier}`
        );
      }
      if (
        definition.gameVersion !== undefined
        && definition.gameVersion !== gameVersion
      ) {
        if (optional) return null;
        throw new Error(
          `controller scenario ${name} requires disc revision ${definition.gameVersion}, got ${gameVersion}`
        );
      }
      return createControllerScenario(definition, startCycle);
    }

    function controllerScenarioCycleLimit(limit, scenario) {
      if (scenario === null || !Number.isFinite(limit)) return limit;
      return Math.max(limit, scenario.hardCycleLimit);
    }

    function failControllerScenario(scenario, cycle, reason) {
      if (scenario === null || scenario.status !== "running") return;
      const step = scenario.definition.steps[scenario.stepIndex] ?? null;
      scenario.status = "failed";
      scenario.failure = {
        step: step?.id ?? null,
        cycle,
        pollIndex: scenario.pollIndex,
        reason: String(reason),
      };
      scenario.pulse = null;
    }

    function createControllerScenarioStateRecord(requestSequence, state) {
      return {
        requestSequence,
        state: normalizeControllerState(state),
        requestedCycle: null,
        requestedPollIndex: null,
        receivedCycle: null,
        sequence: null,
        polls: 0,
        publications: [],
        firstPollIndex: null,
        lastPollIndex: null,
        firstScheduledCycle: null,
        lastScheduledCycle: null,
        firstObservedCycle: null,
        lastObservedCycle: null,
      };
    }

    function requestControllerScenarioState(scenario, entry, phase, cycle) {
      const record = entry[phase];
      record.requestedCycle = cycle;
      record.requestedPollIndex = scenario.pollIndex;
      scenario.pulse.state = phase;
      scenario.pulse.requestSequence = record.requestSequence;
      globalThis.postMessage?.({
        type: "controller-scenario-input",
        scenario: scenario.id,
        step: entry.id,
        phase,
        requestSequence: record.requestSequence,
        state: record.state,
      });
    }

    function observeControllerScenarioPulse(scenario, cycle, sample) {
      const pulse = scenario.pulse;
      if (pulse === null) return;
      if (pulse.owner === "page") {
        const step = scenario.definition.steps[scenario.stepIndex];
        const entry = scenario.steps.at(-1);
        if (entry.guest === undefined) return;
        if (
          entry.active.polls !== 0
          && entry.guest.activeCycle === null
          && step.input.activeObserved(sample, scenario)
        ) {
          entry.guest.activeCycle = cycle;
          entry.guest.activePollIndex = scenario.pollIndex;
          entry.guest.activeState = scenario.lastState;
        }
        if (
          pulse.state !== "neutral"
          || entry.neutral.polls === 0
          || entry.guest.activeCycle === null
          || cycle <= entry.guest.activeCycle
          || entry.guest.neutralCycle !== null
          || !step.input.neutralObserved(sample, scenario)
        ) return;
        entry.guest.neutralCycle = cycle;
        entry.guest.neutralPollIndex = scenario.pollIndex;
        entry.guest.neutralState = scenario.lastState;
        return;
      }
      const pad = sample?.pad;
      if (pad === null || typeof pad !== "object") return;
      const held = Number(pad.held);
      const pressed = Number(pad.pressed);
      const released = Number(pad.released);
      if (
        !Number.isSafeInteger(held)
        || !Number.isSafeInteger(pressed)
        || !Number.isSafeInteger(released)
      ) return;
      const entry = scenario.steps.at(-1);
      if (
        entry.press.polls !== 0
        && entry.guest.pressedCycle === null
        && (pressed & pulse.button) !== 0
      ) {
        entry.guest.pressedCycle = cycle;
      }
      if (
        pulse.state !== "release"
        || entry.release.polls === 0
        || pulse.releaseServiceCycle === null
        || cycle <= pulse.releaseServiceCycle
      ) return;
      if (
        entry.guest.pressedCycle !== null
        && cycle > entry.guest.pressedCycle
        && entry.guest.releasedCycle === null
        && (released & pulse.button) !== 0
        && (held & pulse.button) === 0
        && (pressed & pulse.button) === 0
      ) {
        entry.guest.releasedCycle = cycle;
      }
      if (
        entry.guest.releasedCycle !== null
        && cycle > entry.guest.releasedCycle
        && entry.guest.neutralCycle === null
        && held === 0
        && pressed === 0
        && released === 0
      ) {
        entry.guest.neutralCycle = cycle;
      }
    }

    function serviceControllerScenario(scenario, cycle) {
      if (scenario === null || scenario.status !== "running") return scenario?.status ?? null;
      controllerScenarioInteger(cycle, "controller scenario cycle");
      scenario.pollIndex = Math.max(scenario.pollIndex, controllerPollIndex);
      const sample = scenario.definition.sample();
      scenario.lastState = typeof scenario.definition.describe === "function"
        ? scenario.definition.describe(sample)
        : null;
      if (
        scenario.pulse?.state === "release"
        && scenario.steps.at(-1).release.polls !== 0
        && scenario.pulse.releaseServiceCycle === null
      ) {
        scenario.pulse.releaseServiceCycle = cycle;
      }
      observeControllerScenarioPulse(scenario, cycle, sample);

      if (cycle >= scenario.hardCycleLimit) {
        failControllerScenario(scenario, cycle, "hard cycle limit reached");
        return scenario.status;
      }

      if (scenario.pulse !== null) {
        const pulse = scenario.pulse;
        const entry = scenario.steps.at(-1);
        if (pulse.owner === "page") {
          const guestObserved = entry.guest === undefined || (
            entry.guest.activeCycle !== null
            && entry.guest.neutralCycle !== null
          );
          if (
            pulse.state === "neutral"
            && entry.neutral.polls >= scenario.minimumNeutralPolls
            && guestObserved
          ) {
            entry.completedCycle = cycle;
            entry.completedPollIndex = scenario.pollIndex;
            scenario.stepIndex += 1;
            scenario.pulse = null;
          } else if (
            pulse.state === "neutral"
            && entry.guest !== undefined
            && entry.neutral.polls >= scenario.maximumNeutralPolls
          ) {
            const missing = [
              entry.guest.activeCycle === null ? "active" : null,
              entry.guest.neutralCycle === null ? "neutral" : null,
            ].filter(value => value !== null).join(", ");
            failControllerScenario(
              scenario,
              cycle,
              `guest did not observe ${missing} controller state`
            );
            return scenario.status;
          }
        } else if (pulse.state === "release") {
          const guestHadReleaseWindow = pulse.releaseServiceCycle !== null
            && cycle > pulse.releaseServiceCycle;
          if (guestHadReleaseWindow && entry.guest.pressedCycle === null) {
            failControllerScenario(
              scenario,
              cycle,
              `guest did not observe pressed within ${scenario.pressPolls} polls`
            );
            return scenario.status;
          }
          const observed = entry.guest.pressedCycle !== null
            && entry.guest.releasedCycle !== null
            && entry.guest.neutralCycle !== null;
          if (pulse.neutralPolls >= scenario.minimumNeutralPolls && observed) {
            entry.completedCycle = cycle;
            entry.completedPollIndex = scenario.pollIndex;
            scenario.stepIndex += 1;
            scenario.pulse = null;
          } else if (
            guestHadReleaseWindow
            && pulse.neutralPolls >= scenario.maximumNeutralPolls
          ) {
            const missing = [
              entry.guest.pressedCycle === null ? "pressed" : null,
              entry.guest.releasedCycle === null ? "released" : null,
              entry.guest.neutralCycle === null ? "neutral" : null,
            ].filter(value => value !== null).join(", ");
            failControllerScenario(
              scenario,
              cycle,
              `guest did not observe ${missing || "the input edge"}`
            );
          }
        }
        if (scenario.pulse !== null) return scenario.status;
      }

      for (;;) {
        const step = scenario.definition.steps[scenario.stepIndex];
        if (step === undefined) {
          scenario.status = "complete";
          scenario.completedCycle = cycle;
          return scenario.status;
        }
        const missed = step.missed?.(sample, scenario);
        if (missed) {
          failControllerScenario(
            scenario,
            cycle,
            typeof missed === "string" ? missed : `missed transition for ${step.id}`
          );
          return scenario.status;
        }
        if (!step.ready(sample, scenario)) return scenario.status;

        const state = typeof scenario.definition.describe === "function"
          ? scenario.definition.describe(sample)
          : null;
        if (step.button === null) {
          scenario.steps.push({
            id: step.id,
            type: "observe",
            observedCycle: cycle,
            observedPollIndex: scenario.pollIndex,
            state,
          });
          scenario.stepIndex += 1;
          if (
            scenario.id === "smb-sustained-play"
            && step.id === "post-play-presented"
          ) captureSmbReadyPlayAnchor(scenario, cycle, state);
          continue;
        }

        if (step.input?.owner === "page") {
          const entry = {
            id: step.id,
            type: "state-input",
            owner: "page",
            readyCycle: cycle,
            readyPollIndex: scenario.pollIndex,
            readyState: state,
            active: createControllerScenarioStateRecord(
              scenario.nextRequestSequence,
              step.input.active
            ),
            neutral: createControllerScenarioStateRecord(
              scenario.nextRequestSequence + 1,
              step.input.neutral
            ),
            ...(step.input.activeObserved === undefined ? {} : {
              guest: {
                activeCycle: null,
                activePollIndex: null,
                activeState: null,
                neutralCycle: null,
                neutralPollIndex: null,
                neutralState: null,
              },
            }),
            completedCycle: null,
            completedPollIndex: null,
          };
          scenario.steps.push(entry);
          scenario.nextRequestSequence += 2;
          scenario.pulse = {
            owner: "page",
            state: null,
            requestSequence: null,
          };
          requestControllerScenarioState(scenario, entry, "active", cycle);
          return scenario.status;
        }

        const entry = {
          id: step.id,
          type: "input",
          button: step.button,
          readyCycle: cycle,
          readyPollIndex: scenario.pollIndex,
          readyState: state,
          press: {
            sequence: scenario.nextSequence,
            polls: 0,
            publications: [],
            firstPollIndex: null,
            lastPollIndex: null,
            firstScheduledCycle: null,
            lastScheduledCycle: null,
            firstObservedCycle: null,
            lastObservedCycle: null,
          },
          release: {
            sequence: scenario.nextSequence + 1,
            polls: 0,
            publications: [],
            firstPollIndex: null,
            lastPollIndex: null,
            firstScheduledCycle: null,
            lastScheduledCycle: null,
            firstObservedCycle: null,
            lastObservedCycle: null,
          },
          guest: {
            pressedCycle: null,
            releasedCycle: null,
            neutralCycle: null,
          },
          completedCycle: null,
          completedPollIndex: null,
        };
        scenario.steps.push(entry);
        scenario.nextSequence += 2;
        scenario.pulse = {
          button: step.button,
          state: "press",
          pressPolls: 0,
          neutralPolls: 0,
          releaseServiceCycle: null,
        };
        return scenario.status;
      }
    }

    function recordControllerScenarioPoll(
      record,
      pollIndex,
      scheduledCycle,
      observedCycle,
      source,
      buttons,
      sequence
    ) {
      record.polls += 1;
      record.firstPollIndex ??= pollIndex;
      record.lastPollIndex = pollIndex;
      record.firstScheduledCycle ??= scheduledCycle;
      record.lastScheduledCycle = scheduledCycle;
      record.firstObservedCycle ??= observedCycle;
      record.lastObservedCycle = observedCycle;
      record.publications.push({
        source,
        pollIndex,
        scheduledCycle,
        observedCycle,
        buttons,
        sequence,
      });
    }

    function recordControllerScenarioStatePoll(
      record,
      pollIndex,
      scheduledCycle,
      observedCycle,
      source,
      sequence
    ) {
      record.polls += 1;
      record.firstPollIndex ??= pollIndex;
      record.lastPollIndex = pollIndex;
      record.firstScheduledCycle ??= scheduledCycle;
      record.lastScheduledCycle = scheduledCycle;
      record.firstObservedCycle ??= observedCycle;
      record.lastObservedCycle = observedCycle;
      record.publications.push({
        source,
        pollIndex,
        scheduledCycle,
        observedCycle,
        state: record.state,
        sequence,
      });
    }

    function pollControllerScenario(
      scenario,
      channel,
      pollIndex,
      scheduledCycle,
      observedCycle,
      source = "periodic"
    ) {
      if (
        scenario === null
        || scenario.status !== "running"
        || channel !== 0
      ) return null;
      scenario.pollIndex = pollIndex;
      if (scenario.pulse === null) {
        controllerAppliedSequence = Math.max(0, scenario.nextSequence - 1);
        return 0;
      }
      const pulse = scenario.pulse;
      const entry = scenario.steps.at(-1);
      if (pulse.owner === "page") {
        const step = scenario.definition.steps[scenario.stepIndex];
        const record = entry[pulse.state];
        if (
          record.sequence === null
          || controllerAppliedSequence !== record.sequence
          || !controllerStatesEqual(controllerState, record.state)
        ) return null;
        recordControllerScenarioStatePoll(
          record,
          pollIndex,
          scheduledCycle,
          observedCycle,
          source,
          record.sequence
        );
        if (
          pulse.state === "active"
          && record.polls === (step.input.activePolls ?? scenario.pressPolls)
        ) {
          requestControllerScenarioState(scenario, entry, "neutral", observedCycle);
        }
        return null;
      }
      if (pulse.state === "press") {
        controllerAppliedSequence = entry.press.sequence;
        pulse.pressPolls += 1;
        recordControllerScenarioPoll(
          entry.press,
          pollIndex,
          scheduledCycle,
          observedCycle,
          source,
          pulse.button,
          entry.press.sequence
        );
        if (pulse.pressPolls === scenario.pressPolls) pulse.state = "release";
        return pulse.button;
      }
      controllerAppliedSequence = entry.release.sequence;
      pulse.neutralPolls += 1;
      recordControllerScenarioPoll(
        entry.release,
        pollIndex,
        scheduledCycle,
        observedCycle,
        source,
        0,
        entry.release.sequence
      );
      return 0;
    }

    function snapshotControllerScenario(scenario) {
      if (scenario === null) return null;
      const current = scenario.definition.steps[scenario.stepIndex] ?? null;
      return {
        id: scenario.id,
        gameIdentifier: scenario.gameIdentifier,
        status: scenario.status,
        hardCycleLimit: scenario.hardCycleLimit,
        startCycle: scenario.startCycle,
        completedCycle: scenario.completedCycle,
        failure: scenario.failure,
        stepIndex: scenario.stepIndex,
        currentStep: current?.id ?? null,
        pollIndex: scenario.pollIndex,
        lastState: scenario.lastState,
        steps: scenario.steps,
      };
    }

    function cloneControllerScenarioEvidence(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function captureSmbReadyPlayAnchor(scenario, cycle, state) {
      if (
        smbReadyPlayAnchor !== null
        || scenario?.id !== "smb-sustained-play"
        || scenario.stepIndex !== 13
        || scenario.steps.length !== 13
        || scenario.steps.at(-1)?.id !== "post-play-presented"
      ) return smbReadyPlayAnchor;
      const steps = cloneControllerScenarioEvidence(scenario.steps);
      smbReadyPlayAnchor = {
        status: "paused",
        stage: "scenario-complete",
        cycles: cycle,
        disc: {
          identifier: boot.identifier,
          revision: boot.version,
        },
        controller: {
          pollIndex: scenario.pollIndex,
          appliedSequence: controllerAppliedSequence,
          lastPolledSequence: serialLastPolledSequence,
          lastPolledButtons: serialLastPolledButtons,
          pendingButtons: controllerQueue.reduce(
            (buttons, queued) => buttons | queued.state.buttons,
            0
          ),
          queuedStates: controllerQueue.length,
          queueOverflows: controllerQueueOverflows,
        },
        scenario: {
          id: "smb-ready-play",
          gameIdentifier: scenario.gameIdentifier,
          status: "complete",
          hardCycleLimit: 30_000_000_000,
          startCycle: scenario.startCycle,
          completedCycle: cycle,
          failure: null,
          stepIndex: steps.length,
          currentStep: null,
          pollIndex: scenario.pollIndex,
          lastState: cloneControllerScenarioEvidence(state),
          steps,
        },
      };
      return smbReadyPlayAnchor;
    }

    function summarizeSmbSustainedPlay(scenario = controllerScenario) {
      const receipts = smbSustainedViReceipts;
      const first = receipts[0] ?? null;
      const last = receipts.at(-1) ?? null;
      const top = receipts.filter(receipt => receipt.presentation?.field === "top");
      const bottom = receipts.filter(receipt => receipt.presentation?.field === "bottom");
      const parityAddressSet = field => new Set(receipts
        .filter(receipt => receipt.presentation?.field === field)
        .map(receipt => receipt.presentation?.address));
      const topAddresses = parityAddressSet("top");
      const bottomAddresses = parityAddressSet("bottom");
      const input = scenario?.steps.find(candidate =>
        candidate.id === "sustained-main-stick-left") ?? null;
      const worldTilt = state => {
        const world = state?.gameplayInput?.world ?? null;
        const xrot = world?.xrot ?? null;
        const zrot = world?.zrot ?? null;
        return {
          xrot,
          zrot,
          maxAbs: Number.isSafeInteger(xrot) && Number.isSafeInteger(zrot)
            ? Math.max(Math.abs(xrot), Math.abs(zrot))
            : null,
          inputLockFrames: world?.inputLockFrames ?? null,
        };
      };
      const inputOracle = {
        activePolls: input?.active?.polls ?? null,
        neutralPolls: input?.neutral?.polls ?? null,
        activeWireStickX: input?.active?.state?.stickX ?? null,
        neutralWireStickX: input?.neutral?.state?.stickX ?? null,
        activeGuestStickX: input?.guest?.activeState?.padStatus?.stickX ?? null,
        neutralGuestStickX: input?.guest?.neutralState?.padStatus?.stickX ?? null,
        gameplayMapping: {
          currentPlayer:
            input?.guest?.activeState?.gameplayInput?.currentPlayer ?? null,
          controller: input?.guest?.activeState?.gameplayInput?.controller ?? null,
        },
        activeWorldTilt: worldTilt(input?.guest?.activeState),
        neutralWorldTilt: worldTilt(input?.guest?.neutralState),
      };
      const strictAlternation = receipts.every((receipt, index) =>
        (receipt.presentation?.field === "top" || receipt.presentation?.field === "bottom")
        && (
          index === 0
          || receipt.presentation.field !== receipts[index - 1].presentation?.field
        ));
      const correctedRows = receipts.every(receipt =>
        receipt.presentation?.copyRow === (
          receipt.presentation?.field === "top" ? 0 : 1
        ));
      const stableParityAddresses = topAddresses.size === 1
        && bottomAddresses.size === 1
        && [...topAddresses][0] !== [...bottomAddresses][0];
      const advancingCopyIndices = receipts.every((receipt, index) =>
        index === 0
        || (
          Number.isSafeInteger(receipt.presentation?.copyIndex)
          && Number.isSafeInteger(receipts[index - 1].presentation?.copyIndex)
          && receipt.presentation.copyIndex > receipts[index - 1].presentation.copyIndex
        ));
      const dimensions640x448 = receipts.every(receipt =>
        receipt.presentation?.width === 640 && receipt.presentation?.height === 448);
      const playInvariants = receipts.every(receipt =>
        receipt.gameplay?.gameModeRequest === -1
        && receipt.gameplay.gameMode === 2
        && receipt.gameplay.gameSubmodeRequest === -1
        && receipt.gameplay.gameSubmode === 51
        && receipt.gameplay.attempts === 1
        && receipt.gameplay.floor === 1);
      const infoTimerDelta = first === null || last === null
        ? null
        : Number(first.gameplay?.infoTimer) - Number(last.gameplay?.infoTimer);
      const inputComplete = inputOracle.activePolls === 30
        && Number.isSafeInteger(inputOracle.neutralPolls)
        && inputOracle.neutralPolls >= 3
        && inputOracle.activeWireStickX === 0x1c
        && inputOracle.neutralWireStickX === 0x80
        && inputOracle.activeGuestStickX === -60
        && inputOracle.neutralGuestStickX === 0
        && Number.isSafeInteger(inputOracle.gameplayMapping.currentPlayer)
        && Number.isSafeInteger(inputOracle.gameplayMapping.controller)
        && inputOracle.activeWorldTilt.inputLockFrames === 0
        && Number.isSafeInteger(inputOracle.activeWorldTilt.maxAbs)
        && inputOracle.activeWorldTilt.maxAbs >= 256
        && inputOracle.neutralWorldTilt.xrot === 0
        && inputOracle.neutralWorldTilt.zrot === 0
        && inputOracle.neutralWorldTilt.maxAbs === 0
        && inputOracle.neutralWorldTilt.inputLockFrames === 0
        && inputOracle.gameplayMapping.currentPlayer
          === input?.guest?.neutralState?.gameplayInput?.currentPlayer
        && inputOracle.gameplayMapping.controller
          === input?.guest?.neutralState?.gameplayInput?.controller;
      const renderer = {
        failed: rendererFrameFailures,
        inFlight: rendererFramesInFlight.size,
        pendingReceipts: smbSustainedViPending.size,
      };
      const presented = receipts.filter(receipt => receipt.presented === true).length;
      const staged = receipts.filter(receipt =>
        receipt.accepted === true && receipt.presented === false
      ).length;
      const rejected = receipts.filter(receipt => receipt.accepted !== true).length;
      const completedPairEpochs = new Set(receipts
        .filter(receipt => receipt.presented === true)
        .map(receipt => receipt.pairEpoch)).size;
      const drained = receipts.filter(receipt => receipt.drained === true).length;
      return {
        capacity: smbSustainedViReceiptCapacity,
        received: receipts.length,
        drained,
        staged,
        presented,
        rejected,
        completedPairEpochs,
        topFields: top.length,
        bottomFields: bottom.length,
        strictAlternation,
        correctedRows,
        stableParityAddresses,
        parityAddresses: {
          top: topAddresses.size === 1 ? [...topAddresses][0] : null,
          bottom: bottomAddresses.size === 1 ? [...bottomAddresses][0] : null,
        },
        advancingCopyIndices,
        dimensions: { width: 640, height: 448, allMatch: dimensions640x448 },
        playInvariants,
        infoTimer: {
          first: first?.gameplay?.infoTimer ?? null,
          last: last?.gameplay?.infoTimer ?? null,
          delta: infoTimerDelta,
        },
        input: inputOracle,
        renderer,
        readyPlayAnchorCaptured: smbReadyPlayAnchor !== null,
        complete: receipts.length === smbSustainedViReceiptCapacity
          && drained === smbSustainedViReceiptCapacity
          && staged === smbSustainedViReceiptCapacity / 2
          && presented === smbSustainedViReceiptCapacity / 2
          && rejected === 0
          && completedPairEpochs === smbSustainedViReceiptCapacity / 2
          && top.length === 60
          && bottom.length === 60
          && strictAlternation
          && correctedRows
          && stableParityAddresses
          && advancingCopyIndices
          && dimensions640x448
          && playInvariants
          && infoTimerDelta === 119
          && inputComplete
          && smbReadyPlayAnchor !== null
          && smbSustainedViFailure === null
          && renderer.failed === 0
          && renderer.inFlight === 0
          && renderer.pendingReceipts === 0,
      };
    }

    function snapshotSmbSustainedPlay(scenario = controllerScenario) {
      if (scenario?.id !== "smb-sustained-play") return null;
      return {
        schema: "lazuli-smb-sustained-play-v2",
        capacity: smbSustainedViReceiptCapacity,
        posted: smbSustainedViReceiptsPosted,
        pending: smbSustainedViPending.size,
        receipts: smbSustainedViReceipts,
        failure: smbSustainedViFailure,
        readyPlayAnchor: smbReadyPlayAnchor,
        oracle: summarizeSmbSustainedPlay(scenario),
      };
    }

    function createSuperMonkeyBallControllerScenarioDefinition() {
      const padA = 0x0100;
      const padB = 0x0200;
      const padStart = 0x1000;
      const titleMode = sample =>
        sample.gameModeRequest === -1
        && sample.gameMode === 0
        && sample.gameSubmodeRequest === -1
        && sample.gameSubmode === 20
        && (sample.pauseStatus & 0x0a) === 0
        && (sample.inputLockStatus & 1) === 0
        && sample.titleChoice === 0
        && sample.textBoxState === 10
        && sample.textBoxTimer >= 31;
      const selector = (sample, current) =>
        sample.gameModeRequest === -1
        && sample.gameMode === 1
        && sample.gameSubmodeRequest === -1
        && sample.gameSubmode === 32
        && (sample.pauseStatus & 0x0a) === 0
        && sample.selectorRequest === -1
        && sample.selectorCurrent === current;
      const stepCycle = (scenario, id) => {
        const step = scenario.steps.find(candidate => candidate.id === id);
        return step?.completedCycle ?? step?.observedCycle ?? null;
      };
      const stepState = (scenario, id) =>
        scenario.steps.find(candidate => candidate.id === id)?.state ?? null;
      const deadline = (anchorId, additionalCycles, label) => (sample, scenario) => {
        const anchor = anchorId === null ? scenario.startCycle : stepCycle(scenario, anchorId);
        return anchor !== null && sample.cycle >= anchor + additionalCycles
          ? `${label} deadline exceeded by ${sample.cycle - anchor - additionalCycles} cycles`
          : false;
      };
      const stablePresentations = (id, minimumPresentations, predicate) =>
        (sample, scenario) => {
        const residency = scenario.superMonkeyBallResidency ??= Object.create(null);
        if (!predicate(sample)) {
          delete residency[id];
          return false;
        }
        residency[id] ??= sample.viPresentationCount;
        return sample.viPresentationCount - residency[id] >= minimumPresentations;
      };
      const stableSelector = (current, extra = () => true) => stablePresentations(
        `selector-${current}`,
        31,
        sample => selector(sample, current) && extra(sample)
      );

      return {
        id: "smb-ready-play",
        gameIdentifier: "GMBE8P",
        gameVersion: 0,
        hardCycleLimit: 30_000_000_000,
        pressPolls: 3,
        minimumNeutralPolls: 3,
        maximumNeutralPolls: 120,
        sample: inspectSuperMonkeyBallScenarioState,
        describe: sample => sample,
        steps: [
          {
            id: "memory-card-back",
            button: padB,
            ready: sample =>
              sample.gameModeRequest === -1
              && sample.gameMode === 0
              && sample.gameSubmodeRequest === -1
              && sample.gameSubmode === 6
              && sample.warningState === 2
              && sample.warningDialogPhase === 0xff
              && (sample.warningDialogFlags & 0x200) !== 0,
            missed: deadline(null, 2_000_000_000, "memory-card prompt"),
          },
          {
            id: "skip-opening-demo",
            button: padStart,
            ready: stablePresentations("opening-demo", 3, sample =>
              sample.gameModeRequest === -1
              && sample.gameMode === 0
              && sample.gameSubmodeRequest === -1
              && sample.gameSubmode === 2
              && sample.submodeTimer > 60
              && (sample.flags & 0x2000) === 0
              && sample.demoSkipTimer === 0
              && sample.demoResourcesReady !== 0
            ),
            missed: deadline("memory-card-back", 10_000_000_000, "opening demo"),
          },
          {
            id: "opening-demo-skipped",
            button: null,
            ready: sample =>
              sample.gameModeRequest === -1
              && sample.gameMode === 0
              && sample.gameSubmodeRequest === -1
              && sample.gameSubmode === 2
              && (sample.flags & 0x2000) !== 0
              && sample.demoSkipTimer > 0
              && sample.demoSkipTimer <= 30,
            missed: deadline("skip-opening-demo", 200_000_000, "opening-demo skip"),
          },
          {
            id: "title-start",
            button: padStart,
            ready: stablePresentations("title-start", 31, sample =>
              titleMode(sample)
              && (sample.flags & 4) === 0
            ),
            missed: deadline("opening-demo-skipped", 1_500_000_000, "title screen"),
          },
          {
            id: "title-game-start",
            button: padA,
            ready: stablePresentations("title-game-start", 31, sample =>
              titleMode(sample)
              && (sample.flags & 4) !== 0
              && (sample.flags & 2) === 0
            ),
            missed: deadline("title-start", 1_000_000_000, "Game Start acceptance"),
          },
          {
            id: "select-current-8",
            button: padA,
            ready: stableSelector(8, sample => sample.selectorChoice === 0),
            missed: deadline("title-game-start", 2_000_000_000, "main-game selector"),
          },
          {
            id: "select-current-10",
            button: padA,
            ready: stableSelector(10, sample => sample.gameType === 0),
            missed: deadline("select-current-8", 1_000_000_000, "normal-mode selector"),
          },
          {
            id: "select-current-16",
            button: padA,
            ready: stableSelector(
              16,
              sample => sample.gameType === 0 && sample.playerCount === 1
            ),
            missed: deadline("select-current-10", 1_000_000_000, "player-count selector"),
          },
          {
            id: "select-current-18",
            button: padA,
            ready: stableSelector(
              18,
              sample => sample.gameType === 0
                && sample.playerCount === 1
                && sample.characterSelection0 === 0
                && sample.characterLocked0 === 0
            ),
            missed: deadline("select-current-16", 1_000_000_000, "character selector"),
          },
          {
            id: "select-current-22",
            button: padA,
            ready: stableSelector(
              22,
              sample => sample.gameType === 0
                && sample.playerCount === 1
                && sample.difficulty === 0
            ),
            missed: deadline("select-current-18", 1_000_000_000, "difficulty selector"),
          },
          {
            id: "ready-main",
            button: null,
            ready: sample =>
              sample.gameModeRequest === -1
              && sample.gameMode === 2
              && sample.gameSubmodeRequest === -1
              && sample.gameSubmode === 49
              && (sample.pauseStatus & 0x0a) === 0
              && sample.attempts === 1
              && sample.floor === 1
              && (sample.infoFlags & 0x108) === 0x108
              && sample.submodeTimer === 360,
            missed: deadline("select-current-22", 2_000_000_000, "READY main"),
          },
          {
            id: "play-main",
            button: null,
            ready: (sample, scenario) => {
              const readyCycle = stepCycle(scenario, "ready-main");
              const readyState = stepState(scenario, "ready-main");
              return readyCycle !== null
                && readyState !== null
                && sample.viPresentationCount - readyState.viPresentationCount
                  >= readyState.submodeTimer
                && sample.gameModeRequest === -1
                && sample.gameMode === 2
                && sample.gameSubmodeRequest === -1
                && sample.gameSubmode === 51
                && (sample.pauseStatus & 0x0a) === 0
                && (sample.infoFlags & 0x108) === 0;
            },
            missed: deadline("ready-main", 4_000_000_000, "PLAY main"),
          },
          {
            id: "post-play-presented",
            button: null,
            ready: (sample, scenario) => {
              const playCycle = stepCycle(scenario, "play-main");
              const playState = stepState(scenario, "play-main");
              return playCycle !== null
                && playState !== null
                && sample.gameModeRequest === -1
                && sample.gameMode === 2
                && sample.gameSubmodeRequest === -1
                && sample.gameSubmode === 51
                && (sample.infoFlags & 0x108) === 0
                && sample.viLastPresentationCopyIndex > 0
                && sample.gxXfbCopyCount > playState.gxXfbCopyCount
                && sample.viPresentationCount > playState.viPresentationCount
                && sample.viLastPresentationCycle > playCycle
                && sample.viLastPresentationCopyIndex > playState.gxXfbCopyCount
                && sample.xfbCaptured === true
                && sample.xfbCapturedAtCycle > playCycle
                && sample.xfbDisplayedAtCycle > playCycle
                && sample.temporalXfbCapturesPosted
                  >= sample.temporalXfbCaptureCapacity
                && sample.rendererFramesAcknowledged > playState.rendererFramesAcknowledged
                && sample.rendererFramesInFlight === 0
                && sample.rendererFailed === false;
            },
            missed: deadline("play-main", 1_000_000_000, "post-PLAY presentation"),
          },
        ],
      };
    }

    function createSuperMonkeyBallSustainedPlayScenarioDefinition() {
      const readyPlay = createSuperMonkeyBallControllerScenarioDefinition();
      const neutral = {
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
      // Hold a strong left deflection long enough for SMB's input_main to
      // normalize it and world_sub_input_main to smooth it into stage tilt.
      // The wire byte 0x1c becomes -100 in PADRead and saturates to -60 in
      // SMB's controllerInfo calibration.
      const active = { ...neutral, stickX: 0x1c };
      const activePolls = 30;
      const minimumActiveTilt = 256;
      const inputStepId = "sustained-main-stick-left";
      const tiltMagnitude = state => Math.max(
        Math.abs(state?.gameplayInput?.world?.xrot ?? 0),
        Math.abs(state?.gameplayInput?.world?.zrot ?? 0)
      );
      const inputWitness = scenario => {
        const entry = scenario.steps.find(candidate => candidate.id === inputStepId);
        return entry?.type === "state-input"
          && entry.owner === "page"
          && entry.active.polls === activePolls
          && entry.neutral.polls >= 3
          && entry.guest?.activeState?.padStatus?.error === 0
          && entry.guest.activeState.padStatus.stickX === -60
          && entry.guest.activeState.gameplayInput?.world?.state === 2
          && entry.guest.activeState.gameplayInput.world.player
            === entry.guest.activeState.gameplayInput.currentPlayer
          && entry.guest.activeState.gameplayInput.world.inputLockFrames === 0
          && tiltMagnitude(entry.guest.activeState) >= minimumActiveTilt
          && entry.guest?.neutralState?.padStatus?.error === 0
          && entry.guest.neutralState.padStatus.stickX === 0
          && entry.guest.neutralState.gameplayInput?.world?.state === 2
          && entry.guest.neutralState.gameplayInput.world.player
            === entry.guest.neutralState.gameplayInput.currentPlayer
          && entry.guest.neutralState.gameplayInput.world.inputLockFrames === 0
          && tiltMagnitude(entry.guest.neutralState) === 0
          && entry.guest.activeState.gameplayInput.currentPlayer
            === entry.guest.neutralState.gameplayInput.currentPlayer
          && entry.guest.activeState.gameplayInput.controller
            === entry.guest.neutralState.gameplayInput.controller;
      };
      const playInvariant = sample =>
        sample.gameModeRequest === -1
        && sample.gameMode === 2
        && sample.gameSubmodeRequest === -1
        && sample.gameSubmode === 51
        && sample.attempts === 1
        && sample.floor === 1
        && sample.rendererFailed === false;
      return {
        ...readyPlay,
        id: "smb-sustained-play",
        hardCycleLimit: 32_000_000_000,
        sample: inspectSuperMonkeyBallSustainedPlayState,
        steps: [
          ...readyPlay.steps,
          {
            id: inputStepId,
            input: {
              owner: "page",
              activePolls,
              active,
              neutral,
              activeObserved: sample =>
                sample?.padStatus?.error === 0
                && sample.padStatus.stickX === -60
                && sample.gameplayInput?.world?.state === 2
                && sample.gameplayInput.world.player === sample.gameplayInput.currentPlayer
                && sample.gameplayInput.world.inputLockFrames === 0
                && tiltMagnitude(sample) >= minimumActiveTilt,
              neutralObserved: (sample, scenario) => {
                const entry = scenario.steps.find(candidate =>
                  candidate.id === inputStepId);
                const activeInput = entry?.guest?.activeState?.gameplayInput;
                return activeInput !== undefined
                  && sample?.padStatus?.error === 0
                  && sample.padStatus.stickX === 0
                  && sample.gameplayInput?.world?.state === 2
                  && sample.gameplayInput.world.player === sample.gameplayInput.currentPlayer
                  && sample.gameplayInput.world.inputLockFrames === 0
                  && tiltMagnitude(sample) === 0
                  && sample.gameplayInput.currentPlayer === activeInput.currentPlayer
                  && sample.gameplayInput.controller === activeInput.controller;
              },
            },
            ready: sample =>
              playInvariant(sample)
              && sample.temporalXfbCapturesPosted === sample.temporalXfbCaptureCapacity
              && sample.padStatus?.error === 0
              && sample.padStatus.stickX === 0
              && sample.gameplayInput?.world?.state === 2
              && sample.gameplayInput.world.player === sample.gameplayInput.currentPlayer
              && sample.gameplayInput.world.inputLockFrames === 0
              && tiltMagnitude(sample) === 0
              && sample.rendererFramesInFlight === 0,
          },
          {
            id: "sustained-play-presented",
            button: null,
            ready: (sample, scenario) => {
              const first = smbSustainedViReceipts[0] ?? null;
              const last = smbSustainedViReceipts.at(-1) ?? null;
              return inputWitness(scenario)
                && playInvariant(sample)
                && smbSustainedViFailure === null
                && smbSustainedViReceiptsPosted === smbSustainedViReceiptCapacity
                && smbSustainedViReceipts.length === smbSustainedViReceiptCapacity
                && first !== null
                && last !== null
                && first.gameplay.infoTimer - last.gameplay.infoTimer === 119
                && sample.rendererFramesInFlight === 0;
            },
            missed: (sample, scenario) => {
              const input = scenario.steps.find(candidate => candidate.id === inputStepId);
              const anchor = input?.completedCycle ?? null;
              return anchor !== null && sample.cycle >= anchor + 3_000_000_000
                ? `sustained PLAY deadline exceeded by ${sample.cycle - anchor - 3_000_000_000} cycles`
                : false;
            },
          },
        ],
      };
    }

    function createSuperMonkeyBallMainStickRoundtripScenarioDefinition() {
      const neutral = {
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
      const active = { ...neutral, stickX: 0x1c };
      return {
        id: "smb-main-stick-roundtrip",
        gameIdentifier: "GMBE8P",
        gameVersion: 0,
        hardCycleLimit: 2_000_000_000,
        pressPolls: 3,
        minimumNeutralPolls: 3,
        maximumNeutralPolls: 120,
        sample: inspectSuperMonkeyBallMainStickRoundtripState,
        describe: sample => sample,
        steps: [{
          id: "main-stick-left-roundtrip",
          input: {
            owner: "page",
            active,
            neutral,
            activeObserved: sample =>
              sample?.padStatus?.error === 0
              && sample.padStatus.stickX === -60,
            neutralObserved: sample =>
              sample?.padStatus?.error === 0
              && sample.padStatus.stickX === 0,
          },
          ready: sample =>
            sample?.si?.pollIndex > 0
            && sample.si.publishedChannels === 1
            && sample.si.updatedChannels === 4
            && sample?.padStatus?.error === 0
            && sample.padStatus.stickX === 0,
        }],
      };
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

    // These redistributable replacement fonts occupy the same decoded IPL
    // windows as the console fonts. Keeping the sparse virtual image inside
    // the existing frontend asset avoids a font fetch or public asset route.
    // A local retail IPL can replace this image through the one-shot,
    // client-only message path below.
    function createBundledExiIplImage() {
      const image = new Uint8Array(exiIplImageBytes);
      image.set(
        decode("__IPL_FONT_JAPANESE__"),
        __IPL_FONT_JAPANESE_OFFSET__
      );
      image.set(
        decode("__IPL_FONT_WESTERN__"),
        __IPL_FONT_WESTERN_OFFSET__
      );
      return image;
    }

    function validateExiIplImage(image, label) {
      if (Object.prototype.toString.call(image) !== "[object Uint8Array]") {
        throw new TypeError(`${label} must be a Uint8Array`);
      }
      if (image.byteLength !== exiIplImageBytes) {
        throw new RangeError(
          `${label} must be exactly ${exiIplImageBytes} bytes`
        );
      }
      return image;
    }

    async function configuredExiIplImage(config) {
      config ??= globalThis.iplSourceConfig ?? { kind: "bundled-default" };
      if (config.kind === "bundled-default") {
        const image = await createBundledExiIplImage();
        return {
          image: image === null
            ? null
            : validateExiIplImage(image, "bundled IPL-compatible image"),
          source: { kind: "bundled-default" },
        };
      }
      if (config.kind !== "file-message") {
        throw new Error("unsupported IPL source configuration");
      }
      return new Promise((resolve, reject) => {
        const receive = event => {
          if (event.data?.type !== "ipl-source-image") return;
          removeEventListener("message", receive);
          try {
            if (!(event.data.image instanceof ArrayBuffer)) {
              throw new TypeError("IPL picker did not transfer an ArrayBuffer");
            }
            const image = validateExiIplImage(
              new Uint8Array(event.data.image),
              "local IPL image"
            );
            const region = event.data.region === "PAL" ? "PAL" : "NTSC";
            resolve({
              image,
              source: { kind: "local-file", region },
            });
          } catch (error) {
            reject(error);
          }
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
    const discSourceConfigPromise = configuredDiscSource();
    const configuredExiIplImagePromise = configuredExiIplImage();
    let [
      compilerWasm,
      discSourceConfig,
      configuredExiIpl,
    ] = await Promise.all([
      compilerWasmPromise,
      discSourceConfigPromise,
      configuredExiIplImagePromise,
    ]);
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
    let { bi2, dol, fst } = boot;
    const { bi2Address, fstAddress, fstMaxSize } = boot;
    const bi2Bytes = bi2.length;
    const dolBytes = dol.length;
    const fstBytes = fst.length;
    const compilerWasmBytes = compilerWasm.length;
    const gprOffsets = [__GPR_OFFSETS__];
    const segmentRegisterOffsets = [__SR_OFFSETS__];
    const instructionBatOffsets = [__IBAT_OFFSETS__];
    const dataBatOffsets = [__DBAT_OFFSETS__];
    const defaultInstructionBats = [
      [0x80001fff, 0x00000002],
      [0x00000000, 0x00000000],
      [0x00000000, 0x00000000],
      [0xfff0001f, 0xfff00001],
    ];
    const defaultDataBats = [
      [0x80001fff, 0x00000002],
      [0xc0001fff, 0x0000002a],
      [0x00000000, 0x00000000],
      [0xfff0001f, 0xfff00001],
    ];
    const memory = new WebAssembly.Memory({ initial: __MEMORY_PAGES__ });
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    const cpu = __CPU_PTR__;
    const regionControl = 0xf000;
    const regionCyclePrefixOffset = 0;
    const regionExitRequestOffset = 4;
    const hookCycleOffset = 8;
    const fastmem = __FASTMEM_PTR__;
    const ram = __RAM_PTR__;
    const ramSize = __RAM_SIZE__;
    const mmio = __MMIO_PTR__;
    const mmioSize = __MMIO_SIZE__;
    const physicalMmioBase = 0x0c000000;
    const lockedCache = __LOCKED_CACHE_PTR__;
    const lockedCacheSize = __LOCKED_CACHE_SIZE__;
    const gxFifoHookRuntimeWasm = decode("__GX_FIFO_HOOK_RUNTIME__");
    const gxFifoStagingMeta = __GX_FIFO_STAGING_META_PTR__;
    const gxFifoStagingData = __GX_FIFO_STAGING_DATA_PTR__;
    const gxFifoStagingCapacity = __GX_FIFO_STAGING_CAPACITY__;
    const pcOffset = __PC_OFFSET__;
    const ctrOffset = __CTR_OFFSET__;
    const msrOffset = __MSR_OFFSET__;
    const sdr1Offset = __SDR1_OFFSET__;
    const lrOffset = __LR_OFFSET__;
    const darOffset = __DAR_OFFSET__;
    const dsisrOffset = __DSISR_OFFSET__;
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
    registerControllerScenario(createSuperMonkeyBallControllerScenarioDefinition());
    registerControllerScenario(createSuperMonkeyBallSustainedPlayScenarioDefinition());
    // The public surface filters this diagnostic id; the debug harness keeps
    // it available as a short, independently witnessed analog bring-up path.
    registerControllerScenario(createSuperMonkeyBallMainStickRoundtripScenarioDefinition());
    const controllerScenario = selectControllerScenario(
      requestedControllerScenario,
      boot.identifier,
      0,
      boot.version,
      globalThis.runnerScenarioOptional === true
    );
    controllerScenarioInputExclusive = controllerScenario !== null;
    cycleLimit = controllerScenarioCycleLimit(cycleLimit, controllerScenario);
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
    // The transport consumes a decoded 2 MiB IPL-compatible image supplied
    // by the bundled replacement-font image or by the client-only picker.
    // No proprietary IPL bytes belong in this generated harness.
    let exiIplImage = configuredExiIpl.image;
    const exiIplSource = configuredExiIpl.source;
    const exiSram = createDefaultExiSram();
    const exiTransferTraceLimit = 64;
    const exiTransferTrace = [];
    const exiTransferOutcomes = new Map();
    const exiDmaOutcomes = new Map();
    const exiDmaReasons = new Map();
    let exiTransferSequence = 0;
    let exiTransferTraceDropped = 0;
    let exiDmaAttempts = 0;
    let exiDmaCompletions = 0;
    let exiDmaZeroLengthCompletions = 0;
    let exiLastDma = null;
    let exi0IplChipSelectActive = false;
    let exi0IplCommandWord = 0;
    let exi0IplCommandBytes = 0;
    let exi0IplCommandWrite = null;
    let exi0IplCommandAddress = null;
    let exi0IplCursor = 0;
    let exi0IplAddressSequence = null;
    let exi0IplDmaBytes = 0;
    let exi0RtcRefreshCount = 0;
    let exi0RtcLastRefreshCycle = null;
    let exi0RtcImmediateReadBytes = 0;
    let exi0SramImmediateReadBytes = 0;
    let exi0SramDmaReads = 0;
    let exi0SramDmaBytes = 0;
    let exiTransferCompletions = 0;
    let exiTransferInterruptAcknowledgements = 0;
    let exiInterruptLevelActive = false;
    let exiInterruptLevelChanges = 0;
    let exiInterruptLevelReason = null;
    let exiPiAssertions = 0;
    let exiPiDeassertions = 0;
    let exiExternalInterruptDeliveries = 0;
    const dspTrace = [];
    const accelerations = new Map();
    const exceptionCounts = new Map();
    const exceptionFirstTrace = [];
    const exceptionTrace = [];
    const exceptionFirstByVector = {};
    let firstDsi = null;
    let lastDataStorageFault = null;
    let lastUnmappedAccess = null;
    let dataFastmemTranslationSignature = null;
    let instructionTranslationSignature = null;
    let instructionAddressSpaceKey = null;
    let instructionAddressSpaceGeneration = 0;
    const instructionTlbSets = Array.from(
      { length: 64 },
      () => ({ entries: [null, null], lru: 0 })
    );
    const dataTlbSets = Array.from(
      { length: 64 },
      () => ({ entries: [null, null], lru: 0 })
    );
    const dataReservationGranuleBytes = 32;
    let dataReservationPhysicalGranule = null;
    const cpFifoState = {
      control: 0,
      base: 0,
      end: 0,
      highWatermark: 0,
      lowWatermark: 0,
      distance: 0,
      writePointer: 0,
      readPointer: 0,
      breakpoint: 0,
    };
    const piFifoState = {
      base: 0,
      end: 0,
      current: 0,
      wrap: false,
    };
    const gxWriteGatherBuffer = new Uint8Array(gxWriteGatherBurstBytes);
    let gxWriteGatherPendingBytes = 0;
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
    // Keep the carry as a packed numeric Array for sustained V8 throughput.
    // JavaScript exposes no physical Array capacity; this logical watermark
    // advances geometrically for deterministic growth telemetry. The separate
    // maximum-buffered-bytes preflight is the hard safety bound.
    const gxDecodeInitialCapacityWatermarkBytes = 4096;
    // A direct vertex can occupy at most 129 bytes, so the largest legal
    // primitive is 3 + 65,535 * 129 bytes. A 16 MiB ceiling safely covers that
    // plus a complete staging append while bounding corrupt-stream growth.
    const gxDecodeMaximumBufferedBytes = 16 * 1024 * 1024;
    let gxDecodeBuffer = [];
    let gxDecodeCapacityWatermarkBytes = gxDecodeInitialCapacityWatermarkBytes;
    let gxDecodeRetryAtBufferedBytes = 1;
    let gxDecodeAttempts = 0;
    let gxDecodeBlockedSkips = 0;
    let gxDecodeCompactions = 0;
    let gxDecodeCapacityWatermarkGrowths = 0;
    let gxDecodePreDecodeHighWaterBytes = 0;
    const gxCpRegisters = new Uint32Array(256);
    const gxBpRegisters = new Uint32Array(256);
    const gxXfRegisters = new Uint32Array(0x1058);
    const gxTevColorRegisters = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    const gxTevKonstRegisters = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    gxBpRegisters[0xf3] = 0x003f0000;
    gxBpRegisters[0xfe] = 0x00ffffff;
    const gxXfbCopies = [];
    // Keep renderer residency separate from the rolling copy diagnostics.
    // Sparse rendering leaves the most recently captured surface resident at
    // each destination even after sixteen newer uncaptured guest copies have
    // aged its diagnostic record out of gxXfbCopies.
    const gxXfbCopyDestinations = new Map();
    const gxTextureCopies = [];
    const gxPrimitiveSamples = [];
    const gxRecentPrimitiveSamples = [];
    const gxTextureCacheByteLimit = 16 * 1024 * 1024;
    const gxTevTextureCacheByteLimit = 16 * 1024 * 1024;
    const gxTextureCache = createWeightedLruCache(
      64,
      gxTextureCacheByteLimit,
      texture => texture.mipPixels.byteLength
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
    let gxLightingRejectedVertices = 0;
    let gxLegacyProjectionNullVertices = 0;
    let gxExactRequiredDraws = 0;
    let gxExactRequiredVertices = 0;
    let gxExactRequiredCaptureMisses = 0;
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
    let gxSkippedCopyClears = [];
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
    let gxWriteGatherBursts = 0;
    let gxWriteGatherLinkedBursts = 0;
    let gxWriteGatherUnlinkedBursts = 0;
    let gxWriteGatherBytesCommitted = 0;
    let gxWriteGatherWraps = 0;
    let gxWriteGatherResets = 0;
    let gxWriteGatherDiscardedBytes = 0;
    let gxWriteGatherHighWaterBytes = 0;
    let gxWriteGatherLastDestination = null;
    let commandProcessorServiceCalls = 0;
    let commandProcessorReadBursts = 0;
    let commandProcessorReadBytes = 0;
    let commandProcessorReadWraps = 0;
    let commandProcessorBreakpointStops = 0;
    let commandProcessorReadDisabledStops = 0;
    let commandProcessorMaximumDistance = 0;
    let commandProcessorMaximumRawDistance = 0;
    let commandProcessorDistanceNormalizations = 0;
    let commandProcessorLastDistanceNormalization = null;
    let commandProcessorDecoderResets = 0;
    let commandProcessorDecoderDiscardedBytes = 0;
    let commandProcessorHighInterruptPending = false;
    let commandProcessorLowInterruptPending = false;
    let commandProcessorQualifiedInterruptSources = 0;
    let commandProcessorInterruptLevelActive = false;
    let commandProcessorHighInterruptAssertions = 0;
    let commandProcessorLowInterruptAssertions = 0;
    let commandProcessorInterruptClears = 0;
    let commandProcessorActiveClearReassertions = 0;
    let commandProcessorPerformanceMetricClears = 0;
    let commandProcessorPiAssertions = 0;
    let commandProcessorPiDeassertions = 0;
    let commandProcessorExternalInterruptDeliveries = 0;
    let commandProcessorInterruptResets = 0;
    let commandProcessorInterruptTraceSignature = null;
    const commandProcessorInterruptTrace = [];
    let peFinishCycle = null;
    let peFinishSignal = false;
    let peFinishInterruptDelivered = false;
    let peTokenValue = 0;
    let peTokenSignal = false;
    let peTokenInterruptDelivered = false;
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
    let viBeamEnabled = false;
    let viFrozenBeam = { halfLine: 0, sample: 0, sampleCycle: 0 };
    let nextViCycle = null;
    let nextViPresentCycle = null;
    let nextViBoundaryCycle = null;
    let nextViTimingBoundaryCycle = null;
    let nextSerialPollCycle = null;
    let viLastEventCycle = null;
    let viLastEventInterval = null;
    let viTimingReschedules = 0;
    let viMissedHalfLines = 0;
    let viPiDeliveries = 0;
    let viPresentationCount = 0;
    let viHostPresentationCount = 0;
    let viFieldStagedCount = 0;
    let viFieldRejectedCount = 0;
    let viFieldSupersededCount = 0;
    let viLastResultStatus = null;
    let viLastResultPairEpoch = null;
    const viResultCounts = new Map();
    let viLastHostPresentationCycle = null;
    let viLastHostPresentationField = null;
    let viLastHostPresentationAddress = 0;
    let viLastHostPresentationCopyIndex = 0;
    let viLastHostPresentationCopyRow = 0;
    let viLastHostPresentationPairEpoch = null;
    let viLastHostPresentationSerial = null;
    let viLastPresentationCycle = null;
    let viLastPresentationField = null;
    let viLastPresentationAddress = 0;
    let viLastPresentationCopyIndex = 0;
    let viLastPresentationCopyRow = 0;
    let viNextPairEpoch = 1;
    let viPendingFieldPair = null;
    const viComparatorMatches = [0, 0, 0, 0];
    const viStatusAssertions = [0, 0, 0, 0];
    const viInterruptAcknowledgements = [0, 0, 0, 0];
    let viActiveAcv = null;
    let viPendingAcv = null;
    let viActiveOddVBlank = null;
    let viPendingOddVBlank = null;
    let viActiveEvenVBlank = null;
    let viPendingEvenVBlank = null;
    let viScanoutWriteSerial = 0;
    let viScanoutLatchSerial = 0;
    const viScanoutPending = {
      topBase: null,
      bottomBase: null,
      picture: null,
    };
    const viScanoutActive = {
      topBase: null,
      bottomBase: null,
      picture: null,
    };
    const viScanoutBoundarySnapshots = [];
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
    let dspUcodeUpload = emptyDspUcodeUpload();
    let dspUcodeHash = null;
    let dspMode = "rom";
    let dspUcodeBooted = false;
    let dspAxCommandState = emptyDspAxCommandState();
    let dspZeldaCommandState = emptyDspZeldaCommandState();
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
      user_0_13: (_ctx, address) => invalidateInstructionCacheLine(address),
      user_0_14: () => synchronizeInstructionStream(),
      user_0_15: () => serviceLockedCacheDma(),
      user_0_16: () => msrChanged(),
      user_0_17: () => instructionBatChanged(),
      user_0_18: () => dataBatChanged(),
      user_0_19: () => updateTimeBase(),
      user_0_20: () => timeBaseChanged(),
      user_0_21: () => updateDecrementer(cycles),
      user_0_22: () => decrementerChanged(),
      user_0_23: () => segmentRegisterChanged(),
      user_0_24: () => sdr1Changed(),
      user_0_25: (_ctx, address) => invalidateTranslationLookasideBuffer(address),
      user_0_26: () => synchronizeTranslationLookasideBuffer(),
      user_0_27: (_ctx, address, pointer) => loadReserveInteger(address, pointer),
      user_0_28: (_ctx, address, value) => storeConditionalInteger(address, value),
      user_1_0: (registers, exception) => raiseException(registers, exception),
    };

    function regionHookCanContinue(name, arguments_, result) {
      let size;
      switch (name) {
        case "user_0_16":
          return Number(result) === 1;
        case "user_0_3": case "user_0_7": size = 1; break;
        case "user_0_4": case "user_0_8": size = 2; break;
        case "user_0_5": case "user_0_9": size = 4; break;
        case "user_0_6": case "user_0_10": size = 8; break;
        case "user_0_11": case "user_0_12": size = Number(result); break;
        case "user_0_27":
          if (Number(result) !== 1) return false;
          size = 4;
          break;
        case "user_0_28":
          if (Number(result) !== 1 && Number(result) !== 2) return false;
          size = 4;
          break;
        default: return false;
      }
      if (![1, 2, 4, 8].includes(size)) return false;

      const address = Number(arguments_[1]) >>> 0;
      const write = [
        "user_0_7",
        "user_0_8",
        "user_0_9",
        "user_0_10",
        "user_0_12",
        "user_0_28",
      ].includes(name);
      return dataRamOrLockedCachePointer(address, size, write, false) !== null;
    }

    function withScopedCycles(scopedCycles, callback) {
      const baseCycles = cycles;
      cycles = scopedCycles;
      try {
        return callback();
      } finally {
        cycles = baseCycles;
      }
    }

    function withPublishedHookCycles(callback) {
      const regionCyclePrefix = regionRunning
        ? view.getUint32(regionControl + regionCyclePrefixOffset, true)
        : 0;
      const instructionCycleOffset = view.getUint32(
        regionControl + hookCycleOffset,
        true
      );
      return withScopedCycles(
        cycles + regionCyclePrefix + instructionCycleOffset,
        callback
      );
    }

    function drainGxFifoStagingForJit() {
      return withPublishedHookCycles(() => {
        const result = drainGxFifoStaging();
        if (regionRunning) {
          view.setUint32(regionControl + regionExitRequestOffset, 1, true);
        }
        return result;
      });
    }

    function drainGxFifoStagingAtCycle(observedCycles) {
      return withScopedCycles(observedCycles, drainGxFifoStaging);
    }

    function invokeJitHook(target, name, arguments_) {
      return withPublishedHookCycles(() => {
        const drainedFifo = view.getUint32(gxFifoStagingMeta, true) !== 0;
        drainGxFifoStaging();
        hookCalls.set(name, (hookCalls.get(name) ?? 0) + 1);
        if (!regionRunning) return target[name]?.(...arguments_) ?? 0;

        const result = target[name]?.(...arguments_) ?? 0;
        const hookCanContinue = regionHookCanContinue(name, arguments_, result);
        if (hookCanContinue) {
          regionContinuableHookCalls += 1;
        }
        // A successful pre-hook FIFO drain can create a new PE deadline that
        // was absent when this region's cycle budget was chosen.
        if (drainedFifo || !hookCanContinue) {
          view.setUint32(regionControl + regionExitRequestOffset, 1, true);
        }
        return result;
      });
    }

    function createJitHookProxy(target) {
      return new Proxy(target, {
        get(hookTarget, name) {
          return (...arguments_) => invokeJitHook(hookTarget, name, arguments_);
        },
      });
    }

    const hooks = createJitHookProxy(hookFunctions);

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

    function batAllowsAccess(lower, write) {
      const protection = lower & 3;
      return write ? protection === 2 : protection !== 0;
    }

    function translateBatAddress(effectiveAddress, upper, lower, userMode, write) {
      const valid = userMode ? 1 : 2;
      if ((upper & valid) === 0) return null;
      if (!batAllowsAccess(lower, write)) return null;
      const blockMask = (((upper >>> 2) & 0x7ff) << 17) >>> 0;
      const addressMask = (blockMask | 0x1ffff) >>> 0;
      const regionMask = (~addressMask) >>> 0;
      const effective = effectiveAddress >>> 0;
      if ((effective & regionMask) !== ((upper >>> 0) & regionMask)) return null;
      const physicalBase = ((lower & 0xfffe0000) & regionMask) >>> 0;
      return (physicalBase | (effective & addressMask)) >>> 0;
    }

    function resolveDataEffectiveAddress(
      effectiveAddress,
      msr,
      dataBats,
      write = false
    ) {
      const effective = effectiveAddress >>> 0;
      if ((msr & 0x10) === 0) {
        return {
          kind: "mapped",
          source: "real",
          effective,
          physical: effective,
          write,
        };
      }
      const userMode = (msr & 0x4000) !== 0;
      for (let bat = 0; bat < dataBats.length; bat += 1) {
        const [upper, lower] = dataBats[bat];
        const valid = userMode ? 1 : 2;
        if ((upper & valid) === 0) continue;
        const blockMask = (((upper >>> 2) & 0x7ff) << 17) >>> 0;
        const addressMask = (blockMask | 0x1ffff) >>> 0;
        const regionMask = (~addressMask) >>> 0;
        if ((effective & regionMask) !== ((upper >>> 0) & regionMask)) continue;

        const translation = {
          effective,
          source: "bat",
          bat,
          protection: lower & 3,
          wimg: (lower >>> 3) & 0xf,
          write,
        };
        if (!batAllowsAccess(lower, write)) {
          return { kind: "protection", ...translation };
        }
        const physicalBase = ((lower & 0xfffe0000) & regionMask) >>> 0;
        return {
          kind: "mapped",
          ...translation,
          physical: (physicalBase | (effective & addressMask)) >>> 0,
        };
      }
      return { kind: "bat-miss", effective, write };
    }

    function dataPageAllowsAccess(msr, segment, pte1, write) {
      const selectedKeyMask = (msr & 0x4000) !== 0
        ? 0x20000000
        : 0x40000000;
      const key = (segment & selectedKeyMask) !== 0 ? 1 : 0;
      const protection = pte1 & 3;
      if (!write) return key === 0 || protection !== 0;
      return key === 0 ? protection !== 3 : protection === 2;
    }

    function commitDataPageHistory(resolved) {
      if (
        resolved?.source !== "page"
        || (resolved.kind !== "mapped" && resolved.kind !== "protection")
        || !Number.isInteger(resolved.ptePointer)
      ) {
        return resolved;
      }
      const history = resolved.kind === "mapped" && resolved.write
        ? 0x180
        : 0x100;
      let committed = resolved;
      let resident = null;
      if (
        Number.isInteger(resolved.setIndex)
        && Number.isInteger(resolved.way)
        && typeof dataTlbSets !== "undefined"
      ) {
        const set = dataTlbSets[resolved.setIndex];
        const candidate = set?.entries[resolved.way] ?? null;
        if (
          candidate !== null
          && candidate.vsid === (resolved.vsid & 0x00ffffff)
          && candidate.pageIndex === ((resolved.effective >>> 12) & 0xffff)
        ) {
          resident = candidate;
          set.lru = resolved.way ^ 1;
        }
      }
      if (
        resident === null
        && Number.isInteger(resolved.vsid)
        && typeof fillDataTlb === "function"
      ) {
        const filled = fillDataTlb(
          resolved.effective,
          resolved.vsid,
          {
            pte0: resolved.pte0,
            pte1: resolved.pte1,
            ptePhysical: resolved.ptePhysical,
            ptePointer: resolved.ptePointer,
            secondary: resolved.secondary,
            slot: resolved.slot,
          }
        );
        committed = { ...resolved, ...filled, tlbHit: false };
        resident = dataTlbSets[filled.setIndex].entries[filled.way];
      }

      // The resident PTE image is authoritative until tlbie. Only a cached
      // R/C transition writes the table, and it ORs the current backing word
      // so unrelated guest edits are never replaced by the stale mapping.
      const cachedPte1 = (resident?.pte1 ?? committed.pte1) >>> 0;
      const pte1 = (cachedPte1 | history) >>> 0;
      if (pte1 !== cachedPte1) {
        if (resident !== null) resident.pte1 = pte1;
        const backingPte1 = view.getUint32(committed.ptePointer + 4, false);
        const backingHistory = (backingPte1 | history) >>> 0;
        if (backingHistory !== backingPte1) {
          view.setUint32(committed.ptePointer + 4, backingHistory, false);
        }
      }
      return { ...committed, pte1 };
    }

    function resolveDataPageAddress(
      effectiveAddress,
      msr,
      segmentRegisters,
      sdr1,
      write = false,
      updateHistory = false
    ) {
      const effective = effectiveAddress >>> 0;
      const segment = segmentRegisters[effective >>> 28] >>> 0;
      if ((segment & 0x80000000) !== 0) {
        return {
          kind: "direct-store",
          reason: "direct-store-segment",
          effective,
          write,
        };
      }

      const vsid = segment & 0x00ffffff;
      const cached = typeof lookupDataTlb === "function"
        ? lookupDataTlb(effective, vsid, updateHistory)
        : null;
      if (cached !== null) {
        const resolved = resolveDataTlbEntry(
          effective,
          msr,
          segment,
          { ...cached, tlbHit: true },
          write
        );
        return updateHistory ? commitDataPageHistory(resolved) : resolved;
      }
      const pageIndex = (effective >>> 12) & 0xffff;
      const abbreviatedPageIndex = (effective >>> 22) & 0x3f;
      const primaryHash = ((vsid & 0x7ffff) ^ pageIndex) & 0x7ffff;
      const secondaryHash = (~primaryHash) & 0x7ffff;
      const tableBase = sdr1 & 0xffff0000;
      const tableMask = 0x3ff | ((sdr1 & 0x1ff) << 10);
      const ptegAddress = hash => (
        tableBase | (((hash & tableMask) << 6) >>> 0)
      ) >>> 0;
      const primaryPteg = ptegAddress(primaryHash);
      const secondaryPteg = ptegAddress(secondaryHash);

      for (const [secondary, ptegPhysical] of [
        [false, primaryPteg],
        [true, secondaryPteg],
      ]) {
        const ptegPointer = physicalRamPointer(ptegPhysical, 64);
        if (ptegPointer === null) {
          return {
            kind: "page-table-unbacked",
            effective,
            physical: ptegPhysical,
            secondary,
            write,
          };
        }
        const expectedPte0 = (
          0x80000000
          | (vsid << 7)
          | (secondary ? 0x40 : 0)
          | abbreviatedPageIndex
        ) >>> 0;
        for (let slot = 0; slot < 8; slot += 1) {
          const ptePointer = ptegPointer + slot * 8;
          const pte0 = view.getUint32(ptePointer, false);
          if (pte0 !== expectedPte0) continue;
          const pte1 = view.getUint32(ptePointer + 4, false);
          const selectedKeyMask = (msr & 0x4000) !== 0
            ? 0x20000000
            : 0x40000000;
          const key = (segment & selectedKeyMask) !== 0 ? 1 : 0;
          const translation = {
            effective,
            source: "page",
            physical: ((pte1 & 0xfffff000) | (effective & 0xfff)) >>> 0,
            pte0,
            pte1,
            ptePhysical: (ptegPhysical + slot * 8) >>> 0,
            ptePointer,
            secondary,
            slot,
            vsid,
            key,
            protection: pte1 & 3,
            wimg: (pte1 >>> 3) & 0xf,
            write,
            tlbHit: false,
          };
          const resolved = dataPageAllowsAccess(msr, segment, pte1, write)
            ? { kind: "mapped", ...translation }
            : { kind: "protection", ...translation };
          return updateHistory ? commitDataPageHistory(resolved) : resolved;
        }
      }
      return {
        kind: "page-fault",
        effective,
        primaryPteg,
        secondaryPteg,
        write,
      };
    }

    function resolveDataTranslation(
      effectiveAddress,
      msr,
      dataBats,
      segmentRegisters = undefined,
      sdr1 = 0,
      write = false,
      updateHistory = false
    ) {
      const resolved = resolveDataEffectiveAddress(
        effectiveAddress,
        msr,
        dataBats,
        write
      );
      if (resolved.kind !== "bat-miss") return resolved;
      if (!Array.isArray(segmentRegisters) || segmentRegisters.length !== 16) {
        return resolved;
      }
      return resolveDataPageAddress(
        effectiveAddress,
        msr,
        segmentRegisters,
        sdr1 >>> 0,
        write,
        updateHistory
      );
    }

    function translateDataEffectiveAddress(
      effectiveAddress,
      msr,
      dataBats,
      write = false,
      segmentRegisters = undefined,
      sdr1 = 0,
      updateHistory = false
    ) {
      const resolved = resolveDataTranslation(
        effectiveAddress,
        msr,
        dataBats,
        segmentRegisters,
        sdr1,
        write,
        updateHistory
      );
      return resolved.kind === "mapped" ? resolved.physical : null;
    }

    function resolveDataEffectiveRange(
      effectiveAddress,
      size,
      msr,
      dataBats,
      segmentRegisters = undefined,
      sdr1 = 0,
      write = false,
      updateHistory = false
    ) {
      const effective = effectiveAddress >>> 0;
      if (!Number.isSafeInteger(size) || size <= 0) {
        return { kind: "invalid-range", effective, size, write };
      }
      if (size > 0x100000000 - effective) {
        return { kind: "invalid-range", effective, size, write };
      }

      let physicalStart = null;
      let offset = 0;
      const translations = [];
      while (offset < size) {
        const currentEffective = (effective + offset) >>> 0;
        const current = resolveDataTranslation(
          currentEffective,
          msr,
          dataBats,
          segmentRegisters,
          sdr1,
          write,
          false
        );
        if (current.kind !== "mapped") {
          const fault = updateHistory && current.kind === "protection"
            ? commitDataPageHistory(current)
            : current;
          return {
            ...fault,
            effectiveStart: effective,
            size,
            faultEffective: currentEffective,
            translations,
          };
        }
        const currentPhysical = current.physical >>> 0;
        if (physicalStart === null) {
          physicalStart = currentPhysical;
          if (size > 0x100000000 - physicalStart) {
            return {
              kind: "invalid-range",
              effective,
              physical: physicalStart,
              size,
              write,
              translations,
            };
          }
        } else if (currentPhysical !== physicalStart + offset) {
          return {
            kind: "non-contiguous",
            effective,
            physical: physicalStart,
            size,
            write,
            faultEffective: currentEffective,
            faultPhysical: currentPhysical,
            translations,
          };
        }
        translations.push(current);
        const translationBytes = current.source === "page"
          ? 0x1000 - (currentEffective & 0xfff)
          : current.source === "bat"
            ? 0x20000 - (currentEffective & 0x1ffff)
            : size - offset;
        offset += Math.min(size - offset, translationBytes);
      }
      const committed = updateHistory
        ? translations.map(commitDataPageHistory)
        : translations;
      return {
        kind: "mapped",
        effective,
        physical: physicalStart,
        size,
        write,
        translations: committed,
      };
    }

    function translateDataEffectiveRange(
      effectiveAddress,
      size,
      msr,
      dataBats,
      write = false,
      segmentRegisters = undefined,
      sdr1 = 0,
      updateHistory = false
    ) {
      const resolved = resolveDataEffectiveRange(
        effectiveAddress,
        size,
        msr,
        dataBats,
        segmentRegisters,
        sdr1,
        write,
        updateHistory
      );
      return resolved.kind === "mapped" ? resolved.physical : null;
    }

    function resolveInstructionEffectiveAddress(effectiveAddress, msr, instructionBats) {
      const effective = effectiveAddress >>> 0;
      if ((msr & 0x20) === 0) {
        return { kind: "mapped", effective, physical: effective };
      }
      const userMode = (msr & 0x4000) !== 0;
      for (const [upper, lower] of instructionBats) {
        const valid = userMode ? 1 : 2;
        if ((upper & valid) === 0) continue;
        const blockMask = (((upper >>> 2) & 0x7ff) << 17) >>> 0;
        const addressMask = (blockMask | 0x1ffff) >>> 0;
        const regionMask = (~addressMask) >>> 0;
        if ((effective & regionMask) !== ((upper >>> 0) & regionMask)) continue;
        if (!batAllowsAccess(lower, false)) {
          return { kind: "protection", effective };
        }
        // MPC750 IBAT pairs have no G attribute; their fetches are nonguarded.
        const physicalBase = ((lower & 0xfffe0000) & regionMask) >>> 0;
        return {
          kind: "mapped",
          effective,
          physical: (physicalBase | (effective & addressMask)) >>> 0,
        };
      }
      return { kind: "bat-miss", effective };
    }

    function readSegmentRegisters() {
      return segmentRegisterOffsets.map(offset =>
        view.getUint32(cpu + offset, true)
      );
    }

    function resetTranslationLookasideBuffer(sets) {
      for (const set of sets) {
        set.entries[0] = null;
        set.entries[1] = null;
        set.lru = 0;
      }
    }

    function initializeTranslationLookasideBuffers() {
      resetTranslationLookasideBuffer(instructionTlbSets);
      resetTranslationLookasideBuffer(dataTlbSets);
    }

    function instructionTlbSetIndex(effectiveAddress) {
      return ((effectiveAddress >>> 12) & 0x3f) >>> 0;
    }

    function dataTlbSetIndex(effectiveAddress) {
      return ((effectiveAddress >>> 12) & 0x3f) >>> 0;
    }

    function lookupDataTlb(effectiveAddress, vsid, touch = false) {
      const effective = effectiveAddress >>> 0;
      const setIndex = dataTlbSetIndex(effective);
      const set = dataTlbSets[setIndex];
      const pageIndex = (effective >>> 12) & 0xffff;
      for (let way = 0; way < 2; way += 1) {
        const entry = set.entries[way];
        if (
          entry === null
          || entry.vsid !== (vsid & 0x00ffffff)
          || entry.pageIndex !== pageIndex
        ) continue;
        if (touch) set.lru = way ^ 1;
        return { ...entry, setIndex, way };
      }
      return null;
    }

    function fillDataTlb(effectiveAddress, vsid, entry) {
      const effective = effectiveAddress >>> 0;
      const setIndex = dataTlbSetIndex(effective);
      const set = dataTlbSets[setIndex];
      let way = set.entries.findIndex(candidate => candidate === null);
      if (way < 0) way = set.lru;
      const stored = {
        ...entry,
        vsid: vsid & 0x00ffffff,
        pageIndex: (effective >>> 12) & 0xffff,
      };
      set.entries[way] = stored;
      set.lru = way ^ 1;
      return { ...stored, setIndex, way };
    }

    function resolveDataTlbEntry(
      effectiveAddress,
      msr,
      segment,
      entry,
      write = false
    ) {
      const effective = effectiveAddress >>> 0;
      const pte1 = entry.pte1 >>> 0;
      const selectedKeyMask = (msr & 0x4000) !== 0
        ? 0x20000000
        : 0x40000000;
      const key = (segment & selectedKeyMask) !== 0 ? 1 : 0;
      const translation = {
        effective,
        source: "page",
        physical: ((pte1 & 0xfffff000) | (effective & 0xfff)) >>> 0,
        pte0: entry.pte0 >>> 0,
        pte1,
        ptePhysical: entry.ptePhysical >>> 0,
        ptePointer: entry.ptePointer,
        secondary: entry.secondary === true,
        slot: entry.slot >>> 0,
        vsid: entry.vsid & 0x00ffffff,
        key,
        protection: pte1 & 3,
        wimg: (pte1 >>> 3) & 0xf,
        write,
        tlbHit: entry.tlbHit === true,
        ...(Number.isInteger(entry.setIndex) && Number.isInteger(entry.way)
          ? { setIndex: entry.setIndex, way: entry.way }
          : {}),
      };
      return dataPageAllowsAccess(msr, segment, pte1, write)
        ? { kind: "mapped", ...translation }
        : { kind: "protection", ...translation };
    }

    function lookupInstructionTlb(effectiveAddress, vsid, touch = false) {
      const effective = effectiveAddress >>> 0;
      const setIndex = instructionTlbSetIndex(effective);
      const set = instructionTlbSets[setIndex];
      const pageIndex = (effective >>> 12) & 0xffff;
      for (let way = 0; way < 2; way += 1) {
        const entry = set.entries[way];
        if (
          entry === null
          || entry.vsid !== (vsid & 0x00ffffff)
          || entry.pageIndex !== pageIndex
        ) continue;
        if (touch) set.lru = way ^ 1;
        return { ...entry, setIndex, way };
      }
      return null;
    }

    function fillInstructionTlb(effectiveAddress, vsid, entry) {
      const effective = effectiveAddress >>> 0;
      const setIndex = instructionTlbSetIndex(effective);
      const set = instructionTlbSets[setIndex];
      let way = set.entries.findIndex(candidate => candidate === null);
      if (way < 0) way = set.lru;
      const stored = {
        ...entry,
        vsid: vsid & 0x00ffffff,
        pageIndex: (effective >>> 12) & 0xffff,
      };
      set.entries[way] = stored;
      set.lru = way ^ 1;
      return { ...stored, setIndex, way };
    }

    function resolveInstructionTlbEntry(effectiveAddress, msr, segment, entry) {
      const effective = effectiveAddress >>> 0;
      const pte1 = entry.pte1 >>> 0;
      const physical = ((pte1 & 0xfffff000) | (effective & 0xfff)) >>> 0;
      const translation = {
        effective,
        physical,
        ptePhysical: entry.ptePhysical >>> 0,
        secondary: entry.secondary === true,
        slot: entry.slot >>> 0,
        tlbHit: entry.tlbHit === true,
      };
      if ((pte1 & 0x08) !== 0) {
        return { kind: "guarded", ...translation };
      }
      const selectedKeyMask = (msr & 0x4000) !== 0
        ? 0x20000000
        : 0x40000000;
      const key = (segment & selectedKeyMask) !== 0 ? 1 : 0;
      if (key === 1 && (pte1 & 0x03) === 0) {
        return { kind: "protection", ...translation };
      }
      return { kind: "mapped", ...translation };
    }

    function resolveInstructionPageAddress(
      effectiveAddress,
      msr,
      segmentRegisters,
      sdr1,
      updateReferenced = false
    ) {
      const effective = effectiveAddress >>> 0;
      const segment = segmentRegisters[effective >>> 28] >>> 0;
      if ((segment & 0x80000000) !== 0) {
        return { kind: "no-execute", reason: "direct-store-segment", effective };
      }
      if ((segment & 0x10000000) !== 0) {
        return { kind: "no-execute", reason: "segment-no-execute", effective };
      }

      const vsid = segment & 0x00ffffff;
      const pageIndex = (effective >>> 12) & 0xffff;
      const abbreviatedPageIndex = (effective >>> 22) & 0x3f;
      const primaryHash = ((vsid & 0x7ffff) ^ pageIndex) & 0x7ffff;
      const secondaryHash = (~primaryHash) & 0x7ffff;
      const tableBase = sdr1 & 0xffff0000;
      const tableMask = 0x3ff | ((sdr1 & 0x1ff) << 10);
      const ptegAddress = hash => (
        tableBase | (((hash & tableMask) << 6) >>> 0)
      ) >>> 0;
      const primaryPteg = ptegAddress(primaryHash);
      const secondaryPteg = ptegAddress(secondaryHash);
      const cached = lookupInstructionTlb(effective, vsid, updateReferenced);
      if (cached !== null) {
        return resolveInstructionTlbEntry(effective, msr, segment, {
          ...cached,
          tlbHit: true,
        });
      }

      for (const [secondary, ptegPhysical] of [
        [false, primaryPteg],
        [true, secondaryPteg],
      ]) {
        const ptegPointer = physicalRamPointer(ptegPhysical, 64);
        if (ptegPointer === null) {
          return {
            kind: "page-table-unbacked",
            effective,
            physical: ptegPhysical,
            secondary,
          };
        }
        const expectedPte0 = (
          0x80000000
          | (vsid << 7)
          | (secondary ? 0x40 : 0)
          | abbreviatedPageIndex
        ) >>> 0;
        for (let slot = 0; slot < 8; slot += 1) {
          const ptePointer = ptegPointer + slot * 8;
          const pte0 = view.getUint32(ptePointer, false);
          if (pte0 !== expectedPte0) continue;
          const pte1 = view.getUint32(ptePointer + 4, false);
          if (updateReferenced && (pte1 & 0x100) === 0) {
            bytes[ptePointer + 6] |= 1;
          }
          let entry = {
            // A real fetch sets R before the translation is retained. Keep
            // the cached PTE image coherent with the architected table write
            // so a later ITLB hit observes the same translation state.
            pte1: updateReferenced ? (pte1 | 0x100) >>> 0 : pte1,
            ptePhysical: (ptegPhysical + slot * 8) >>> 0,
            secondary,
            slot,
          };
          if (updateReferenced) {
            entry = fillInstructionTlb(effective, vsid, entry);
          }
          return resolveInstructionTlbEntry(effective, msr, segment, {
            ...entry,
            tlbHit: false,
          });
        }
      }
      return {
        kind: "page-fault",
        effective,
        primaryPteg,
        secondaryPteg,
      };
    }

    function resolveInstructionTranslation(
      effectiveAddress,
      msr,
      instructionBats,
      segmentRegisters,
      sdr1,
      updateReferenced = false
    ) {
      const resolved = resolveInstructionEffectiveAddress(
        effectiveAddress,
        msr,
        instructionBats
      );
      if (resolved.kind !== "bat-miss") return resolved;
      if (!Array.isArray(segmentRegisters) || segmentRegisters.length !== 16) {
        return resolved;
      }
      return resolveInstructionPageAddress(
        effectiveAddress,
        msr,
        segmentRegisters,
        sdr1 >>> 0,
        updateReferenced
      );
    }

    function translateInstructionEffectiveAddress(
      effectiveAddress,
      msr,
      instructionBats,
      segmentRegisters = undefined,
      sdr1 = 0
    ) {
      const resolved = resolveInstructionTranslation(
        effectiveAddress,
        msr,
        instructionBats,
        segmentRegisters,
        sdr1,
        false
      );
      return resolved.kind === "mapped" ? resolved.physical : null;
    }

    function translateInstructionEffectiveRange(
      effectiveAddress,
      size,
      msr,
      instructionBats,
      segmentRegisters = undefined,
      sdr1 = 0
    ) {
      const effective = effectiveAddress >>> 0;
      if (!Number.isSafeInteger(size) || size <= 0) return null;
      if (size > 0x100000000 - effective) return null;

      let physicalStart = null;
      let offset = 0;
      while (offset < size) {
        const currentEffective = (effective + offset) >>> 0;
        const currentPhysical = translateInstructionEffectiveAddress(
          currentEffective,
          msr,
          instructionBats,
          segmentRegisters,
          sdr1
        );
        if (currentPhysical === null) return null;
        if (physicalStart === null) {
          physicalStart = currentPhysical;
          if (size > 0x100000000 - physicalStart) return null;
        } else if (currentPhysical !== physicalStart + offset) {
          return null;
        }
        offset += Math.min(size - offset, 0x1000 - (currentEffective & 0xfff));
      }
      return physicalStart;
    }

    function readInstructionBats() {
      return instructionBatOffsets.map(([lowerOffset, upperOffset]) => [
        view.getUint32(cpu + upperOffset, true),
        view.getUint32(cpu + lowerOffset, true),
      ]);
    }

    function readDataBats() {
      return dataBatOffsets.map(([lowerOffset, upperOffset]) => [
        view.getUint32(cpu + upperOffset, true),
        view.getUint32(cpu + lowerOffset, true),
      ]);
    }

    function translateDataAddress(
      effectiveAddress,
      write = false,
      updateHistory = false
    ) {
      return translateDataEffectiveAddress(
        effectiveAddress,
        view.getUint32(cpu + msrOffset, true),
        readDataBats(),
        write,
        readSegmentRegisters(),
        view.getUint32(cpu + sdr1Offset, true),
        updateHistory
      );
    }

    function translateInstructionAddress(effectiveAddress) {
      return translateInstructionEffectiveAddress(
        effectiveAddress,
        view.getUint32(cpu + msrOffset, true),
        readInstructionBats(),
        readSegmentRegisters(),
        view.getUint32(cpu + sdr1Offset, true)
      );
    }

    function translateInstructionRange(effectiveAddress, size) {
      return translateInstructionEffectiveRange(
        effectiveAddress,
        size,
        view.getUint32(cpu + msrOffset, true),
        readInstructionBats(),
        readSegmentRegisters(),
        view.getUint32(cpu + sdr1Offset, true)
      );
    }

    function resolveDataRange(
      effectiveAddress,
      size,
      write = false,
      updateHistory = false
    ) {
      return resolveDataEffectiveRange(
        effectiveAddress,
        size,
        view.getUint32(cpu + msrOffset, true),
        readDataBats(),
        readSegmentRegisters(),
        view.getUint32(cpu + sdr1Offset, true),
        write,
        updateHistory
      );
    }

    function dataStorageCause(fault, write = false) {
      let cause = write ? 0x02000000 : 0;
      if (fault?.kind === "page-fault") cause |= 0x40000000;
      if (fault?.kind === "protection") cause |= 0x08000000;
      if (fault?.kind === "direct-store") cause |= 0x04000000;
      return cause >>> 0;
    }

    function recordDataStorageFault(
      fault,
      effectiveAddress,
      size,
      write = false,
      stage = "translation",
      reason = undefined,
      value = undefined
    ) {
      const effective = effectiveAddress >>> 0;
      const cause = dataStorageCause(fault, write);
      const record = {
        kind: "data-storage",
        access: write ? "write" : "read",
        stage,
        reason: reason ?? fault?.kind ?? "unknown",
        resolverKind: fault?.kind ?? null,
        source: fault?.source ?? null,
        address: hex32(effective),
        physical: Number.isInteger(fault?.physical)
          ? hex32(fault.physical)
          : null,
        faultAddress: Number.isInteger(fault?.faultEffective)
          ? hex32(fault.faultEffective)
          : hex32(effective),
        size,
        dsisr: hex32(cause),
        pc: hex32(view.getUint32(cpu + pcOffset, true)),
        r1: hex32(readGpr(1)),
        dispatch: dispatches,
      };
      if (value !== undefined) {
        record.value = size === 8
          ? "0x" + BigInt.asUintN(64, value).toString(16)
          : hex32(value);
      }
      view.setUint32(cpu + dsisrOffset, cause, true);
      lastDataStorageFault = record;
      lastUnmappedAccess = record;
      return 0;
    }

    function translateDataRange(
      effectiveAddress,
      size,
      write = false,
      updateHistory = false
    ) {
      // Isolated device fixtures historically inject the numeric helper only.
      const resolved = typeof resolveDataRange === "function"
        ? resolveDataRange(effectiveAddress, size, write, updateHistory)
        : resolveDataEffectiveRange(
            effectiveAddress,
            size,
            view.getUint32(cpu + msrOffset, true),
            readDataBats(),
            readSegmentRegisters(),
            view.getUint32(cpu + sdr1Offset, true),
            write,
            updateHistory
          );
      return resolved.kind === "mapped" ? resolved.physical : null;
    }

    function normalizePhysicalMemoryAddress(address, size, ramBytes, mmioBytes) {
      const physical = address >>> 0;
      if (!Number.isInteger(size) || size < 0) return null;
      if (physical < ramBytes && size <= ramBytes - physical) {
        return { kind: "ram", offset: physical };
      }
      if (physical >= physicalMmioBase) {
        const offset = physical - physicalMmioBase;
        if (offset < mmioBytes && size <= mmioBytes - offset) {
          return { kind: "mmio", offset };
        }
      }
      return null;
    }

    function physicalRamPointer(address, size) {
      const normalized = normalizePhysicalMemoryAddress(
        address,
        size,
        ramSize,
        mmioSize
      );
      return normalized?.kind === "ram" ? ram + normalized.offset : null;
    }

    function physicalMmioPointer(address, size) {
      const normalized = normalizePhysicalMemoryAddress(
        address,
        size,
        ramSize,
        mmioSize
      );
      return normalized?.kind === "mmio" ? mmio + normalized.offset : null;
    }

    function dataRamPointer(
      address,
      size,
      write = false,
      updateHistory = false
    ) {
      const physical = translateDataRange(address, size, write, updateHistory);
      return physical === null ? null : physicalRamPointer(physical, size);
    }

    function dataFastmemPointer(effectiveAddress, msr, dataBats, ramBytes, ramBase) {
      // Hashed pages are 4 KiB while one fastmem entry spans 128 KiB.
      // Retain them on the checked slow path; only real-mode and DBAT
      // translations prove that the whole fastmem entry has one mapping.
      const resolved = resolveDataEffectiveAddress(
        effectiveAddress,
        msr,
        dataBats,
        true
      );
      if (
        resolved.kind !== "mapped"
        || (resolved.source !== "real" && resolved.source !== "bat")
        || resolved.physical >= ramBytes
      ) return null;
      return ramBase + resolved.physical;
    }

    function physicalLockedCachePointer(address, size) {
      const physical = address >>> 0;
      const offset = physical - 0xe0000000;
      if (offset < 0 || offset + size > lockedCacheSize) return null;
      return lockedCache + offset;
    }

    function instructionRamPointer(address, size) {
      const physical = translateInstructionRange(address, size);
      if (physical === null) return null;
      return physicalRamPointer(physical, size)
        ?? physicalLockedCachePointer(physical, size);
    }

    function resolveInstructionFetch(
      effectiveAddress,
      size = 4,
      updateReferenced = true
    ) {
      const effective = effectiveAddress >>> 0;
      if (
        size !== 4 || (effective & 3) !== 0
        || size > 0x100000000 - effective
      ) {
        return { kind: "invalid-range", effective };
      }
      const resolved = resolveInstructionTranslation(
        effective,
        view.getUint32(cpu + msrOffset, true),
        readInstructionBats(),
        readSegmentRegisters(),
        view.getUint32(cpu + sdr1Offset, true),
        updateReferenced
      );
      if (resolved.kind !== "mapped") return resolved;
      const pointer = physicalRamPointer(resolved.physical, size)
        ?? physicalLockedCachePointer(resolved.physical, size);
      if (pointer === null) {
        return {
          kind: "unbacked",
          effective,
          physical: resolved.physical,
        };
      }
      return { ...resolved, pointer };
    }

    function fetchInstructionWord(effectiveAddress, updateReferenced = true) {
      const resolved = resolveInstructionFetch(
        effectiveAddress,
        4,
        updateReferenced
      );
      if (resolved.kind !== "mapped") return resolved;
      return {
        ...resolved,
        word: view.getUint32(resolved.pointer, false),
      };
    }

    function dataRamOrLockedCachePointer(
      address,
      size,
      write = false,
      updateHistory = false
    ) {
      const physical = translateDataRange(address, size, write, updateHistory);
      if (physical === null) return null;
      return physicalRamPointer(physical, size)
        ?? physicalLockedCachePointer(physical, size);
    }

    function dataReservationGranule(physicalAddress) {
      return (
        (physicalAddress >>> 0)
        & ~(dataReservationGranuleBytes - 1)
      ) >>> 0;
    }

    function invalidateDataReservationForExternalWrite(
      physicalAddress,
      size
    ) {
      if (dataReservationPhysicalGranule === null || size === 0) return false;
      const physical = physicalAddress >>> 0;
      if (
        !Number.isSafeInteger(size)
        || size < 0
        || size > 0x100000000 - physical
      ) {
        // An external writer with an unbounded range cannot safely retain a
        // reservation. All in-tree device paths pass a bounded positive size.
        dataReservationPhysicalGranule = null;
        return true;
      }
      const writeEnd = physical + size;
      const reservationEnd = (
        dataReservationPhysicalGranule + dataReservationGranuleBytes
      );
      if (
        physical >= reservationEnd
        || dataReservationPhysicalGranule >= writeEnd
      ) return false;
      dataReservationPhysicalGranule = null;
      return true;
    }

    function invalidateDataReservationForExternalStridedWrite(
      physicalAddress,
      rowBytes,
      stride,
      rowCount
    ) {
      if (dataReservationPhysicalGranule === null || rowCount === 0) return false;
      const physical = physicalAddress >>> 0;
      if (
        !Number.isSafeInteger(rowBytes)
        || !Number.isSafeInteger(stride)
        || !Number.isSafeInteger(rowCount)
        || rowBytes <= 0
        || stride < 0
        || rowCount < 0
      ) {
        dataReservationPhysicalGranule = null;
        return true;
      }
      if (stride === 0) {
        // A zero BP copy stride repeatedly overwrites one bounded destination
        // row; it must not invalidate an unrelated reservation.
        return invalidateDataReservationForExternalWrite(physical, rowBytes);
      }
      const finalEnd = physical + (rowCount - 1) * stride + rowBytes;
      if (!Number.isSafeInteger(finalEnd) || finalEnd > 0x100000000) {
        dataReservationPhysicalGranule = null;
        return true;
      }

      const reservationStart = dataReservationPhysicalGranule;
      const reservationEnd = reservationStart + dataReservationGranuleBytes;
      const firstRow = Math.max(
        0,
        Math.floor((reservationStart - physical - rowBytes) / stride) + 1
      );
      const lastRow = Math.min(
        rowCount - 1,
        Math.ceil((reservationEnd - physical) / stride) - 1
      );
      if (firstRow > lastRow) return false;
      dataReservationPhysicalGranule = null;
      return true;
    }

    function resolveDataReservationTranslation(
      address,
      write,
      value = undefined
    ) {
      const logical = address >>> 0;
      const resolved = typeof resolveDataRange === "function"
        ? resolveDataRange(logical, 4, write, true)
        : null;
      const physical = resolved === null
        ? translateDataRange(logical, 4, write, true)
        : resolved.kind === "mapped"
          ? resolved.physical
          : null;
      if (physical === null) {
        if (typeof recordDataStorageFault === "function") {
          recordDataStorageFault(
            resolved ?? { kind: "translation-failed", effective: logical },
            logical,
            4,
            write,
            "translation",
            undefined,
            value
          );
        }
        return null;
      }
      return { logical, physical };
    }

    function resolveDataReservationBacking(
      translation,
      write,
      value = undefined
    ) {
      const { logical, physical } = translation;
      const lockedPointer = physicalLockedCachePointer(physical, 4);
      const pointer = physicalRamPointer(physical, 4) ?? lockedPointer;
      if (pointer === null) {
        if (typeof recordDataStorageFault === "function") {
          const device = typeof physicalMmioPointer === "function"
            && physicalMmioPointer(physical, 4) !== null;
          recordDataStorageFault(
            { kind: "mapped", effective: logical, physical },
            logical,
            4,
            write,
            device ? "device" : "physical",
            device
              ? "reservation-device-rejected"
              : "translated-physical-unbacked",
            value
          );
        }
        return null;
      }
      return { ...translation, pointer, lockedPointer };
    }

    function resolveDataReservationAccess(address, write, value = undefined) {
      const translation = resolveDataReservationTranslation(
        address,
        write,
        value
      );
      return translation === null
        ? null
        : resolveDataReservationBacking(translation, write, value);
    }

    function loadReserveInteger(address, pointer) {
      const logical = address >>> 0;
      // The compiler raises Alignment before invoking this hook. Preserve the
      // previous reservation if a malformed caller reaches the runtime anyway.
      if ((logical & 3) !== 0) return 0;
      const access = resolveDataReservationAccess(logical, false);
      if (access === null) return 0;

      view.setUint32(pointer, view.getUint32(access.pointer, false), true);
      if (access.lockedPointer !== null) {
        lockedCacheReads += 1;
        lockedCacheReadBytes += 4;
      }
      dataReservationPhysicalGranule = dataReservationGranule(access.physical);
      return 1;
    }

    function storeConditionalInteger(address, value) {
      const logical = address >>> 0;
      // As with lwarx, alignment is architecturally handled in compiled code.
      if ((logical & 3) !== 0) return 0;

      // Resolve and commit page history before consulting the reservation.
      // A permitted failed conditional store therefore still sets PTE R+C.
      const translation = resolveDataReservationTranslation(
        logical,
        true,
        value
      );
      if (translation === null) return 0;
      if (dataReservationPhysicalGranule === null) return 1;
      const access = resolveDataReservationBacking(translation, true, value);
      if (access === null) return 0;

      view.setUint32(access.pointer, value >>> 0, false);
      if (access.lockedPointer !== null) {
        lockedCacheWrites += 1;
        lockedCacheWriteBytes += 4;
      }
      // MPC750 stwcx. is nonspecific: any live reservation permits the store.
      dataReservationPhysicalGranule = null;
      return 2;
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

    function invalidateLockedCacheReservationForExternalWrite(
      cacheAddress,
      length
    ) {
      let invalidated = false;
      let visited = 0;
      while (visited < length) {
        const offset = (cacheAddress + visited) & (lockedCacheSize - 1);
        const chunk = Math.min(length - visited, lockedCacheSize - offset);
        invalidated = invalidateDataReservationForExternalWrite(
          (0xe0000000 + offset) >>> 0,
          chunk
        ) || invalidated;
        visited += chunk;
      }
      return invalidated;
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
          invalidateLockedCacheReservationForExternalWrite(
            cacheAddress,
            length
          );
          copyToLockedCache(cacheAddress, ramTarget, length);
          lockedCacheDmaFromRam += 1;
        } else {
          invalidateDataReservationForExternalWrite(
            (ramTarget - ram) >>> 0,
            length
          );
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
      const x = Math.fround(position[0]);
      const y = Math.fround(position[1]);
      const z = Math.fround(position[2]);
      const transformed = [];
      for (let row = 0; row < 3; row += 1) {
        const offset = row * 4;
        let value = Math.fround(matrix[offset] * x);
        value = Math.fround(
          value + Math.fround(matrix[offset + 1] * y)
        );
        value = Math.fround(
          value + Math.fround(matrix[offset + 2] * z)
        );
        value = Math.fround(value + matrix[offset + 3]);
        transformed.push(value);
      }
      return transformed;
    }

    function gxCullF32(value) {
      return Math.fround(value);
    }

    function gxCullMul(left, right) {
      return gxCullF32(gxCullF32(left) * gxCullF32(right));
    }

    function gxCullDiv(left, right) {
      return gxCullF32(gxCullF32(left) / gxCullF32(right));
    }

    function gxCullAdd(left, right) {
      return gxCullF32(gxCullF32(left) + gxCullF32(right));
    }

    function gxCullSub(left, right) {
      return gxCullF32(gxCullF32(left) - gxCullF32(right));
    }

    function gxCullDot4Position(matrix, offset, x, y, z, w) {
      return gxCullAdd(
        gxCullAdd(
          gxCullAdd(
            gxCullMul(matrix[offset], x),
            gxCullMul(matrix[offset + 1], y)
          ),
          gxCullMul(matrix[offset + 2], z)
        ),
        gxCullMul(matrix[offset + 3], w)
      );
    }

    function gxCullDot4(row, vector) {
      return gxCullDot4Position(
        row,
        0,
        vector[0],
        vector[1],
        vector[2],
        vector[3]
      );
    }

    function gxCullTransformState() {
      const projection = Array.from({ length: 6 }, (_unused, index) =>
        gxXfFloat(0x1020 + index)
      );
      const projectionType = gxXfRegisters[0x1026] >>> 0;
      if (
        projection.some(value => !Number.isFinite(value))
        || (projectionType !== 0 && projectionType !== 1)
      ) {
        return null;
      }
      return {
        projection,
        projectionType,
        positionMatrices: Array(64),
      };
    }

    function gxCullPositionMatrix(state, matrixIndex) {
      if (
        state === null
        || !Number.isInteger(matrixIndex)
        || matrixIndex < 0
        || (matrixIndex + 2) * 4 + 3 >= 0x100
      ) {
        return null;
      }
      const cached = state.positionMatrices[matrixIndex];
      if (cached !== undefined) return cached;
      const matrix = Array.from({ length: 12 }, (_unused, index) =>
        gxXfFloat(matrixIndex * 4 + index)
      );
      const valid = (
        matrix.every(Number.isFinite)
        && matrix.some(value => value !== 0)
      );
      state.positionMatrices[matrixIndex] = valid ? matrix : null;
      return state.positionMatrices[matrixIndex];
    }

    function gxCullViewPosition(
      position,
      matrixIndex,
      state = gxCullTransformState()
    ) {
      const matrix = gxCullPositionMatrix(state, matrixIndex);
      if (matrix === null) return null;
      const x = gxCullF32(position[0]);
      const y = gxCullF32(position[1]);
      const z = gxCullF32(position[2]);
      const transformed = [
        gxCullDot4Position(matrix, 0, x, y, z, 1),
        gxCullDot4Position(matrix, 4, x, y, z, 1),
        gxCullDot4Position(matrix, 8, x, y, z, 1),
      ];
      return transformed.every(Number.isFinite) ? transformed : null;
    }

    function gxTransformNormalVector(vector, matrixIndex) {
      if (vector === null || vector === undefined) return null;
      const base = 0x400 + (matrixIndex % 32) * 3;
      if (base + 8 >= gxXfRegisters.length) return null;
      const matrix = Array.from({ length: 9 }, (_unused, index) =>
        gxXfFloat(base + index)
      );
      if (matrix.some(value => !Number.isFinite(value)) || matrix.every(value => value === 0)) {
        return null;
      }
      const x = Math.fround(vector[0]);
      const y = Math.fround(vector[1]);
      const z = Math.fround(vector[2]);
      const transformed = [];
      for (let row = 0; row < 3; row += 1) {
        const offset = row * 3;
        let value = Math.fround(matrix[offset] * x);
        value = Math.fround(
          value + Math.fround(matrix[offset + 1] * y)
        );
        value = Math.fround(
          value + Math.fround(matrix[offset + 2] * z)
        );
        transformed.push(value);
      }
      return transformed;
    }

    function gxTransformNormal(vector, matrixIndex) {
      const transformed = gxTransformNormalVector(vector, matrixIndex);
      if (transformed === null) return null;
      let lengthSquared = Math.fround(
        transformed[0] * transformed[0]
      );
      lengthSquared = Math.fround(
        lengthSquared + Math.fround(transformed[1] * transformed[1])
      );
      lengthSquared = Math.fround(
        lengthSquared + Math.fround(transformed[2] * transformed[2])
      );
      const length = Math.fround(Math.sqrt(lengthSquared));
      // Common::Vec3::Normalized divides even when the length is zero.
      // Preserve the resulting NaNs so lighting can reject them only when
      // the active channel actually consumes its normal.
      return transformed.map(value => Math.fround(value / length));
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
      const scaleRegister = 0x30 + texgenIndex * 2;
      result = [
        Math.fround(
          Math.fround(result[0]) * ((gxBpRegisters[scaleRegister] & 0xffff) + 1)
        ),
        Math.fround(
          Math.fround(result[1]) * ((gxBpRegisters[scaleRegister + 1] & 0xffff) + 1)
        ),
        result[2],
      ];
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

    function gxXfColorU8(address) {
      const value = gxXfRegisters[address] >>> 0;
      return [
        value >>> 24,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
      ];
    }

    function gxXfLight(index) {
      const base = 0x603 + index * 0x10;
      if (base + 12 >= gxXfRegisters.length) return null;
      const light = {
        color: gxXfColorU8(base),
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
      return gxCullAdd(
        gxCullAdd(
          gxCullMul(left[0], right[0]),
          gxCullMul(left[1], right[1])
        ),
        gxCullMul(left[2], right[2])
      );
    }

    function gxVectorSubtract(left, right) {
      return [
        gxCullSub(left[0], right[0]),
        gxCullSub(left[1], right[1]),
        gxCullSub(left[2], right[2]),
      ];
    }

    function gxLightNormalize3(vector) {
      const length = gxCullF32(Math.sqrt(gxDot3(vector, vector)));
      return vector.map(value => gxCullDiv(value, length));
    }

    function gxLightMaxZero(value) {
      return value > 0 ? gxCullF32(value) : 0;
    }

    function gxLightSafeDivide(numerator, denominator) {
      const n = gxCullF32(numerator);
      const d = gxCullF32(denominator);
      return d === 0 ? (n > 0 ? 1 : 0) : gxCullDiv(n, d);
    }

    function gxLightDiffuse(control, direction, normal) {
      const mode = (control >>> 7) & 3;
      if (mode === 0) return 1;
      if (mode === 3) return null;
      const value = gxDot3(direction, normal);
      return mode === 2 ? gxLightMaxZero(value) : value;
    }

    function gxLightSpotCosPolynomial(coefficients, value) {
      return gxCullAdd(
        gxCullAdd(
          coefficients[0],
          gxCullMul(coefficients[1], value)
        ),
        gxCullMul(gxCullMul(coefficients[2], value), value)
      );
    }

    function gxLightSpotDistancePolynomial(
      coefficients, distance, distanceSquared
    ) {
      return gxCullAdd(
        gxCullAdd(
          coefficients[0],
          gxCullMul(coefficients[1], distance)
        ),
        gxCullMul(coefficients[2], distanceSquared)
      );
    }

    function gxLightPosition(control, light, position, normal) {
      let direction = gxVectorSubtract(light.position, position);
      let attenuation = 1;
      const attenuationMode = (control >>> 9) & 3;
      if (attenuationMode === 0 || attenuationMode === 2) {
        direction = gxLightNormalize3(direction);
        if (direction.every(value => value === 0)) {
          direction = normal.slice();
        }
      } else if (attenuationMode === 1) {
        direction = gxLightNormalize3(direction);
        const normalDotDirection = gxDot3(direction, normal);
        attenuation = normalDotDirection >= 0
          ? gxLightMaxZero(gxDot3(light.direction, normal))
          : 0;
        const attenuationLength = [
          1,
          attenuation,
          gxCullMul(attenuation, attenuation),
        ];
        const distanceAttenuation = ((control >>> 7) & 3) === 0
          ? light.distAtten
          : gxLightNormalize3(light.distAtten);
        attenuation = gxLightSafeDivide(
          gxLightMaxZero(gxDot3(attenuationLength, light.cosAtten)),
          gxDot3(attenuationLength, distanceAttenuation)
        );
      } else {
        const distanceSquared = gxDot3(direction, direction);
        const distance = gxCullF32(Math.sqrt(distanceSquared));
        direction = direction.map(value => gxCullDiv(value, distance));
        const angularValue = gxLightMaxZero(gxDot3(direction, light.direction));
        const numerator = gxLightMaxZero(
          gxLightSpotCosPolynomial(light.cosAtten, angularValue)
        );
        const denominator = gxLightSpotDistancePolynomial(
          light.distAtten,
          distance,
          distanceSquared
        );
        attenuation = gxLightSafeDivide(numerator, denominator);
      }
      if (!Number.isFinite(attenuation)) return null;
      return { attenuation: gxCullF32(attenuation), direction };
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
      let lightFunction = gxCullF32((control & (1 << 6)) !== 0
        ? vertexColor[component]
        : ambient[component]);
      for (let lightIndex = 0; lightIndex < 8; lightIndex += 1) {
        if (!gxChannelLightEnabled(control, lightIndex)) continue;
        if (position === null) return null;
        const diffuseMode = (control >>> 7) & 3;
        const attenuationMode = (control >>> 9) & 3;
        const normalIsRequired = (
          diffuseMode !== 0
          || attenuationMode === 1
        );
        if (normalIsRequired && normal === null) return null;
        const effectiveNormal = normal ?? [Number.NaN, Number.NaN, Number.NaN];
        const light = gxXfLight(lightIndex);
        if (light === null) return null;
        const lightPosition = gxLightPosition(
          control, light, position, effectiveNormal
        );
        if (lightPosition === null) return null;
        const diffuse = gxLightDiffuse(
          control, lightPosition.direction, effectiveNormal
        );
        if (diffuse === null) return null;
        let contribution;
        if (diffuseMode === 0) {
          contribution = gxCullMul(
            light.color[component],
            lightPosition.attenuation
          );
        } else if (component === 3) {
          contribution = gxCullMul(
            gxCullMul(
              light.color[component],
              lightPosition.attenuation
            ),
            diffuse
          );
        } else {
          contribution = gxCullMul(
            light.color[component],
            gxCullMul(lightPosition.attenuation, diffuse)
          );
        }
        lightFunction = gxCullAdd(
          lightFunction,
          contribution
        );
      }
      if (
        !Number.isFinite(lightFunction)
        || lightFunction < -0x80000000
        || lightFunction >= 0x80000000
      ) {
        return null;
      }
      const lightInteger = Math.max(0, Math.min(255, Math.trunc(lightFunction)));
      return (
        materialValue * (lightInteger + (lightInteger >> 7))
      ) >> 8;
    }

    function gxLightRasterChannels(position, normal, colors) {
      if (
        !Array.isArray(colors)
        || colors.length < 2
        || colors.some(color =>
          !Array.isArray(color)
          || color.length < 4
          || color.some(value =>
            !Number.isInteger(value) || value < 0 || value > 255
          )
        )
      ) {
        return null;
      }
      const transformedPosition = position === null
        ? null
        : position.map(gxCullF32);
      const transformedNormal = normal === null
        ? null
        : normal.map(gxCullF32);
      const channels = [];
      for (let channel = 0; channel < 2; channel += 1) {
        const vertexColor = colors[channel];
        const material = gxXfColorU8(0x100c + channel);
        const ambient = gxXfColorU8(0x100a + channel);
        const colorControl = gxXfRegisters[0x100e + channel] >>> 0;
        const alphaControl = gxXfRegisters[0x1010 + channel] >>> 0;
        const bytes = [
          gxLightChannelComponent(
            colorControl, 0, material, ambient, vertexColor,
            transformedPosition, transformedNormal
          ),
          gxLightChannelComponent(
            colorControl, 1, material, ambient, vertexColor,
            transformedPosition, transformedNormal
          ),
          gxLightChannelComponent(
            colorControl, 2, material, ambient, vertexColor,
            transformedPosition, transformedNormal
          ),
          gxLightChannelComponent(
            alphaControl, 3, material, ambient, vertexColor,
            transformedPosition, transformedNormal
          ),
        ];
        if (bytes.some(value => value === null)) return null;
        channels.push(bytes.map(value => gxCullDiv(value, 255)));
      }
      return channels;
    }

    function gxTextureRegisters(textureMap) {
      const slot = textureMap & 3;
      const bank = textureMap >= 4 ? 0x20 : 0;
      return {
        mode0: 0x80 + bank + slot,
        mode1: 0x84 + bank + slot,
        image0: 0x88 + bank + slot,
        image1: 0x8c + bank + slot,
        image2: 0x90 + bank + slot,
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

    function gxRecordXfbCopyGeneration(frame) {
      if (!frame.captured) return;
      gxXfbCopyDestinations.delete(frame.destination);
      gxXfbCopyDestinations.set(frame.destination, frame);
      if (gxXfbCopyDestinations.size > 16) {
        gxXfbCopyDestinations.delete(gxXfbCopyDestinations.keys().next().value);
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
      if (
        !gxTextureCopyConsumers.has(address)
        && !gxTextureCopyIsBound(address)
      ) {
        return false;
      }
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
        const source = gxTextureImageSource(
          gxBpRegisters[registers.image1],
          gxBpRegisters[registers.image2],
          gxBpRegisters[registers.image3]
        );
        if (source.kind !== "main-memory") continue;
        if (source.address === address) return true;
        const image0 = gxBpRegisters[registers.image0];
        const width = (image0 & 0x3ff) + 1;
        const height = ((image0 >>> 10) & 0x3ff) + 1;
        const layout = gxTextureLayout((image0 >>> 20) & 0xf);
        if (
          layout === null
          || width > 1024
          || height > 1024
          || width * height > 1_048_576
        ) {
          continue;
        }
        const mipChain = gxTextureMipChainLayout(
          width,
          height,
          layout,
          gxBpRegisters[registers.mode0],
          gxBpRegisters[registers.mode1]
        );
        if (mipChain === null || mipChain.levelCount <= 1) continue;
        const relativeAddress = (address >>> 0) - (source.address >>> 0);
        if (
          relativeAddress >= mipChain.levels[1].encodedOffset
          && relativeAddress < mipChain.encodedBytes
        ) {
          return true;
        }
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

    function gxTextureMipCount(width, height, mode0, mode1) {
      const mipMode = (mode0 >>> 5) & 3;
      if (mipMode === 0) return 1;
      if (mipMode === 3) return null;
      const theoreticalLevels = Math.floor(Math.log2(Math.max(width, height))) + 1;
      const maxLodRaw = (mode1 >>> 8) & 0xff;
      const requestedLevels = Math.ceil(maxLodRaw / 16) + 1;
      return Math.min(theoreticalLevels, requestedLevels);
    }

    // Live V7 activation snapshots this result from the raw BP words before
    // gxTextureSamplerState canonicalizes legacy V6 sampling state.
    function gxStrictV7TexturePreflight(rawMode0, rawMode1, format, width, height) {
      const reject = reason => ({ accepted: false, reason });
      const isUint32 = value =>
        Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
      if (!isUint32(rawMode0)) return reject("invalid-mode0");
      if (!isUint32(rawMode1)) return reject("invalid-mode1");
      if ((rawMode0 & (~0x0039ffff >>> 0)) !== 0) {
        return reject("noncanonical-mode0-bits");
      }
      if ((rawMode1 & (~0x0000ffff >>> 0)) !== 0) {
        return reject("noncanonical-mode1-bits");
      }

      const mode0 = rawMode0 >>> 0;
      const mode1 = rawMode1 >>> 0;
      const minFilter = (mode0 >>> 5) & 7;
      const mipMode = minFilter & 3;
      if (mipMode === 3) return reject("reserved-min-filter");
      if ((mode0 & (1 << 21)) !== 0) {
        return reject("unsupported-lod-bias-clamp");
      }
      const anisotropyRaw = (mode0 >>> 19) & 3;
      if (anisotropyRaw === 3) return reject("reserved-anisotropy");
      if (anisotropyRaw !== 0) return reject("unsupported-anisotropy");

      const supportedFormat =
        Number.isInteger(format)
        && (
          (format >= 0 && format <= 6)
          || format === 8
          || format === 9
          || format === 10
          || format === 14
        );
      if (!supportedFormat) return reject("unsupported-texture-format");
      if (
        !Number.isInteger(width)
        || !Number.isInteger(height)
        || width < 1
        || height < 1
        || width > 1024
        || height > 1024
      ) {
        return reject("invalid-texture-dimensions");
      }

      const usesMipFilter = mipMode !== 0;
      const powerOfTwo = value => (value & (value - 1)) === 0;
      const wrapS = mode0 & 3;
      const wrapT = (mode0 >>> 2) & 3;
      if ((wrapS === 1 || wrapS === 2) && !powerOfTwo(width)) {
        return reject("wrap-s-requires-power-of-two-width");
      }
      if ((wrapT === 1 || wrapT === 2) && !powerOfTwo(height)) {
        return reject("wrap-t-requires-power-of-two-height");
      }
      if (usesMipFilter && (!powerOfTwo(width) || !powerOfTwo(height))) {
        return reject("mipped-texture-must-be-power-of-two");
      }
      if ((format === 8 || format === 9 || format === 10) && mipMode === 2) {
        return reject("ci-texture-cannot-use-mip-linear");
      }

      const levelCount = gxTextureMipCount(width, height, mode0, mode1);
      if (!Number.isInteger(levelCount) || levelCount < 1) {
        return reject("invalid-mip-state");
      }

      const lodMinRaw = mode1 & 0xff;
      const lodMaxRaw = (mode1 >>> 8) & 0xff;
      const residentMax = Math.min(0xff, (levelCount - 1) * 16);
      const effectiveLodMaxRaw = usesMipFilter
        ? Math.min(lodMaxRaw, residentMax)
        : 0;
      const effectiveLodMinRaw = usesMipFilter
        ? Math.min(lodMinRaw, effectiveLodMaxRaw)
        : 0;
      const lodBiasRaw = (mode0 >>> 9) & 0xff;
      const signedLodBiasRaw = lodBiasRaw < 0x80
        ? lodBiasRaw
        : lodBiasRaw - 0x100;
      return {
        accepted: true,
        classification: usesMipFilter && levelCount > 1
          ? "genuine-mip"
          : "base-only-companion",
        mode0,
        mode1,
        format,
        width,
        height,
        levelCount,
        minFilter,
        mipMode,
        magLinear: (mode0 & (1 << 4)) !== 0,
        minLinear: (mode0 & (1 << 7)) !== 0,
        diagonalLod: (mode0 & (1 << 8)) !== 0,
        lodBiasRaw,
        lodBiasSixteenths: usesMipFilter ? signedLodBiasRaw >> 1 : 0,
        lodMinRaw,
        lodMaxRaw,
        effectiveLodMinRaw,
        effectiveLodMaxRaw,
        wrapS,
        wrapT,
      };
    }

    function gxTextureMipChainLayout(width, height, layout, mode0, mode1) {
      const levelCount = gxTextureMipCount(width, height, mode0, mode1);
      if (levelCount === null) return null;
      const levels = [];
      let levelWidth = width;
      let levelHeight = height;
      let encodedOffset = 0;
      let decodedOffset = 0;
      for (let level = 0; level < levelCount; level += 1) {
        const blocksWide = Math.ceil(levelWidth / layout.blockWidth);
        const blocksHigh = Math.ceil(levelHeight / layout.blockHeight);
        const encodedBytes = blocksWide * blocksHigh * layout.blockBytes;
        const decodedBytes = levelWidth * levelHeight * 4;
        levels.push({
          level,
          width: levelWidth,
          height: levelHeight,
          blocksWide,
          blocksHigh,
          encodedOffset,
          encodedBytes,
          decodedOffset,
          decodedBytes,
        });
        encodedOffset += encodedBytes;
        decodedOffset += decodedBytes;
        levelWidth = Math.max(1, Math.floor(levelWidth / 2));
        levelHeight = Math.max(1, Math.floor(levelHeight / 2));
      }
      return {
        levelCount,
        levels,
        encodedBytes: encodedOffset,
        decodedBytes: decodedOffset,
      };
    }

    function gxTextureImageSource(image1, image2, image3) {
      if ((image1 & 0x00200000) !== 0) {
        return {
          kind: "preloaded-tmem",
          evenTmemRegister: image1 >>> 0,
          oddTmemRegister: image2 >>> 0,
        };
      }
      return {
        kind: "main-memory",
        address: (image3 << 5) >>> 0,
      };
    }

    function gxCopyTextureLayout(copyCommand, pixelControl) {
      const copyFormat = (
        ((copyCommand & 0x08) !== 0 ? 8 : 0)
        | ((copyCommand >>> 4) & 7)
      );
      const depthCopy = (pixelControl & 7) === 3;
      let textureFormat;
      if (depthCopy) {
        switch (copyFormat) {
          case 0: textureFormat = 0; break;
          case 1: case 8: case 9: case 10: textureFormat = 1; break;
          case 3: case 11: case 12: textureFormat = 3; break;
          case 6: textureFormat = 6; break;
        }
      } else {
        switch (copyFormat) {
          case 0: textureFormat = 0; break;
          case 1: case 7: case 8: case 9: case 10: textureFormat = 1; break;
          case 2: textureFormat = 2; break;
          case 3: case 11: case 12: textureFormat = 3; break;
          case 4: case 5: textureFormat = 4; break;
          case 6: textureFormat = 6; break;
        }
      }
      return textureFormat === undefined ? null : gxTextureLayout(textureFormat);
    }

    function invalidateGxCopyReservation(frame) {
      if (frame.copyToXfb) {
        return invalidateDataReservationForExternalStridedWrite(
          frame.destination,
          frame.width * 2,
          frame.stride,
          frame.height
        );
      }

      const layout = gxCopyTextureLayout(
        frame.copyState.copyCommand,
        frame.copyState.pixelControl
      );
      if (layout === null) {
        // Reserved copy formats do not provide a bounded destination shape.
        return invalidateDataReservationForExternalWrite(
          frame.destination,
          Number.NaN
        );
      }
      const divisor = (frame.copyState.copyCommand & 0x200) !== 0 ? 2 : 1;
      const width = Math.floor(frame.width / divisor);
      const height = Math.floor(frame.sourceHeight / divisor);
      if (width === 0 || height === 0) return false;
      const blockColumns = Math.ceil(width / layout.blockWidth);
      const blockRows = Math.ceil(height / layout.blockHeight);
      return invalidateDataReservationForExternalStridedWrite(
        frame.destination,
        blockColumns * layout.blockBytes,
        frame.stride,
        blockRows
      );
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

    function gxTextureSamplerState(mode0, mode1) {
      const canonicalMode0 = (mode0 & 0x0039ffff) >>> 0;
      const canonicalMode1 = (mode1 & 0xffff) >>> 0;
      return {
        mode0: canonicalMode0,
        mode1: canonicalMode1,
        wrapS: canonicalMode0 & 3,
        wrapT: (canonicalMode0 >>> 2) & 3,
        magFilter: (canonicalMode0 >>> 4) & 1,
        minFilter: (canonicalMode0 >>> 5) & 7,
        maxAnisotropy: (canonicalMode0 >>> 19) & 3,
      };
    }

    function gxTextureLowerMipCopyGeneration(address, mipChain) {
      if (mipChain.levelCount <= 1) return null;
      const lowerMipOffset = mipChain.levels[1].encodedOffset;
      for (const [destination, generation] of gxTextureCopyDestinations) {
        const relativeAddress = (destination >>> 0) - (address >>> 0);
        if (
          relativeAddress >= lowerMipOffset
          && relativeAddress < mipChain.encodedBytes
        ) {
          return { address: destination >>> 0, generation };
        }
      }
      return null;
    }

    function gxDecodeTextureLevel(
      pixels,
      level,
      format,
      layout,
      source,
      paletteOffset,
      paletteFormat
    ) {
      const width = level.width;
      const height = level.height;
      let blockOffset = level.encodedOffset;
      for (let blockY = 0; blockY < level.blocksHigh; blockY += 1) {
        for (let blockX = 0; blockX < level.blocksWide; blockX += 1) {
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
    }

    function gxDecodeTexture(textureMap) {
      const registers = gxTextureRegisters(textureMap);
      const image0 = gxBpRegisters[registers.image0];
      const rawMode0 = gxBpRegisters[registers.mode0];
      const rawMode1 = gxBpRegisters[registers.mode1];
      const width = (image0 & 0x3ff) + 1;
      const height = ((image0 >>> 10) & 0x3ff) + 1;
      const format = (image0 >>> 20) & 0xf;
      const strictV7Preflight = gxStrictV7TexturePreflight(
        rawMode0,
        rawMode1,
        format,
        width,
        height
      );
      const sampler = gxTextureSamplerState(rawMode0, rawMode1);
      const layout = gxTextureLayout(format);
      if (layout === null || width > 1024 || height > 1024 || width * height > 1_048_576) {
        gxTextureDecodeErrors += 1;
        return null;
      }
      const mipChain = gxTextureMipChainLayout(
        width,
        height,
        layout,
        rawMode0,
        rawMode1
      );
      if (mipChain === null) {
        // MODE0 mip mode 3 is reserved. Do not silently reinterpret it as a
        // base-only or MODE1-selected source chain.
        gxTextureDecodeErrors += 1;
        return null;
      }
      const imageSource = gxTextureImageSource(
        gxBpRegisters[registers.image1],
        gxBpRegisters[registers.image2],
        gxBpRegisters[registers.image3]
      );
      if (imageSource.kind === "preloaded-tmem") {
        // IMAGE3 is not a main-memory address when IMAGE1 selects manually
        // managed/preloaded TMEM. Reject that path until its even/odd TMEM
        // banks are modeled instead of decoding unrelated DRAM.
        gxTextureDecodeErrors += 1;
        return null;
      }
      const address = imageSource.address;
      const textureCopyIndex = gxTextureCopyDestinations.get(address);
      if (gxTextureLowerMipCopyGeneration(address, mipChain) !== null) {
        // LZGX transport identifies only the base texture-copy generation. A
        // copied EFB surface inside a lower level would otherwise be silently
        // decoded as unrelated RAM and cached under incomplete provenance.
        gxTextureDecodeErrors += 1;
        return null;
      }
      for (const level of mipChain.levels) {
        gxMarkTextureCopyConsumer((address + level.encodedOffset) >>> 0);
      }
      const encodedBytes = mipChain.encodedBytes;
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
      const key = [
        textureMap, address, width, height, format, mipChain.levelCount, hash,
        paletteOffset, paletteFormat, paletteHash, textureCopyIndex ?? "ram",
      ].join(":");
      const cached = gxTextureCache.get(key);
      if (cached !== undefined) {
        gxTextureCacheHits += 1;
        // Sampling state is draw state, not decoded-image identity. Return a
        // fresh snapshot so a BP mode change cannot rewrite an earlier draw or
        // inherit the sampler from the cache entry's first decode.
        return { ...cached, ...sampler, strictV7Preflight };
      }

      const mipPixels = new Uint8ClampedArray(mipChain.decodedBytes);
      const mipLevels = mipChain.levels.map(level => {
        const pixels = mipPixels.subarray(
          level.decodedOffset,
          level.decodedOffset + level.decodedBytes
        );
        gxDecodeTextureLevel(
          pixels,
          level,
          format,
          layout,
          source,
          paletteOffset,
          paletteFormat
        );
        return { ...level, pixels };
      });
      const pixels = mipLevels[0].pixels;

      const texture = {
        key,
        map: textureMap,
        address,
        width,
        height,
        format,
        formatName: layout.name,
        levelCount: mipChain.levelCount,
        encodedBytes,
        hash: "0x" + hash.toString(16).padStart(8, "0"),
        ...sampler,
        strictV7Preflight,
        pixels,
        mipPixels,
        mipLevels,
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
      gxTextureDecodedBytes += mipPixels.byteLength;
      gxTextureFormatCounts.set(
        layout.name,
        (gxTextureFormatCounts.get(layout.name) ?? 0) + 1
      );
      gxTextureCache.set(key, texture);
      return texture;
    }

    function gxTextureSummary(texture) {
      if (texture === null) return null;
      const {
        pixels: _pixels,
        mipPixels: _mipPixels,
        mipLevels,
        ...summary
      } = texture;
      if (mipLevels === undefined) return summary;
      return {
        ...summary,
        mipLevels: mipLevels.map(({ pixels: _levelPixels, ...level }) => level),
      };
    }

    function gxTextureBaseOnly(texture, pixels) {
      const {
        pixels: _pixels,
        mipPixels: _mipPixels,
        mipLevels,
        ...base
      } = texture;
      const mode0 = (texture.mode0 & ~(3 << 5)) >>> 0;
      return {
        ...base,
        mode0,
        mode1: 0,
        levelCount: 1,
        encodedBytes: mipLevels?.[0]?.encodedBytes ?? texture.encodedBytes,
        minFilter: (mode0 >>> 5) & 7,
        pixels,
      };
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
      // Flipper expands C from 0..255 to 0..256 and performs the interpolation
      // in fixed point. Scaling the numerator before its arithmetic shift is
      // observable at scale two and four.
      c += c >> 7;
      const bias = (combiner >>> 16) & 3;
      if (bias === 1) d += 128;
      if (bias === 2) d -= 128;
      const subtract = ((combiner >>> 18) & 1) !== 0;
      const scale = (combiner >>> 20) & 3;
      let mixed = (a << 8) + (b - a) * c;
      if (scale !== 3) {
        mixed <<= scale;
        d <<= scale;
        mixed += subtract ? 127 : 128;
      }
      mixed >>= 8;
      let result = subtract ? d - mixed : d + mixed;
      // Divide-by-two is the one scale mode without a rounding bias.
      if (scale === 3) result >>= 1;
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
        ...gxTextureBaseOnly(primary.texture, pixels),
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
      };
      gxTevTextureCache.set(renderKey, rendered);
      return { texture: rendered, texCoordIndex: primary.texCoordIndex, stages: stageSummaries };
    }

    function gxProjectPosition(position, matrixIndex) {
      return gxProjectViewPosition(gxTransformPosition(position, matrixIndex));
    }

    function gxProjectViewPosition(viewPosition) {
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
      if (![clipX, clipY, clipZ, clipW].every(Number.isFinite) || clipW === 0) {
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
      const projected = [
        clipX / clipW * viewport[0] + viewport[3] - scissorX * 2,
        clipY / clipW * viewport[1] + viewport[4] - scissorY * 2,
        clipZ / clipW * viewport[2] + viewport[5],
        clipW,
      ];
      const projectedF32 = projected.map(value => Math.fround(value));
      return (
        projectedF32.every(Number.isFinite)
        && projectedF32[3] !== 0
      )
        ? projected
        : null;
    }

    function gxCullClipPosition(
      position,
      matrixIndex,
      state = gxCullTransformState()
    ) {
      const viewPosition = gxCullViewPosition(position, matrixIndex, state);
      if (viewPosition === null || state === null) return null;
      const [viewX, viewY, viewZ] = viewPosition;
      const projection = state.projection;
      let clip;
      if (state.projectionType === 0) {
        clip = [
          gxCullAdd(gxCullMul(projection[0], viewX), gxCullMul(projection[1], viewZ)),
          gxCullAdd(gxCullMul(projection[2], viewY), gxCullMul(projection[3], viewZ)),
          gxCullAdd(gxCullMul(projection[4], viewZ), projection[5]),
          gxCullF32(-viewZ),
        ];
      } else {
        clip = [
          gxCullAdd(gxCullMul(projection[0], viewX), projection[1]),
          gxCullAdd(gxCullMul(projection[2], viewY), projection[3]),
          gxCullAdd(gxCullMul(projection[4], viewZ), projection[5]),
          1,
        ];
      }
      return clip.every(Number.isFinite) ? clip : null;
    }

    // This is the scalar-f32 software projection oracle used by the clipping
    // bring-up. Keep it separate from the live f64 vertex path until packets
    // can carry and the renderer can validate complete clipped geometry.
    function gxExactClipViewPosition(
      viewPosition,
      state = gxCullTransformState()
    ) {
      if (
        !Array.isArray(viewPosition)
        || viewPosition.length !== 3
        || viewPosition.some(value => !Number.isFinite(value))
        || state === null
        || !Array.isArray(state.projection)
        || state.projection.length !== 6
        || state.projection.some(value => !Number.isFinite(value))
        || (state.projectionType !== 0 && state.projectionType !== 1)
      ) {
        return null;
      }
      const viewX = gxCullF32(viewPosition[0]);
      const viewY = gxCullF32(viewPosition[1]);
      const viewZ = gxCullF32(viewPosition[2]);
      const projection = state.projection;
      let clip;
      if (state.projectionType === 0) {
        const depth = gxCullAdd(
          gxCullMul(projection[4], viewZ),
          projection[5]
        );
        clip = [
          gxCullAdd(gxCullMul(projection[0], viewX), gxCullMul(projection[1], viewZ)),
          gxCullAdd(gxCullMul(projection[2], viewY), gxCullMul(projection[3], viewZ)),
          gxCullMul(depth, gxCullSub(1, gxCullF32(1e-7))),
          gxCullF32(-viewZ),
        ];
      } else if (state.projectionType === 1) {
        clip = [
          gxCullAdd(gxCullMul(projection[0], viewX), projection[1]),
          gxCullAdd(gxCullMul(projection[2], viewY), projection[3]),
          gxCullAdd(gxCullMul(projection[4], viewZ), projection[5]),
          1,
        ];
      } else {
        return null;
      }
      return clip.every(Number.isFinite) ? clip : null;
    }

    function gxExactClipPosition(
      position,
      matrixIndex,
      state = gxCullTransformState()
    ) {
      if (
        !Array.isArray(position)
        || position.length !== 3
        || position.some(value => !Number.isFinite(value))
        || !Number.isInteger(matrixIndex)
        || state === null
        || !Array.isArray(state.positionMatrices)
      ) {
        return null;
      }
      const viewPosition = gxCullViewPosition(position, matrixIndex, state);
      return viewPosition === null
        ? null
        : gxExactClipViewPosition(viewPosition, state);
    }

    function gxExactNoWrapScissorAxisOffset(
      start,
      end,
      baseOffset,
      dimension
    ) {
      if (
        !Number.isInteger(start)
        || !Number.isInteger(end)
        || !Number.isInteger(baseOffset)
        || !Number.isInteger(dimension)
        || start < 0
        || end < start
        || baseOffset < 0
        || dimension <= 0
      ) {
        return null;
      }
      let count = 0;
      for (let extraOffset = -4096; extraOffset <= 4096; extraOffset += 1024) {
        const offset = baseOffset + extraOffset;
        const clippedStart = Math.max(0, Math.min(dimension, start - offset));
        const clippedEnd = Math.max(0, Math.min(dimension, end - offset + 1));
        if (clippedStart >= clippedEnd) continue;
        count += 1;
        if (extraOffset !== 0) return null;
      }
      return count === 1 ? baseOffset : null;
    }

    // The GX scissor can wrap at 1024-pixel intervals and expose more than one
    // EFB rectangle. The first managed clipping layer deliberately certifies
    // only the common single, unwrapped rectangle; wrapped draws remain native.
    function gxExactNoWrapViewportState() {
      const viewport = Array.from({ length: 6 }, (_unused, index) =>
        gxXfFloat(0x101a + index)
      );
      if (viewport.some(value => !Number.isFinite(value))) return null;
      const topLeft = gxBpRegisters[0x20] >>> 0;
      const bottomRight = gxBpRegisters[0x21] >>> 0;
      const scissorOffset = gxBpRegisters[0x59] >>> 0;
      // Hardware ignores the top bit of each nominally ten-bit BP59 field.
      const baseOffsetX = (scissorOffset & 0x1ff) * 2;
      const baseOffsetY = ((scissorOffset >>> 10) & 0x1ff) * 2;
      const scissorOffsetX = gxExactNoWrapScissorAxisOffset(
        (topLeft >>> 12) & 0x7ff,
        (bottomRight >>> 12) & 0x7ff,
        baseOffsetX,
        640
      );
      const scissorOffsetY = gxExactNoWrapScissorAxisOffset(
        topLeft & 0x7ff,
        bottomRight & 0x7ff,
        baseOffsetY,
        528
      );
      if (scissorOffsetX === null || scissorOffsetY === null) return null;
      return {
        viewport,
        scissorOffsetX,
        scissorOffsetY,
      };
    }

    function gxExactNoWrapScreenPosition(
      clipPosition,
      state = gxExactNoWrapViewportState()
    ) {
      if (
        !Array.isArray(clipPosition)
        || clipPosition.length !== 4
        || clipPosition.some(value => !Number.isFinite(value))
        || state === null
        || !Array.isArray(state.viewport)
        || state.viewport.length !== 6
        || state.viewport.some(value => !Number.isFinite(value))
        || !Number.isInteger(state.scissorOffsetX)
        || state.scissorOffsetX < 0
        || state.scissorOffsetX > 1022
        || (state.scissorOffsetX & 1) !== 0
        || !Number.isInteger(state.scissorOffsetY)
        || state.scissorOffsetY < 0
        || state.scissorOffsetY > 1022
        || (state.scissorOffsetY & 1) !== 0
      ) {
        return null;
      }
      const clip = clipPosition.map(gxCullF32);
      const viewport = state.viewport.map(gxCullF32);
      const inverseW = gxCullDiv(1, clip[3]);
      const screen = [
        gxCullSub(
          gxCullAdd(
            gxCullMul(gxCullMul(clip[0], inverseW), viewport[0]),
            viewport[3]
          ),
          state.scissorOffsetX
        ),
        gxCullSub(
          gxCullAdd(
            gxCullMul(gxCullMul(clip[1], inverseW), viewport[1]),
            viewport[4]
          ),
          state.scissorOffsetY
        ),
        gxCullAdd(
          gxCullMul(gxCullMul(clip[2], inverseW), viewport[2]),
          viewport[5]
        ),
        clip[3],
      ];
      return screen.every(Number.isFinite) ? screen : null;
    }

    function gxExactNoWrapProjectPosition(
      position,
      matrixIndex,
      transformState = gxCullTransformState(),
      viewportState = gxExactNoWrapViewportState()
    ) {
      const clip = gxExactClipPosition(position, matrixIndex, transformState);
      return clip === null
        ? null
        : gxExactNoWrapScreenPosition(clip, viewportState);
    }

    function gxExactClipVertexIsValid(vertex, componentCount = null) {
      if (
        !Array.isArray(vertex)
        || vertex.length < 4
        || (componentCount !== null && vertex.length !== componentCount)
      ) {
        return false;
      }
      for (let component = 0; component < vertex.length; component += 1) {
        if (
          !Object.prototype.hasOwnProperty.call(vertex, component)
          || !Number.isFinite(vertex[component])
          || !Number.isFinite(gxCullF32(vertex[component]))
        ) {
          return false;
        }
      }
      return true;
    }

    function gxExactClipVertexListIsValid(
      vertices,
      minimumCount,
      maximumCount = null
    ) {
      if (
        !Array.isArray(vertices)
        || !Number.isInteger(minimumCount)
        || minimumCount < 0
        || vertices.length < minimumCount
        || (
          maximumCount !== null
          && (
            !Number.isInteger(maximumCount)
            || maximumCount < minimumCount
            || vertices.length > maximumCount
          )
        )
      ) {
        return false;
      }
      const componentCount = (
        Object.prototype.hasOwnProperty.call(vertices, 0)
        && Array.isArray(vertices[0])
      )
        ? vertices[0].length
        : 0;
      if (componentCount < 4) return false;
      for (let vertex = 0; vertex < vertices.length; vertex += 1) {
        if (
          !Object.prototype.hasOwnProperty.call(vertices, vertex)
          || !gxExactClipVertexIsValid(vertices[vertex], componentCount)
        ) {
          return false;
        }
      }
      return true;
    }

    function gxExactClipMask(vertex) {
      if (!gxExactClipVertexIsValid(vertex)) return null;
      const x = gxCullF32(vertex[0]);
      const y = gxCullF32(vertex[1]);
      const z = gxCullF32(vertex[2]);
      const w = gxCullF32(vertex[3]);
      let mask = 0;
      if (gxCullSub(w, x) < 0) mask |= 0x01;
      if (gxCullAdd(x, w) < 0) mask |= 0x02;
      if (gxCullSub(w, y) < 0) mask |= 0x04;
      if (gxCullAdd(y, w) < 0) mask |= 0x08;
      if (gxCullMul(w, z) > 0) mask |= 0x10;
      if (gxCullAdd(z, w) < 0) mask |= 0x20;
      return mask;
    }

    function gxExactClipDifferentSigns(left, right) {
      return (
        (left <= 0 && right > 0)
        || (left > 0 && right <= 0)
      );
    }

    function gxExactClipPlaneDistance(vertex, plane) {
      if (
        !gxExactClipVertexIsValid(vertex)
        || !Array.isArray(plane)
        || plane.length !== 4
        || plane.some(
          value => !Number.isFinite(value) || !Number.isFinite(gxCullF32(value))
        )
      ) {
        return null;
      }
      const distance = gxCullDot4(plane, vertex);
      return Number.isFinite(distance) ? distance : null;
    }

    function gxExactClipVertex(t, outVertex, inVertex) {
      if (
        !gxExactClipVertexIsValid(outVertex)
        || !gxExactClipVertexIsValid(inVertex, outVertex.length)
        || !Number.isFinite(t)
      ) {
        return null;
      }
      t = gxCullF32(t);
      if (!Number.isFinite(t) || t < 0 || t > 1) return null;
      const vertex = outVertex.map((outComponent, component) =>
        gxCullAdd(
          outComponent,
          gxCullMul(gxCullSub(inVertex[component], outComponent), t)
        )
      );
      return vertex.every(Number.isFinite) ? vertex : null;
    }

    function gxExactClipPolygon(vertices, mask) {
      if (
        !gxExactClipVertexListIsValid(vertices, 3)
        || !Number.isInteger(mask)
        || mask < 0
        || mask > 0x3f
      ) {
        return null;
      }
      let input = vertices.map(vertex => vertex.map(gxCullF32));
      const planes = [
        [0x01, [-1, 0, 0, 1]],
        [0x02, [1, 0, 0, 1]],
        [0x04, [0, -1, 0, 1]],
        [0x08, [0, 1, 0, 1]],
        // Dolphin's triangle clipper intentionally walks W >= 0 for +Z.
        [0x10, [0, 0, 0, 1]],
        [0x20, [0, 0, 1, 1]],
      ];
      for (const [planeBit, plane] of planes) {
        if ((mask & planeBit) === 0) continue;
        const output = [];
        let previous = input[0];
        let previousDistance = gxExactClipPlaneDistance(previous, plane);
        if (previousDistance === null) return null;
        for (let index = 1; index <= input.length; index += 1) {
          const current = input[index % input.length];
          const distance = gxExactClipPlaneDistance(current, plane);
          if (distance === null) return null;
          if (previousDistance >= 0) output.push(previous);
          if (gxExactClipDifferentSigns(distance, previousDistance)) {
            let t;
            let outVertex;
            let inVertex;
            if (distance < 0) {
              t = gxCullDiv(distance, gxCullSub(distance, previousDistance));
              outVertex = current;
              inVertex = previous;
            } else {
              t = gxCullDiv(
                previousDistance,
                gxCullSub(previousDistance, distance)
              );
              outVertex = previous;
              inVertex = current;
            }
            const intersection = gxExactClipVertex(t, outVertex, inVertex);
            if (intersection === null) return null;
            output.push(intersection);
          }
          previous = current;
          previousDistance = distance;
        }
        if (output.length < 3) return [];
        input = output;
      }
      return input;
    }

    function gxExactTriangulateClipPolygon(polygon) {
      if (
        !gxExactClipVertexListIsValid(polygon, 3)
      ) {
        return null;
      }
      const triangles = [[polygon[0], polygon[1], polygon[2]]];
      for (let vertex = 3; vertex < polygon.length; vertex += 1) {
        triangles.push([polygon[0], polygon[vertex - 1], polygon[vertex]]);
      }
      return triangles;
    }

    function gxExactPostClipTriangles(triangle, cullMode, viewportHeight) {
      if (
        !gxExactClipVertexListIsValid(triangle, 3, 3)
        || !Number.isInteger(cullMode)
        || cullMode < 0
        || cullMode > 3
        || !Number.isFinite(viewportHeight)
      ) {
        return null;
      }
      viewportHeight = gxCullF32(viewportHeight);
      if (!Number.isFinite(viewportHeight) || viewportHeight === 0) return null;
      const masks = triangle.map(gxExactClipMask);
      if (masks.some(mask => mask === null)) return null;
      if ((masks[0] & masks[1] & masks[2]) !== 0) return [];
      const action = gxPostCullActionFromNormal(
        gxCullNormalZ3(triangle[0], triangle[1], triangle[2]),
        cullMode,
        viewportHeight
      );
      if (action === null) return null;
      if ((action & 2) === 0) return [];
      const ordered = (action & 1) === 0
        ? triangle
        : [triangle[0], triangle[2], triangle[1]];
      const polygon = gxExactClipPolygon(
        ordered,
        masks[0] | masks[1] | masks[2]
      );
      if (polygon === null || polygon.length === 0) return polygon;
      return gxExactTriangulateClipPolygon(polygon);
    }

    function gxCullClipPositionIsInside(clip) {
      if (
        !Array.isArray(clip)
        || clip.length !== 4
        || clip.some(value => !Number.isFinite(value))
      ) {
        return false;
      }
      const [x, y, z, w] = clip.map(gxCullF32);
      if (!(w > 0)) return false;
      // Positive W makes the far plane exactly Z <= 0. Comparing Z directly
      // keeps the certification conservative when f32(W * Z) would underflow.
      const planeDistances = [
        gxCullSub(w, x),
        gxCullAdd(x, w),
        gxCullSub(w, y),
        gxCullAdd(y, w),
        z,
        gxCullAdd(z, w),
      ];
      return (
        planeDistances.every(Number.isFinite)
        && planeDistances[0] >= 0
        && planeDistances[1] >= 0
        && planeDistances[2] >= 0
        && planeDistances[3] >= 0
        && planeDistances[4] <= 0
        && planeDistances[5] >= 0
      );
    }

    function gxCullNormalZ3(v0, v1, v2) {
      const term0 = gxCullMul(
        gxCullSub(gxCullMul(v0[0], v2[3]), gxCullMul(v2[0], v0[3])),
        v1[1]
      );
      const term1 = gxCullMul(
        gxCullSub(gxCullMul(v2[0], v0[1]), gxCullMul(v0[0], v2[1])),
        v1[3]
      );
      const term2 = gxCullMul(
        gxCullSub(gxCullMul(v2[1], v0[3]), gxCullMul(v0[1], v2[3])),
        v1[0]
      );
      const normal = gxCullAdd(gxCullAdd(term0, term1), term2);
      return Number.isFinite(normal) ? normal : null;
    }

    function gxCullNormalZ(triangle) {
      if (
        !Array.isArray(triangle)
        || triangle.length !== 3
        || triangle.some(
          clip => !Array.isArray(clip)
            || clip.length !== 4
            || clip.some(value => !Number.isFinite(value))
        )
      ) {
        return null;
      }
      return gxCullNormalZ3(triangle[0], triangle[1], triangle[2]);
    }

    function gxSourceTriangleCount(topology, vertexCount) {
      if (!Number.isInteger(vertexCount) || vertexCount < 0) return 0;
      if (topology === 0 || topology === 1) {
        return Math.floor(vertexCount / 4) * 2 + (vertexCount % 4 === 3 ? 1 : 0);
      }
      if (topology === 2) return Math.floor(vertexCount / 3);
      if (topology === 3 || topology === 4) return Math.max(vertexCount - 2, 0);
      return 0;
    }

    function gxSourceTriangleIndex(topology, vertexCount, triangle, corner) {
      const triangleCount = gxSourceTriangleCount(topology, vertexCount);
      if (
        !Number.isInteger(triangle)
        || triangle < 0
        || triangle >= triangleCount
        || !Number.isInteger(corner)
        || corner < 0
        || corner > 2
      ) {
        return -1;
      }
      if (topology === 0 || topology === 1) {
        const quadTriangles = Math.floor(vertexCount / 4) * 2;
        if (triangle >= quadTriangles) return vertexCount - 3 + corner;
        const base = Math.floor(triangle / 2) * 4;
        if (triangle % 2 === 0) return base + corner;
        return corner === 0 ? base : base + corner + 1;
      }
      if (topology === 2) return triangle * 3 + corner;
      if (topology === 3) {
        const end = triangle + 2;
        if (corner === 0) return end - 2;
        const reverse = end % 2 !== 0;
        return corner === 1
          ? end - (reverse ? 0 : 1)
          : end - (reverse ? 1 : 0);
      }
      if (topology === 4) return corner === 0 ? 0 : triangle + corner;
      return -1;
    }

    function gxExpandedTriangleIndices(topology, vertexCount) {
      const indices = [];
      const triangleCount = gxSourceTriangleCount(topology, vertexCount);
      for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        indices.push([
          gxSourceTriangleIndex(topology, vertexCount, triangle, 0),
          gxSourceTriangleIndex(topology, vertexCount, triangle, 1),
          gxSourceTriangleIndex(topology, vertexCount, triangle, 2),
        ]);
      }
      return indices;
    }

    function gxPostCullActionFromNormal(normal, cullMode, viewportHeight) {
      if (!Number.isFinite(viewportHeight) || viewportHeight === 0) return null;
      if (normal === null) return null;
      let backface = normal <= 0;
      if (viewportHeight > 0) backface = !backface;
      const survives = cullMode === 0
        || (cullMode === 1 && backface)
        || (cullMode === 2 && !backface);
      return (survives ? 2 : 0) | (backface ? 1 : 0);
    }

    function gxPostCullAction(triangle, cullMode, viewportHeight) {
      return gxPostCullActionFromNormal(
        gxCullNormalZ(triangle),
        cullMode,
        viewportHeight
      );
    }

    function gxPostCullEvidence(topology, cullMode, clipPositions, viewportHeight) {
      if (
        !Number.isInteger(topology)
        || topology < 0
        || topology > 4
        || !Number.isInteger(cullMode)
        || cullMode < 0
        || cullMode > 3
        || !Array.isArray(clipPositions)
      ) {
        return null;
      }
      const triangleCount = gxSourceTriangleCount(topology, clipPositions.length);
      if (triangleCount === 0) return null;
      const evidence = new Uint8Array(Math.ceil(triangleCount / 4));
      for (let index = 0; index < triangleCount; index += 1) {
        const v0 = clipPositions[
          gxSourceTriangleIndex(topology, clipPositions.length, index, 0)
        ];
        const v1 = clipPositions[
          gxSourceTriangleIndex(topology, clipPositions.length, index, 1)
        ];
        const v2 = clipPositions[
          gxSourceTriangleIndex(topology, clipPositions.length, index, 2)
        ];
        if (
          !gxCullClipPositionIsInside(v0)
          || !gxCullClipPositionIsInside(v1)
          || !gxCullClipPositionIsInside(v2)
        ) {
          return null;
        }
        const action = gxPostCullActionFromNormal(
          gxCullNormalZ3(v0, v1, v2),
          cullMode,
          viewportHeight
        );
        if (action === null) return null;
        evidence[index >>> 2] |= action << ((index & 3) * 2);
      }
      return evidence;
    }

    function gxManagedCoverageStateCandidate(
      topology,
      vertexCount,
      pipeline,
      texturedStages,
      textures
    ) {
      if (
        gxSourceTriangleCount(topology, vertexCount) === 0
        || pipeline.cullMode === 3
        || !Array.isArray(texturedStages)
        || (pipeline.pixelControl & 7) === 2
        || ((pipeline.zTextureMode >>> 2) & 3) !== 0
        || ((pipeline.fogWords[3] >>> 21) & 7) !== 0
      ) {
        return false;
      }
      let requiredTextureMapMask = 0;
      let allLegacySamplersEligible = true;
      for (const stage of texturedStages) {
        if (
          stage === null
          || typeof stage !== "object"
          || !Number.isInteger(stage.texCoordIndex)
          || stage.texCoordIndex < 0
          || stage.texCoordIndex > 7
          || !Number.isInteger(stage.textureMap)
          || stage.textureMap < 0
          || stage.textureMap > 7
        ) {
          return false;
        }
        requiredTextureMapMask |= 1 << stage.textureMap;
      }
      for (let textureMap = 0; textureMap < 8; textureMap += 1) {
        if ((requiredTextureMapMask & (1 << textureMap)) === 0) continue;
        const texture = Array.isArray(textures) ? textures[textureMap] : null;
        const registers = gxTextureRegisters(textureMap);
        const mode0 = texture === null || typeof texture !== "object"
          ? gxBpRegisters[registers.mode0] >>> 0
          : texture.mode0 >>> 0;
        const magFilter = (mode0 >>> 4) & 1;
        const minFilter = (mode0 >>> 5) & 7;
        const maxAnisotropy = (mode0 >>> 19) & 3;
        const image0 = gxBpRegisters[registers.image0] >>> 0;
        const width = texture === null || typeof texture !== "object"
          ? (image0 & 0x3ff) + 1
          : texture.width;
        const height = texture === null || typeof texture !== "object"
          ? ((image0 >>> 10) & 0x3ff) + 1
          : texture.height;
        const wrapS = mode0 & 3;
        const wrapT = (mode0 >>> 2) & 3;
        const legacyWrapEligible = (
          Number.isInteger(width)
          && Number.isInteger(height)
          && width >= 1
          && height >= 1
          && (
            (wrapS !== 1 && wrapS !== 2)
            || (width & (width - 1)) === 0
          )
          && (
            (wrapT !== 1 && wrapT !== 2)
            || (height & (height - 1)) === 0
          )
        );
        const legacyBaseEligible = (
          (minFilter & 3) !== 0
            ? false
            : magFilter === (minFilter >>> 2)
              && maxAnisotropy === 0
              && legacyWrapEligible
        );
        allLegacySamplersEligible &&= legacyBaseEligible;
      }
      if (!allLegacySamplersEligible) {
        // V6 remains constrained to equal base-level min/mag filters. The
        // alternative is packet-wide V7 manual sampling, which is safe only
        // when every required draw snapshot is authentic and at least one
        // required binding guarantees a genuine resident mip chain.
        if (!Array.isArray(textures)) return false;
        let hasStrictV7GenuineMip = false;
        for (let textureMap = 0; textureMap < 8; textureMap += 1) {
          if ((requiredTextureMapMask & (1 << textureMap)) === 0) continue;
          const classification =
            gxStrictV7TextureSnapshotClassification(textures[textureMap]);
          if (classification === null) return false;
          hasStrictV7GenuineMip ||= classification === "genuine-mip";
        }
        if (!hasStrictV7GenuineMip) return false;
      }
      // The receiver currently manages only the fixed-function early-depth
      // path. This conservative subset avoids reproducing the complete alpha
      // outcome classifier in the producer hot loop.
      return !(
        (pipeline.zMode & 1) !== 0
        && (pipeline.zMode & (1 << 4)) !== 0
        && (pipeline.pixelControl & (1 << 6)) !== 0
      );
    }

    function gxManagedCoverageVerticesCandidate(topology, vertices) {
      if (
        !Array.isArray(vertices)
        || vertices.length === 0
        || vertices.length % 36 !== 0
      ) {
        return false;
      }
      const vertexCount = vertices.length / 36;
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        const offset = vertex * 36;
        for (let component = 0; component < 36; component += 1) {
          if (!Number.isFinite(Math.fround(vertices[offset + component]))) return false;
        }
        const x = Math.fround(vertices[offset]);
        const y = Math.fround(vertices[offset + 1]);
        const z = Math.fround(vertices[offset + 2]);
        const w = Math.fround(vertices[offset + 3]);
        if (
          x < 0
          || x > 640
          || y < 0
          || y > 528
          || z < 0
          || z > 0x00ffffff
          || !(w > 0)
        ) {
          return false;
        }
      }

      const triangleCount = gxSourceTriangleCount(topology, vertexCount);
      for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        const first = gxSourceTriangleIndex(topology, vertexCount, triangle, 0) * 36;
        for (let corner = 1; corner < 3; corner += 1) {
          const other =
            gxSourceTriangleIndex(topology, vertexCount, triangle, corner) * 36;
          for (let component = 2; component < 12; component += 1) {
            if (component === 3) continue;
            if (
              !Object.is(
                Math.fround(vertices[first + component]),
                Math.fround(vertices[other + component])
              )
            ) {
              return false;
            }
          }
        }
      }
      return true;
    }

    function gxManagedCoveragePostCullEvidence(
      topology,
      cullMode,
      positions,
      matrixIndices,
      viewportHeight
    ) {
      if (
        !Array.isArray(positions)
        || !Array.isArray(matrixIndices)
        || positions.length !== matrixIndices.length
      ) {
        return null;
      }
      const state = gxCullTransformState();
      if (state === null) return null;
      const clipPositions = new Array(positions.length);
      for (let vertex = 0; vertex < positions.length; vertex += 1) {
        const clip = gxCullClipPosition(
          positions[vertex],
          matrixIndices[vertex],
          state
        );
        if (clip === null) return null;
        clipPositions[vertex] = clip;
      }
      return gxPostCullEvidence(
        topology,
        cullMode,
        clipPositions,
        viewportHeight
      );
    }

    function gxManagedCoverageExactClipInput(
      topology,
      cullMode,
      positions,
      matrixIndices
    ) {
      if (
        !Number.isInteger(topology)
        || topology < 0
        || topology > 4
        || !Number.isInteger(cullMode)
        || cullMode < 0
        || cullMode > 3
        || !Array.isArray(positions)
        || !Array.isArray(matrixIndices)
        || positions.length !== matrixIndices.length
        || gxSourceTriangleCount(topology, positions.length) === 0
      ) {
        return null;
      }
      const bpGenMode = gxBpRegisters[0x00] >>> 0;
      const bpScissorTopLeft = gxBpRegisters[0x20] >>> 0;
      const bpScissorBottomRight = gxBpRegisters[0x21] >>> 0;
      const bpScissorOffset = gxBpRegisters[0x59] >>> 0;
      if (
        bpGenMode > 0x00ffffff
        || bpScissorTopLeft > 0x00ffffff
        || bpScissorBottomRight > 0x00ffffff
        || bpScissorOffset > 0x00ffffff
        || ((bpGenMode >>> 14) & 3) !== cullMode
      ) {
        return null;
      }
      const xfClipDisable = gxXfRegisters[0x1005] >>> 0;
      if (xfClipDisable > 7) return null;

      const viewport = new Float32Array(6);
      const viewportBits = new Uint32Array(viewport.buffer);
      for (let component = 0; component < viewport.length; component += 1) {
        viewportBits[component] = gxXfRegisters[0x101a + component] >>> 0;
      }
      if (
        !viewport.every(Number.isFinite)
        || viewport[0] === 0
        || viewport[1] === 0
      ) {
        return null;
      }

      const state = gxCullTransformState();
      if (state === null) return null;
      const clipPositions = new Float32Array(positions.length * 4);
      for (let vertex = 0; vertex < positions.length; vertex += 1) {
        const clip = gxExactClipPosition(
          positions[vertex],
          matrixIndices[vertex],
          state
        );
        if (clip === null) return null;
        clipPositions.set(clip, vertex * 4);
      }
      return {
        bpGenMode,
        bpScissorTopLeft,
        bpScissorBottomRight,
        bpScissorOffset,
        xfClipDisable,
        viewport,
        clipPositions,
      };
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
      const projected = gxProjectViewPosition(viewPosition);
      const normal = gxTransformNormal(normalAttribute.normal, positionMatrix);
      const tangent = gxTransformNormalVector(
        normalAttribute.tangent, positionMatrix
      );
      const binormal = gxTransformNormalVector(
        normalAttribute.binormal, positionMatrix
      );
      const rasterColors = gxLightRasterChannels(
        viewPosition, normal, colors
      );
      if (rasterColors === null) {
        gxLightingRejectedVertices += 1;
        return { cursor, skipped: true };
      }
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
        position,
        positionMatrix,
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
        pixelControl: gxBpRegisters[0x43] >>> 0,
        constantAlpha: gxBpRegisters[0x42] >>> 0,
        zTextureBias: gxBpRegisters[0xf4] >>> 0,
        zTextureMode: gxBpRegisters[0xf5] >>> 0,
        fogRangeBase: gxBpRegisters[0xe8] >>> 0,
        fogRangeK: Array.from(
          { length: 5 },
          (_unused, index) => gxBpRegisters[0xe9 + index] >>> 0
        ),
        fogWords: Array.from(
          { length: 5 },
          (_unused, index) => gxBpRegisters[0xee + index] >>> 0
        ),
        viewportHalfWidthBits: gxXfRegisters[0x101a] >>> 0,
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
      const topology = (opcode >>> 3) & 7;
      const pipeline = gxDrawPipelineState();
      const stageCount = Math.min(16, ((gxBpRegisters[0x00] >>> 10) & 0xf) + 1);
      const stages = Array.from({ length: stageCount }, (_unused, stageIndex) =>
        gxTevStageState(stageIndex)
      );
      const texturedStages = stages.filter(stage => stage.textureEnabled);
      const vertices = [];
      const texCoordSets = Array.from({ length: 8 }, () => []);
      const rawTextureCoordSets = Array.from({ length: 8 }, () => []);
      const rasterColorSets = Array.from({ length: 2 }, () => []);
      const normalSet = [];
      const sourcePositions = [];
      const positionMatrixIndices = [];
      let textureMatrices = null;
      let decodeComplete = true;
      let exactGeometryRequired = false;
      let legacyProjectionNullVertices = 0;
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        const start = payloadOffset + vertex * vertexSize;
        const decoded = gxDecodeVertex(source, start, opcode & 7);
        if (decoded.cursor !== start + vertexSize) gxVertexDecodeErrors += 1;
        if (decoded.skipped) {
          gxDroppedVertices += 1;
          decodeComplete = false;
          continue;
        }
        gxDecodedVertices += 1;
        sourcePositions.push(decoded.position);
        positionMatrixIndices.push(decoded.positionMatrix);
        const projected = decoded.projected ?? [0, 0, 0, 1];
        if (decoded.projected === null) {
          gxLegacyProjectionNullVertices += 1;
          legacyProjectionNullVertices += 1;
          exactGeometryRequired = true;
        } else {
          gxProjectedVertices += 1;
        }
        if (
          !Array.isArray(decoded.rasterColors)
          || decoded.rasterColors.length !== 2
          || decoded.rasterColors.some(channel =>
            !Array.isArray(channel) || channel.length !== 4
          )
        ) {
          gxVertexDecodeErrors += 1;
          gxDroppedVertices += 1;
          decodeComplete = false;
          continue;
        }
        const [raster0, raster1] = decoded.rasterColors;
        vertices.push(
          projected[0], projected[1], projected[2], projected[3],
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
      if (!decodeComplete || vertices.length === 0) {
        gxDroppedVertices += legacyProjectionNullVertices;
        return;
      }
      const sourceVertices = new Float32Array(vertices);
      let exactClipInput = null;
      if (exactGeometryRequired) {
        exactClipInput = gxManagedCoverageExactClipInput(
          topology,
          pipeline.cullMode,
          sourcePositions,
          positionMatrixIndices
        );
        if (
          exactClipInput === null
          || !sourceVertices.every(Number.isFinite)
        ) {
          gxExactRequiredCaptureMisses += 1;
          gxDroppedVertices += legacyProjectionNullVertices;
          return;
        }
      }
      gxFrameDrawVertices += vertexCount;
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
      const collectCullSources = gxManagedCoverageStateCandidate(
        topology,
        vertexCount,
        pipeline,
        texturedStages,
        textures
      );
      if (texturedStages.length !== 0) {
        gxTexturedDraws += 1;
        statusDataset.gxTextures = String(gxTexturedDraws);
      }
      const tevMode = `per-fragment-stage-${stageCount}`;
      gxTevModeCounts.set(tevMode, (gxTevModeCounts.get(tevMode) ?? 0) + 1);
      const texCoordIndex = texturedStages[0]?.texCoordIndex ?? 0;
      const selectedTexCoords = texCoordSets[texCoordIndex];
      const postCullEvidence = (
        !exactGeometryRequired
        && collectCullSources
        && gxManagedCoverageVerticesCandidate(topology, vertices)
      )
        ? gxManagedCoveragePostCullEvidence(
          topology,
          pipeline.cullMode,
          sourcePositions,
          positionMatrixIndices,
          gxXfFloat(0x101b)
        )
        : null;
      if (
        !exactGeometryRequired
        && collectCullSources
        && postCullEvidence === null
      ) {
        exactClipInput = gxManagedCoverageExactClipInput(
          topology,
          pipeline.cullMode,
          sourcePositions,
          positionMatrixIndices
        );
      }
      const draw = {
        topology,
        vat: opcode & 7,
        vertexCount,
        // Renderer frames cross a Worker boundary. Keep the GPU-bound payload
        // in its final f32 representation so structured cloning does not walk
        // and duplicate one boxed JavaScript number per vertex component.
        vertices: sourceVertices,
        textures,
        tevState: gxPackTevState(stages),
        pipeline,
        ...(postCullEvidence === null ? {} : { postCullEvidence }),
        ...(exactClipInput === null ? {} : { exactClipInput }),
        ...(exactGeometryRequired ? { exactGeometryRequired: true } : {}),
      };
      gxFrameDraws.push(draw);
      if (exactGeometryRequired) {
        gxExactRequiredDraws += 1;
        gxExactRequiredVertices += vertexCount;
      }
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
        const registerSlot = (address - 0xe0) >>> 1;
        const registerValue = gxBpRegisters[address];
        const isKonst = (registerValue & 0x00800000) !== 0;
        // BP konst slots map directly to K0..K3. Color slots instead encode
        // PREV, C0, C1, C2 and need rotation into the renderer's C0..PREV
        // array order.
        const registerIndex = isKonst
          ? registerSlot
          : gxTevRegisterIndex(registerSlot);
        const target = isKonst
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
      // IMAGE1 selects preloaded TMEM versus the IMAGE3 DRAM source, so either
      // register can make a prospective EFB-copy consumer newly visible.
      let textureSourceMap = null;
      if (address >= 0x8c && address <= 0x8f) {
        textureSourceMap = address - 0x8c;
      } else if (address >= 0x94 && address <= 0x97) {
        textureSourceMap = address - 0x94;
      } else if (address >= 0xac && address <= 0xaf) {
        textureSourceMap = address - 0xac + 4;
      } else if (address >= 0xb4 && address <= 0xb7) {
        textureSourceMap = address - 0xb4 + 4;
      }
      if (textureSourceMap !== null) {
        const registers = gxTextureRegisters(textureSourceMap);
        const source = gxTextureImageSource(
          gxBpRegisters[registers.image1],
          gxBpRegisters[registers.image2],
          gxBpRegisters[registers.image3]
        );
        if (source.kind === "main-memory") gxMarkTextureCopyConsumer(source.address);
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
      if (address === 0x47 || address === 0x48) {
        // Both BP registers target the shared PE token; only 0x48 asserts it.
        const tokenMask = mask & 0xffff;
        peTokenValue = (
          (peTokenValue & ~tokenMask) | (value & tokenMask)
        ) & 0xffff;
        view.setUint16(mmio + 0x100e, peTokenValue, false);
        const event = address === 0x47
          ? "peTokenCommand"
          : "peTokenInterruptCommand";
        deviceEvents.set(event, (deviceEvents.get(event) ?? 0) + 1);
        if (address === 0x48 && !peTokenSignal) {
          peTokenSignal = true;
          peTokenInterruptDelivered = false;
          deviceEvents.set("peToken", (deviceEvents.get("peToken") ?? 0) + 1);
        }
      }
      if (address === 0x65) gxLoadTlut();
      if (address !== 0x52) return;

      const trigger = gxBpRegisters[0x52];
      const source = gxBpRegisters[0x49];
      const dimensions = gxBpRegisters[0x4a];
      const yScaleRaw = gxBpRegisters[0x4e];
      const sourceHeight = ((dimensions >>> 10) & 0x3ff) + 1;
      const scaledIntervals = (trigger & 0x400) !== 0
        ? Math.floor((sourceHeight - 1) * 256 / Math.max(1, yScaleRaw))
        : Math.floor((sourceHeight - 1) * yScaleRaw / 256);
      const copyToXfb = (trigger & 0x4000) !== 0;
      const viTop = viXfbAddress(0x201c);
      const viBottom = viXfbAddress(0x2024);
      const copyState = {
        zMode: gxBpRegisters[0x40] >>> 0,
        blendMode: gxBpRegisters[0x41] >>> 0,
        pixelControl: gxBpRegisters[0x43] >>> 0,
        copyCommand: trigger >>> 0,
        clearRgba: [
          gxBpRegisters[0x4f] & 0xff,
          (gxBpRegisters[0x50] >>> 8) & 0xff,
          gxBpRegisters[0x50] & 0xff,
          (gxBpRegisters[0x4f] >>> 8) & 0xff,
        ],
        clearDepth: gxBpRegisters[0x51] >>> 0,
        copyScale: yScaleRaw >>> 0,
        copyFilter: [
          gxBpRegisters[0x53] >>> 0,
          gxBpRegisters[0x54] >>> 0,
        ],
      };
      const frame = {
        index: copyToXfb ? gxXfbCopyCount + 1 : gxTextureCopyCount + 1,
        capturedAtCycle: cycles,
        sourceX: source & 0x3ff,
        sourceY: (source >>> 10) & 0x3ff,
        width: (dimensions & 0x3ff) + 1,
        sourceHeight,
        // libogc's __GX_GetNumXfbLines clamps to 1024. Keep that protocol-safety
        // bound for direct BP writes too (intentionally stricter than Dolphin's
        // current path) so extreme scales cannot inflate downstream surfaces.
        height: Math.min(
          1024,
          1 + scaledIntervals
        ),
        destination: (gxBpRegisters[0x4b] << 5) >>> 0,
        viTop,
        viBottom,
        stride: (gxBpRegisters[0x4d] << 5) >>> 0,
        copyToXfb,
        clear: (trigger & 0x0800) !== 0,
        clearColor: copyState.clearRgba,
        copyState,
        geometry: {
          drawCalls: gxFrameDraws.length,
          vertices: gxFrameDrawVertices,
          draws: gxFrameDraws,
        },
      };
      frame.displayed = false;
      invalidateGxCopyReservation(frame);
      const frameDiagnostics = { ...frame };
      delete frameDiagnostics.copyState;
      if (copyToXfb) {
        gxXfbCopyCount += 1;
        const recorded = {
          ...frameDiagnostics,
          captured: gxCollectFrameGeometry,
          geometry: {
            drawCalls: frame.geometry.drawCalls,
            vertices: frame.geometry.vertices,
          },
        };
        gxXfbCopies.push(recorded);
        gxRecordXfbCopyGeneration(recorded);
        if (gxXfbCopies.length > 16) gxXfbCopies.shift();
        if (!gxCollectFrameGeometry) {
          gxFramesSkipped += 1;
          if (frame.clear) gxSkippedCopyClears.push(gxCopyClearOperation(frame));
          else gxUncollectedNonClearingFrames += 1;
        } else {
          gxFlushSkippedCopyClears();
          postGxFrame(2, frame);
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
          ...frameDiagnostics,
          boundAsTexture,
          captured: collectedGeometry,
          geometry: {
            drawCalls: frame.geometry.drawCalls,
            vertices: frame.geometry.vertices,
          },
        });
        if (gxTextureCopies.length > 16) gxTextureCopies.shift();
        if (collectedGeometry) {
          gxFlushSkippedCopyClears();
          postGxFrame(1, frame);
          gxTextureCopyFramesPresented += 1;
        } else if (frame.clear) {
          gxFlushSkippedCopyClears();
          postMessage({ type: "gx-clear", clear: gxCopyClearOperation(frame) });
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

    function gxCopyClearOperation(frame) {
      return {
        sourceX: frame.sourceX,
        sourceY: frame.sourceY,
        sourceWidth: frame.width,
        sourceHeight: frame.sourceHeight,
        copyState: frame.copyState,
      };
    }

    function gxFlushSkippedCopyClears() {
      for (const clear of gxSkippedCopyClears) {
        postMessage({ type: "gx-clear", clear });
      }
      gxSkippedCopyClears = [];
    }

    function decodeGxCommands(source, start, end, inDisplayList = false) {
      let offset = start;
      let retryAtBufferedBytes = 1;
      while (offset < end) {
        const opcode = source[offset];
        let commandBytes;
        if ([0x00, 0x01, 0x44, 0x48].includes(opcode)) {
          commandBytes = 1;
        } else if (opcode === 0x08) {
          commandBytes = 6;
        } else if (opcode === 0x10) {
          if (end - offset < 5) {
            retryAtBufferedBytes = 5;
            break;
          }
          commandBytes = 5 + ((((gxReadU32(source, offset + 1) >>> 16) & 15) + 1) * 4);
        } else if ([0x20, 0x28, 0x30, 0x38].includes(opcode)) {
          commandBytes = 5;
        } else if (opcode === 0x40) {
          commandBytes = 9;
        } else if (opcode === 0x61) {
          commandBytes = 5;
        } else if ((opcode & 0xc0) === 0x80) {
          if (end - offset < 3) {
            retryAtBufferedBytes = 3;
            break;
          }
          const vertices = gxReadU16(source, offset + 1);
          commandBytes = 3 + vertices * gxVertexSize(opcode & 7);
        } else {
          gxUnknownOpcodes += 1;
          offset += 1;
          continue;
        }
        if (end - offset < commandBytes) {
          retryAtBufferedBytes = commandBytes;
          break;
        }

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
      if (!inDisplayList) gxDecodeRetryAtBufferedBytes = retryAtBufferedBytes;
      return offset - start;
    }

    function gxFifoBufferedBytes() {
      return gxDecodeBuffer.length;
    }

    function gxPreflightDecodeAppend(additionalBytes) {
      const bufferedBytes = gxFifoBufferedBytes();
      const requiredBytes = bufferedBytes + additionalBytes;
      // Validate the whole append before mutating carry bytes or diagnostics.
      // Advancing the watermark models geometric growth; it does not reserve
      // JavaScript Array backing storage.
      if (requiredBytes > gxDecodeMaximumBufferedBytes) {
        throw new Error(
          `GX FIFO decode carry overflow: ${requiredBytes} > ${gxDecodeMaximumBufferedBytes}`
        );
      }
      if (requiredBytes <= gxDecodeCapacityWatermarkBytes) return;

      let capacity = gxDecodeCapacityWatermarkBytes;
      while (capacity < requiredBytes) {
        capacity = Math.min(gxDecodeMaximumBufferedBytes, Math.max(1, capacity * 2));
      }
      gxDecodeCapacityWatermarkBytes = capacity;
      gxDecodeCapacityWatermarkGrowths += 1;
    }

    function decodeGxFifo() {
      const bufferedBytes = gxFifoBufferedBytes();
      if (bufferedBytes < gxDecodeRetryAtBufferedBytes) {
        gxDecodeBlockedSkips += 1;
        return;
      }
      const decodeStartedAt = beginWorkerPhaseTiming(workerHostTimings.fifoDecode);
      try {
        gxDecodeAttempts += 1;
        const consumed = decodeGxCommands(gxDecodeBuffer, 0, bufferedBytes);
        if (consumed === bufferedBytes) {
          gxDecodeBuffer.length = 0;
        } else if (consumed !== 0) {
          // V8's packed-array front removal is materially faster here than a
          // manual copyWithin/shrink pair on sustained SMB command traffic.
          gxDecodeBuffer.splice(0, consumed);
          gxDecodeCompactions += 1;
        }
      } finally {
        recordWorkerPhaseTiming(workerHostTimings.fifoDecode, decodeStartedAt);
      }
    }

    function appendGxCommandBytes(source) {
      gxPreflightDecodeAppend(source.length);
      for (let index = 0; index < source.length; index += 1) {
        gxDecodeBuffer.push(source[index]);
      }
      gxDecodePreDecodeHighWaterBytes = Math.max(
        gxDecodePreDecodeHighWaterBytes,
        gxFifoBufferedBytes()
      );
      decodeGxFifo();
    }

    function commandProcessorFifoSpanBytes() {
      if (cpFifoState.end < cpFifoState.base) return 0;
      return cpFifoState.end - cpFifoState.base + gxWriteGatherBurstBytes;
    }

    function normalizeCommandProcessorFifoDistance() {
      const rawDistance = cpFifoState.distance;
      const span = commandProcessorFifoSpanBytes();
      if (
        span === 0
        || rawDistance <= span
        || (span & (gxWriteGatherBurstBytes - 1)) !== 0
        || (rawDistance & (gxWriteGatherBurstBytes - 1)) !== 0
        || physicalRamPointer(cpFifoState.base, span) === null
        || cpFifoState.writePointer < cpFifoState.base
        || cpFifoState.writePointer > cpFifoState.end
        || cpFifoState.readPointer < cpFifoState.base
        || cpFifoState.readPointer > cpFifoState.end
        || cpFifoState.writePointer >= cpFifoState.readPointer
      ) {
        return false;
      }

      // A signed GX FIFO-object write - read distance can reach CP as a large
      // positive value because the register exposes only 26 distance bits.
      // Recover the intended ring distance only when the raw register value
      // proves that exact origin; every other oversized distance remains an
      // invalid state.
      const maskedPointerDelta = (
        cpFifoState.writePointer - cpFifoState.readPointer
      ) & cpFifoAddressMask;
      if (rawDistance !== maskedPointerDelta) return false;

      const normalizedDistance = span
        - (cpFifoState.readPointer - cpFifoState.writePointer);
      if (
        normalizedDistance < 0
        || normalizedDistance > span
        || (normalizedDistance & (gxWriteGatherBurstBytes - 1)) !== 0
      ) {
        return false;
      }

      cpFifoState.distance = normalizedDistance >>> 0;
      commandProcessorDistanceNormalizations += 1;
      commandProcessorLastDistanceNormalization = {
        rawDistance,
        normalizedDistance,
        base: cpFifoState.base,
        end: cpFifoState.end,
        writePointer: cpFifoState.writePointer,
        readPointer: cpFifoState.readPointer,
        control: cpFifoState.control,
      };
      return true;
    }

    function validatedCommandProcessorFifoSpan(pointer, role) {
      const span = commandProcessorFifoSpanBytes();
      if (
        span === 0
        || pointer < cpFifoState.base
        || pointer > cpFifoState.end
        || (cpFifoState.distance & (gxWriteGatherBurstBytes - 1)) !== 0
        || cpFifoState.distance > span
        || physicalRamPointer(cpFifoState.base, span) === null
      ) {
        throw new Error(
          `invalid CP FIFO ${role} state: ${hex32(cpFifoState.base)}`
            + `..${hex32(cpFifoState.end)} @ ${hex32(pointer)}`
            + ` distance ${hex32(cpFifoState.distance)}`
        );
      }
      return span;
    }

    function advanceCommandProcessorFifoPointer(pointer) {
      return pointer === cpFifoState.end
        ? cpFifoState.base
        : (pointer + gxWriteGatherBurstBytes) & cpFifoAddressMask;
    }

    function commandProcessorDistanceToBreakpoint() {
      const pointer = cpFifoState.readPointer;
      const breakpoint = cpFifoState.breakpoint;
      if (
        breakpoint < cpFifoState.base
        || breakpoint > cpFifoState.end
        || pointer < cpFifoState.base
        || pointer > cpFifoState.end
      ) {
        return null;
      }
      return breakpoint >= pointer
        ? breakpoint - pointer
        : cpFifoState.end - pointer + gxWriteGatherBurstBytes
          + breakpoint - cpFifoState.base;
    }

    function serviceCommandProcessorFifo(
      byteBudget = commandProcessorServiceBudgetBytes
    ) {
      commandProcessorServiceCalls += 1;
      commandProcessorMaximumRawDistance = Math.max(
        commandProcessorMaximumRawDistance,
        cpFifoState.distance
      );
      if (cpFifoState.distance === 0) {
        refreshCommandProcessorInterruptLevel("fifo-empty");
        return 0;
      }
      if ((cpFifoState.control & cpControlReadEnable) === 0) {
        commandProcessorReadDisabledStops += 1;
        refreshCommandProcessorInterruptLevel("fifo-read-disabled");
        return 0;
      }
      // A guest can publish a signed write - read distance immediately before
      // enabling GP reads. Recover that coherent ring value before sampling
      // the high-water source so it cannot become a false sticky interrupt.
      normalizeCommandProcessorFifoDistance();
      commandProcessorMaximumDistance = Math.max(
        commandProcessorMaximumDistance,
        cpFifoState.distance
      );

      validatedCommandProcessorFifoSpan(
        cpFifoState.readPointer,
        "read"
      );
      refreshCommandProcessorInterruptLevel("fifo-before-consume");

      let remainingBudget = Math.max(
        gxWriteGatherBurstBytes,
        Math.floor(byteBudget / gxWriteGatherBurstBytes) * gxWriteGatherBurstBytes
      );
      let consumedBytes = 0;
      while (cpFifoState.distance !== 0 && remainingBudget !== 0) {
        if (commandProcessorBreakpointLevel()) {
          commandProcessorBreakpointStops += 1;
          break;
        }

        const bytesToEnd = cpFifoState.end - cpFifoState.readPointer
          + gxWriteGatherBurstBytes;
        let chunkBytes = Math.min(
          cpFifoState.distance,
          remainingBudget,
          bytesToEnd
        );
        if ((cpFifoState.control & cpControlBreakpointEnable) !== 0) {
          const bytesToBreakpoint = commandProcessorDistanceToBreakpoint();
          if (bytesToBreakpoint !== null) {
            if (bytesToBreakpoint === 0) {
              commandProcessorBreakpointStops += 1;
              break;
            }
            chunkBytes = Math.min(chunkBytes, bytesToBreakpoint);
          }
        }
        chunkBytes = Math.floor(chunkBytes / gxWriteGatherBurstBytes)
          * gxWriteGatherBurstBytes;
        if (chunkBytes === 0) break;

        const source = physicalRamPointer(cpFifoState.readPointer, chunkBytes);
        if (source === null) {
          throw new Error(
            `CP FIFO read is outside main RAM: ${hex32(cpFifoState.readPointer)}`
              + ` + ${chunkBytes}`
          );
        }
        appendGxCommandBytes(bytes.subarray(source, source + chunkBytes));

        if (chunkBytes === bytesToEnd) {
          cpFifoState.readPointer = cpFifoState.base;
          commandProcessorReadWraps += 1;
        } else {
          cpFifoState.readPointer = (
            cpFifoState.readPointer + chunkBytes
          ) & cpFifoAddressMask;
        }
        cpFifoState.distance = (cpFifoState.distance - chunkBytes) >>> 0;
        commandProcessorReadBursts += chunkBytes / gxWriteGatherBurstBytes;
        commandProcessorReadBytes += chunkBytes;
        consumedBytes += chunkBytes;
        remainingBudget -= chunkBytes;
      }
      refreshCommandProcessorInterruptLevel("fifo-after-consume");
      return consumedBytes;
    }

    function validateProcessorInterfaceFifoWriteState(destination) {
      const target = physicalRamPointer(destination, gxWriteGatherBurstBytes);
      if (
        target === null
        || piFifoState.end < piFifoState.base
        || destination < piFifoState.base
        || destination > piFifoState.end
        || (
          piFifoState.end === piFifoRedirectEnd
          && destination >= piFifoRedirectEnd
        )
        || (
          piFifoState.end !== piFifoRedirectEnd
          && physicalRamPointer(
            piFifoState.base,
            piFifoState.end - piFifoState.base + gxWriteGatherBurstBytes
          ) === null
        )
      ) {
        throw new Error(
          `invalid PI FIFO write state: ${hex32(piFifoState.base)}`
            + `..${hex32(piFifoState.end)} @ ${hex32(destination)}`
        );
      }
      return target;
    }

    function validateGxWriteGatherBurstState() {
      const destination = piFifoState.current;
      const target = validateProcessorInterfaceFifoWriteState(destination);

      const linked = (cpFifoState.control & cpControlLinkEnable) !== 0;
      if (linked) {
        const span = validatedCommandProcessorFifoSpan(
          cpFifoState.writePointer,
          "write"
        );
        if (cpFifoState.distance + gxWriteGatherBurstBytes > span) {
          throw new Error(
            `CP FIFO overflow: ${hex32(cpFifoState.distance)}`
              + ` + ${gxWriteGatherBurstBytes} > ${hex32(span)}`
          );
        }
        if ((cpFifoState.control & cpControlReadEnable) !== 0) {
          validatedCommandProcessorFifoSpan(
            cpFifoState.readPointer,
            "read"
          );
        }
      }

      return { destination, linked, target };
    }

    function preflightGxWriteGatherAppend(sourceBytes) {
      const burstCount = Math.floor(
        (gxWriteGatherPendingBytes + sourceBytes) / gxWriteGatherBurstBytes
      );
      if (burstCount === 0) return { burstCount, linked: false };

      const linked = (cpFifoState.control & cpControlLinkEnable) !== 0;
      const readEnabled = (cpFifoState.control & cpControlReadEnable) !== 0;
      const producedBytes = burstCount * gxWriteGatherBurstBytes;
      validateProcessorInterfaceFifoWriteState(piFifoState.current);

      if (
        piFifoState.end === piFifoRedirectEnd
        && !(linked && readEnabled)
        && (
          piFifoState.current + producedBytes > piFifoRedirectEnd
          || physicalRamPointer(piFifoState.current, producedBytes) === null
        )
      ) {
        throw new Error(
          `PI FIFO redirect run is outside main RAM: ${hex32(piFifoState.current)}`
            + ` + ${producedBytes}`
        );
      }

      if (!linked) return { burstCount, linked };

      let span = validatedCommandProcessorFifoSpan(
        cpFifoState.writePointer,
        "write"
      );
      if (readEnabled) {
        validatedCommandProcessorFifoSpan(cpFifoState.readPointer, "read");
        while (cpFifoState.distance + producedBytes > span) {
          const consumedBytes = serviceCommandProcessorFifo();
          if (consumedBytes === 0) break;
          span = validatedCommandProcessorFifoSpan(
            cpFifoState.writePointer,
            "write"
          );
        }
      }
      if (cpFifoState.distance + producedBytes > span) {
        throw new Error(
          `CP FIFO append overflow: ${hex32(cpFifoState.distance)}`
            + ` + ${hex32(producedBytes)} > ${hex32(span)}`
        );
      }
      if (readEnabled) {
        // Prove every later bounded reader append fits even if this complete
        // run turns out to be one incomplete GX command.
        gxPreflightDecodeAppend(cpFifoState.distance + producedBytes);
      }
      return { burstCount, linked };
    }

    function commitGxWriteGatherBurst(
      state = validateGxWriteGatherBurstState()
    ) {
      const { destination, linked, target } = state;

      bytes.set(gxWriteGatherBuffer, target);
      const piRedirect = piFifoState.end === piFifoRedirectEnd;
      const piWrapped = !piRedirect && piFifoState.current === piFifoState.end;
      if (piWrapped) {
        piFifoState.current = piFifoState.base;
        piFifoState.wrap = true;
        gxWriteGatherWraps += 1;
      } else if (piRedirect) {
        // The display-list redirect end is a one-past sentinel, not a ring
        // address. Preserve it internally so the next burst fails closed
        // instead of normalizing bit 26 into a write at physical address zero.
        piFifoState.current += gxWriteGatherBurstBytes;
      } else {
        piFifoState.current = (
          piFifoState.current + gxWriteGatherBurstBytes
        ) & cpFifoAddressMask;
      }

      if (linked) {
        cpFifoState.writePointer = advanceCommandProcessorFifoPointer(
          cpFifoState.writePointer
        );
        cpFifoState.distance = (
          cpFifoState.distance + gxWriteGatherBurstBytes
        ) >>> 0;
        commandProcessorMaximumDistance = Math.max(
          commandProcessorMaximumDistance,
          cpFifoState.distance
        );
        gxWriteGatherLinkedBursts += 1;

        if ((cpFifoState.control & cpControlReadEnable) !== 0) {
          piFifoState.base = cpFifoState.base;
          piFifoState.end = cpFifoState.end;
          piFifoState.current = cpFifoState.writePointer;
        }
      } else {
        gxWriteGatherUnlinkedBursts += 1;
      }
      gxWriteGatherBursts += 1;
      gxWriteGatherBytesCommitted += gxWriteGatherBurstBytes;
      gxWriteGatherLastDestination = destination;
      return linked;
    }

    function appendGxWriteGatherBytes(source) {
      const appendState = preflightGxWriteGatherAppend(source.length);
      let producedLinkedBurst = false;
      let offset = 0;
      while (offset < source.length) {
        const pendingBeforeCopy = gxWriteGatherPendingBytes;
        const copied = Math.min(
          source.length - offset,
          gxWriteGatherBurstBytes - pendingBeforeCopy
        );
        const state = pendingBeforeCopy + copied === gxWriteGatherBurstBytes
          ? validateGxWriteGatherBurstState()
          : null;
        gxWriteGatherBuffer.set(
          source.subarray(offset, offset + copied),
          pendingBeforeCopy
        );
        gxWriteGatherPendingBytes += copied;
        gxWriteGatherHighWaterBytes = Math.max(
          gxWriteGatherHighWaterBytes,
          gxWriteGatherPendingBytes
        );
        offset += copied;
        if (gxWriteGatherPendingBytes !== gxWriteGatherBurstBytes) continue;

        producedLinkedBurst = commitGxWriteGatherBurst(state)
          || producedLinkedBurst;
        gxWriteGatherPendingBytes = 0;
      }
      if (producedLinkedBurst !== appendState.linked) {
        throw new Error("GX write-gather routing changed during one append");
      }
      return producedLinkedBurst;
    }

    function resetGxWriteGatherPipe() {
      gxWriteGatherDiscardedBytes += gxWriteGatherPendingBytes;
      gxWriteGatherPendingBytes = 0;
      gxWriteGatherResets += 1;
    }

    function resetGxCommandProcessorDecoder() {
      commandProcessorDecoderDiscardedBytes += gxDecodeBuffer.length;
      gxDecodeBuffer.length = 0;
      gxDecodeRetryAtBufferedBytes = 1;
      commandProcessorDecoderResets += 1;
    }

    function appendGxFifoBytes(
      source,
      stores,
      quantizedStores = 0,
      serviceLinkedFifo = true
    ) {
      const producedLinkedBurst = appendGxWriteGatherBytes(source);
      for (let index = 0; index < source.length; index += 1) {
        const byte = source[index];
        gxFifoHash = Math.imul(gxFifoHash ^ byte, 0x01000193) >>> 0;
        if (gxFifoSample.length < 256) gxFifoSample.push(byte);
      }
      gxFifoStores += stores;
      gxFifoBytes += source.length;
      gxFifoQuantizedStores += quantizedStores;
      if (producedLinkedBurst) {
        // Production is monotonic within one append, so a single sample here
        // preserves every threshold crossing before the bounded consumer runs
        // without adding an interrupt-MMIO round trip for every 32-byte burst.
        refreshCommandProcessorInterruptLevel("gather-append");
      }
      if (producedLinkedBurst && serviceLinkedFifo) {
        serviceCommandProcessorFifo();
      }
      return producedLinkedBurst;
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
      // This boundary intentionally includes appendGxFifoBytes and its nested
      // FIFO decode; fifoDecode reports that nested component separately. Keep
      // the staging record live until the hardware transport accepts it. An
      // unlinked PI destination never enters or preflights the CP decoder.
      const stagingStartedAt = beginWorkerPhaseTiming(
        workerHostTimings.fifoStagingDrainInclusive
      );
      try {
        const stores = view.getUint32(gxFifoStagingMeta + 4, true);
        const quantizedStores = view.getUint32(gxFifoStagingMeta + 8, true);
        const producedLinkedBurst = appendGxFifoBytes(
          bytes.subarray(gxFifoStagingData, gxFifoStagingData + pendingBytes),
          stores,
          quantizedStores,
          false
        );
        view.setUint32(gxFifoStagingMeta, 0, true);
        view.setUint32(gxFifoStagingMeta + 4, 0, true);
        view.setUint32(gxFifoStagingMeta + 8, 0, true);
        gxFifoStagingDrains += 1;
        gxFifoStagingStores += stores;
        gxFifoStagingBytes += pendingBytes;
        gxFifoStagingQuantizedStores += quantizedStores;
        if (producedLinkedBurst) serviceCommandProcessorFifo();
      } finally {
        recordWorkerPhaseTiming(
          workerHostTimings.fifoStagingDrainInclusive,
          stagingStartedAt
        );
      }
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
      const consumedMail = dspCurrentMail;
      traceDsp("mail-consumed", { mail: hex32(consumedMail) });
      dspCurrentMail = null;
      view.setUint16(mmio + 0x5004, 0, false);
      view.setUint16(mmio + 0x5006, 0, false);
      deviceEvents.set("dspMailConsumed", (deviceEvents.get("dspMailConsumed") ?? 0) + 1);
      if (
        dspMode === "ax"
        && dspAxCommandState.phase === "yield-pending"
        && consumedMail === 0xdcd10002
      ) {
        dspAxCommandState.phase = "task-wait";
        traceDsp("ax-yield-consumed", { mail: hex32(consumedMail) });
        deviceEvents.set(
          "dspAxYieldConsumed",
          (deviceEvents.get("dspAxYieldConsumed") ?? 0) + 1
        );
      }
      loadNextDspMail();
    }

    function emptyDspUcodeUpload() {
      return {
        ramAddress: null,
        length: null,
        imemAddress: null,
        dmemLength: null,
        startPc: null,
        malformed: false,
        malformedReason: null,
      };
    }

    function emptyDspAxCommandState() {
      return {
        phase: "waiting-size",
        sizeWords: 0,
        address: null,
        listCount: 0,
        wordCount: 0,
        commandCount: 0,
        commandSample: [],
        writeCount: 0,
        clearedBytes: 0,
        rejected: false,
        reason: null,
        lastTaskMail: null,
      };
    }

    function emptyDspZeldaCommandState() {
      return {
        phase: "waiting",
        expectedWords: 0,
        commandWordCount: 0,
        words: [],
        rejected: false,
        reason: null,
        lastCommand: null,
        lastSync: null,
        setup: null,
        render: emptyDspZeldaRenderState(),
      };
    }

    function emptyDspZeldaRenderState() {
      return {
        active: false,
        awaitingTaskMail: false,
        requestedFrames: 0,
        currentFrame: 0,
        currentVoice: 0,
        outputVolume: 0,
        outputLeftAddress: null,
        outputRightAddress: null,
        clearedBytes: 0,
      };
    }

    function dspUcodeHashEctor(source) {
      let hash = 0;
      for (const value of source) {
        hash = (hash ^ value) >>> 0;
        hash = ((hash << 3) | (hash >>> 29)) >>> 0;
      }
      return hash >>> 0;
    }

    function classifyDspUcode(hash) {
      switch (hash >>> 0) {
        case 0x3ad3b7ac:
        case 0x3daf59b9:
        case 0x4e8a8b21:
        case 0x07f88145:
        case 0xe2136399:
        case 0x3389a79e:
          return "ax";
        case 0x2fcdf1ec:
        case 0x42f64ac4:
          return "zelda";
        default:
          return null;
      }
    }

    function captureDspRomParameter(parameter, value) {
      const pair = parameter >>> 0;
      const payload = value >>> 0;
      traceDsp("ucode-parameter", {
        parameter: hex32(pair),
        value: hex32(payload),
      });

      let field;
      let captured;
      switch (pair) {
        case 0x80f3a001:
          field = "ramAddress";
          captured = payload;
          break;
        case 0x80f3a002:
          field = "length";
          captured = payload & 0xffff;
          break;
        case 0x80f3b002:
          field = "dmemLength";
          captured = payload & 0xffff;
          break;
        case 0x80f3c002:
          field = "imemAddress";
          captured = payload & 0xffff;
          break;
        case 0x80f3d001:
          field = "startPc";
          captured = payload & 0xffff;
          break;
        default:
          dspUcodeUpload.malformed = true;
          dspUcodeUpload.malformedReason = "unknown-parameter";
          return false;
      }

      if (dspUcodeUpload[field] !== null) {
        dspUcodeUpload.malformed = true;
        dspUcodeUpload.malformedReason = "duplicate-" + field;
        return false;
      }
      dspUcodeUpload[field] = captured;
      return true;
    }

    function rejectDspUcodeBoot(reason, details = {}) {
      dspMode = "rom";
      dspUcodeBooted = false;
      dspAxCommandState = emptyDspAxCommandState();
      dspZeldaCommandState = emptyDspZeldaCommandState();
      dspScheduledMail = null;
      traceDsp("ucode-boot-rejected", { reason, ...details });
      deviceEvents.set(
        "dspUcodeBootRejected",
        (deviceEvents.get("dspUcodeBootRejected") ?? 0) + 1
      );
      dspUcodeUpload = emptyDspUcodeUpload();
    }

    function bootDspUcode() {
      const upload = dspUcodeUpload;
      dspUcodeHash = null;
      if (upload.malformed) {
        rejectDspUcodeBoot(upload.malformedReason ?? "malformed-upload");
        return false;
      }
      const missing = [
        "ramAddress",
        "length",
        "imemAddress",
        "dmemLength",
        "startPc",
      ].filter(field => upload[field] === null);
      if (missing.length !== 0) {
        rejectDspUcodeBoot("missing-parameters", { missing });
        return false;
      }
      if (upload.length === 0) {
        rejectDspUcodeBoot("empty-iram");
        return false;
      }

      const source = ramPointer(upload.ramAddress, upload.length);
      if (source === null) {
        rejectDspUcodeBoot("iram-out-of-bounds", {
          ramAddress: hex32(upload.ramAddress),
          length: upload.length,
        });
        return false;
      }
      const hash = dspUcodeHashEctor(
        bytes.subarray(source, source + upload.length)
      );
      dspUcodeHash = hash;
      const mode = classifyDspUcode(hash);
      if (mode === null) {
        rejectDspUcodeBoot("unknown-hash", { hash: hex32(hash) });
        return false;
      }

      dspMode = mode;
      dspUcodeBooted = true;
      dspAxCommandState = emptyDspAxCommandState();
      dspZeldaCommandState = emptyDspZeldaCommandState();
      traceDsp("ucode-boot", {
        hash: hex32(hash),
        mode,
        ramAddress: hex32(upload.ramAddress),
        length: upload.length,
        imemAddress: upload.imemAddress,
        dmemLength: upload.dmemLength,
        startPc: upload.startPc,
      });
      pushDspMail(0xdcd10000, true, mode + "-ucode");
      if (mode === "zelda") {
        pushDspMail(0xf3551111, false, "zelda-ucode-handshake");
      }
      deviceEvents.set("dspUcodeBoot", (deviceEvents.get("dspUcodeBoot") ?? 0) + 1);
      dspUcodeUpload = emptyDspUcodeUpload();
      return true;
    }

    function rejectDspAxCommand(reason, details = {}) {
      dspAxCommandState.phase = "halted";
      dspAxCommandState.rejected = true;
      dspAxCommandState.reason = reason;
      dspScheduledMail = null;
      traceDsp("ax-command-rejected", { reason, ...details });
      deviceEvents.set(
        "dspAxCommandRejected",
        (deviceEvents.get("dspAxCommandRejected") ?? 0) + 1
      );
      return false;
    }

    function dspAxCommandArity(command) {
      switch (command) {
        case 0x00: return 2;
        case 0x01: return 5;
        case 0x02: return 2;
        case 0x03: return 0;
        case 0x04:
        case 0x05: return 4;
        case 0x06:
        case 0x07: return 2;
        case 0x08: return 10;
        case 0x09: return 2;
        case 0x0a:
        case 0x0b:
        case 0x0c: return 0;
        case 0x0d: return 3;
        case 0x0e: return 4;
        case 0x0f: return 0;
        case 0x10: return 4;
        case 0x11: return 2;
        case 0x12: return 4;
        case 0x13: return 12;
        default: return null;
      }
    }

    function dspAxAddress(high, low) {
      return (((high & 0xffff) << 16) | (low & 0xffff)) >>> 0;
    }

    function dspAxParseFailure(reason, details = {}) {
      return { ok: false, reason, details };
    }

    function dspAxSilentWriteRange(address, size, command) {
      const logical = address >>> 0;
      const pointer = ramPointer(logical, size);
      if (pointer === null) {
        return dspAxParseFailure("write-out-of-bounds", {
          command,
          address: hex32(logical),
          size,
        });
      }
      return {
        ok: true,
        write: {
          command,
          address: logical,
          physical: (pointer - ram) >>> 0,
          pointer,
          size,
        },
      };
    }

    function collectDspAxSilentWrites(command, arguments_, writes) {
      const ranges = [];
      switch (command) {
        case 0x04:
        case 0x05: {
          const address = dspAxAddress(arguments_[0], arguments_[1]);
          if (address !== 0) ranges.push([address, 3 * 5 * 32 * 4]);
          break;
        }
        case 0x06:
          ranges.push([
            dspAxAddress(arguments_[0], arguments_[1]),
            3 * 5 * 32 * 4,
          ]);
          break;
        case 0x0e:
          ranges.push([
            dspAxAddress(arguments_[0], arguments_[1]),
            5 * 32 * 4,
          ]);
          ranges.push([
            dspAxAddress(arguments_[2], arguments_[3]),
            5 * 32 * 2 * 2,
          ]);
          break;
        case 0x10:
          ranges.push([
            dspAxAddress(arguments_[0], arguments_[1]),
            2 * 5 * 32 * 4,
          ]);
          break;
        case 0x13:
          ranges.push([
            dspAxAddress(arguments_[0], arguments_[1]),
            3 * 5 * 32 * 4,
          ]);
          ranges.push([
            dspAxAddress(arguments_[2], arguments_[3]),
            5 * 32 * 4,
          ]);
          break;
        default:
          break;
      }

      for (const [address, size] of ranges) {
        const result = dspAxSilentWriteRange(address, size, command);
        if (!result.ok) return result;
        writes.push(result.write);
      }
      return { ok: true };
    }

    function parseDspAxCommandLists(initialAddress, initialSizeWords) {
      const maximumListWords = 511;
      const maximumLists = 32;
      const maximumTotalWords = 8192;
      const seenPhysicalAddresses = new Set();
      const writes = [];
      const commandSample = [];
      let address = initialAddress >>> 0;
      let sizeWords = initialSizeWords;
      let listCount = 0;
      let wordCount = 0;
      let commandCount = 0;

      while (true) {
        if (
          !Number.isSafeInteger(sizeWords)
          || sizeWords <= 0
          || sizeWords > maximumListWords
        ) {
          return dspAxParseFailure("invalid-list-size", {
            address: hex32(address),
            sizeWords,
          });
        }
        if (listCount >= maximumLists) {
          return dspAxParseFailure("list-limit", {
            address: hex32(address),
            maximumLists,
          });
        }
        if (wordCount + sizeWords > maximumTotalWords) {
          return dspAxParseFailure("word-limit", {
            address: hex32(address),
            wordCount: wordCount + sizeWords,
            maximumTotalWords,
          });
        }

        const byteLength = sizeWords * 2;
        const pointer = ramPointer(address, byteLength);
        if (pointer === null) {
          return dspAxParseFailure("list-out-of-bounds", {
            address: hex32(address),
            sizeWords,
          });
        }
        const physical = (pointer - ram) >>> 0;
        if (seenPhysicalAddresses.has(physical)) {
          return dspAxParseFailure("list-cycle", {
            address: hex32(address),
            physical: hex32(physical),
          });
        }
        seenPhysicalAddresses.add(physical);
        listCount += 1;
        wordCount += sizeWords;

        let index = 0;
        let chained = false;
        while (index < sizeWords) {
          const command = view.getUint16(pointer + index * 2, false);
          index += 1;
          const arity = dspAxCommandArity(command);
          if (arity === null) {
            return dspAxParseFailure("unknown-command", {
              command,
              list: listCount - 1,
              word: index - 1,
            });
          }
          if (command === 0x12 && dspUcodeHash === 0x4e8a8b21) {
            return dspAxParseFailure("unsupported-command-for-ucode", {
              command,
              hash: hex32(dspUcodeHash),
            });
          }
          if (index + arity > sizeWords) {
            return dspAxParseFailure("truncated-command", {
              command,
              list: listCount - 1,
              word: index - 1,
              arity,
              remaining: sizeWords - index,
            });
          }

          const arguments_ = [];
          for (let argument = 0; argument < arity; argument += 1) {
            arguments_.push(
              view.getUint16(pointer + (index + argument) * 2, false)
            );
          }
          index += arity;
          commandCount += 1;
          if (commandSample.length < 32) commandSample.push(command);

          const writeResult = collectDspAxSilentWrites(
            command,
            arguments_,
            writes
          );
          if (!writeResult.ok) return writeResult;

          if (command === 0x0f) {
            return {
              ok: true,
              address: initialAddress >>> 0,
              sizeWords: initialSizeWords,
              listCount,
              wordCount,
              commandCount,
              commandSample,
              writes,
            };
          }
          if (command === 0x0d) {
            address = dspAxAddress(arguments_[0], arguments_[1]);
            sizeWords = arguments_[2];
            chained = true;
            break;
          }
        }
        if (!chained) {
          return dspAxParseFailure("missing-end", {
            address: hex32(address),
            sizeWords,
          });
        }
      }
    }

    function applyDspAxSilentWrites(writes) {
      let clearedBytes = 0;
      for (const write of writes) {
        invalidateDataReservationForExternalWrite(
          write.physical,
          write.size
        );
        bytes.fill(0, write.pointer, write.pointer + write.size);
        clearedBytes += write.size;
        traceDsp("ax-silent-write", {
          command: write.command,
          address: hex32(write.address),
          size: write.size,
        });
      }
      return clearedBytes;
    }

    function beginDspAxCommandList(sizeWords) {
      if (
        !Number.isSafeInteger(sizeWords)
        || sizeWords <= 0
        || sizeWords >= 512
      ) {
        return rejectDspAxCommand("invalid-list-size", { sizeWords });
      }
      dspAxCommandState = {
        ...emptyDspAxCommandState(),
        phase: "waiting-address",
        sizeWords,
      };
      traceDsp("ax-command-list-size", { sizeWords });
      return true;
    }

    function executeDspAxCommandList(address) {
      const result = parseDspAxCommandLists(
        address,
        dspAxCommandState.sizeWords
      );
      if (!result.ok) {
        return rejectDspAxCommand(result.reason, result.details);
      }

      const clearedBytes = applyDspAxSilentWrites(result.writes);
      dspAxCommandState.phase = "yield-pending";
      dspAxCommandState.address = result.address;
      dspAxCommandState.listCount = result.listCount;
      dspAxCommandState.wordCount = result.wordCount;
      dspAxCommandState.commandCount = result.commandCount;
      dspAxCommandState.commandSample = result.commandSample;
      dspAxCommandState.writeCount = result.writes.length;
      dspAxCommandState.clearedBytes = clearedBytes;
      dspAxCommandState.rejected = false;
      dspAxCommandState.reason = null;
      dspScheduledMail = {
        mail: 0xdcd10002,
        completionCycle: cycles + 2500,
      };
      traceDsp("ax-command-list", {
        address: hex32(result.address),
        sizeWords: result.sizeWords,
        lists: result.listCount,
        words: result.wordCount,
        commands: result.commandCount,
        writes: result.writes.length,
        clearedBytes,
      });
      deviceEvents.set(
        "dspAxCommandList",
        (deviceEvents.get("dspAxCommandList") ?? 0) + 1
      );
      deviceEvents.set(
        "dspAxCommand",
        (deviceEvents.get("dspAxCommand") ?? 0) + result.commandCount
      );
      deviceEvents.set(
        "dspAxSilentWrite",
        (deviceEvents.get("dspAxSilentWrite") ?? 0) + result.writes.length
      );
      deviceEvents.set(
        "dspAxSilentBytes",
        (deviceEvents.get("dspAxSilentBytes") ?? 0) + clearedBytes
      );
      return true;
    }

    function handleDspAxMail(mail) {
      const payload = mail >>> 0;
      switch (dspAxCommandState.phase) {
        case "waiting-size":
          if (((payload & 0xffff0000) >>> 0) !== 0xbabe0000) {
            return rejectDspAxCommand("expected-list-size", {
              mail: hex32(payload),
            });
          }
          return beginDspAxCommandList(payload & 0xffff);

        case "waiting-address":
          return executeDspAxCommandList(payload);

        case "yield-pending":
          return rejectDspAxCommand("task-before-yield-consumed", {
            mail: hex32(payload),
            scheduled: dspScheduledMail !== null,
            currentMail: hex32(dspCurrentMail),
          });

        case "task-wait": {
          dspAxCommandState.lastTaskMail = payload;
          const action = payload & 0xffff;
          const canonicalMail = (0xcdd10000 | action) >>> 0;
          if (action === 0x0000) {
            dspAxCommandState.phase = "waiting-size";
            pushDspMail(0xdcd10001, true, "ax-task-resume");
            traceDsp("ax-task-resume", {
              mail: hex32(payload),
              canonicalMail: hex32(canonicalMail),
            });
            deviceEvents.set(
              "dspAxTaskResume",
              (deviceEvents.get("dspAxTaskResume") ?? 0) + 1
            );
            return true;
          }
          if (action === 0x0001) {
            return rejectDspAxCommand("unsupported-task-switch", {
              mail: hex32(payload),
              canonicalMail: hex32(canonicalMail),
            });
          }
          if (action === 0x0002) {
            traceDsp("ax-task-reset", {
              mail: hex32(payload),
              canonicalMail: hex32(canonicalMail),
            });
            resetDspMailbox();
            return true;
          }
          if (action === 0x0003) {
            dspAxCommandState.phase = "waiting-size";
            traceDsp("ax-task-continue", {
              mail: hex32(payload),
              canonicalMail: hex32(canonicalMail),
            });
            deviceEvents.set(
              "dspAxTaskContinue",
              (deviceEvents.get("dspAxTaskContinue") ?? 0) + 1
            );
            return true;
          }
          return rejectDspAxCommand("unsupported-task-mail", {
            mail: hex32(payload),
            canonicalMail: hex32(canonicalMail),
          });
        }

        case "halted":
          return false;

        default:
          return rejectDspAxCommand("invalid-state", {
            phase: dspAxCommandState.phase,
          });
      }
    }

    function rejectDspZeldaCommand(reason, details = {}) {
      dspZeldaCommandState.phase = "halted";
      dspZeldaCommandState.expectedWords = 0;
      dspZeldaCommandState.commandWordCount = 0;
      dspZeldaCommandState.words.length = 0;
      dspZeldaCommandState.rejected = true;
      dspZeldaCommandState.reason = reason;
      dspZeldaCommandState.render.active = false;
      traceDsp("zelda-command-rejected", { reason, ...details });
      deviceEvents.set(
        "dspZeldaCommandRejected",
        (deviceEvents.get("dspZeldaCommandRejected") ?? 0) + 1
      );
      return false;
    }

    function validateDspZeldaOutputRange(address, size) {
      return Number.isSafeInteger(size)
        && size > 0
        && ramPointer(address, size) !== null;
    }

    function clearDspZeldaSilentFrame() {
      const render = dspZeldaCommandState.render;
      const frameBytes = 0x50 * 2;
      const frameOffset = render.currentFrame * frameBytes;
      const leftAddress = (render.outputLeftAddress + frameOffset) >>> 0;
      const rightAddress = (render.outputRightAddress + frameOffset) >>> 0;
      const left = ramPointer(leftAddress, frameBytes);
      const right = ramPointer(rightAddress, frameBytes);
      if (left === null || right === null) {
        return rejectDspZeldaCommand("output-frame-out-of-bounds", {
          frame: render.currentFrame,
          leftAddress: hex32(leftAddress),
          rightAddress: hex32(rightAddress),
        });
      }

      invalidateDataReservationForExternalWrite((left - ram) >>> 0, frameBytes);
      invalidateDataReservationForExternalWrite((right - ram) >>> 0, frameBytes);
      bytes.fill(0, left, left + frameBytes);
      bytes.fill(0, right, right + frameBytes);
      render.clearedBytes += frameBytes * 2;
      traceDsp("zelda-silent-frame", {
        frame: render.currentFrame,
        leftAddress: hex32(leftAddress),
        rightAddress: hex32(rightAddress),
        bytes: frameBytes * 2,
      });
      deviceEvents.set(
        "dspZeldaSilentFrame",
        (deviceEvents.get("dspZeldaSilentFrame") ?? 0) + 1
      );
      return true;
    }

    function finishDspZeldaRenderFrame() {
      const render = dspZeldaCommandState.render;
      if (!clearDspZeldaSilentFrame()) return false;

      const completedFrame = render.currentFrame;
      pushDspMail(0xdcd10004, true, "zelda-render-sync");
      pushDspMail(
        (0xf355ff00 | completedFrame) >>> 0,
        false,
        "zelda-render-frame-ack"
      );
      render.currentFrame += 1;
      render.currentVoice = 0;
      dspZeldaCommandState.lastSync = (0xff00 | completedFrame) & 0xffff;
      deviceEvents.set(
        "dspZeldaRenderFrame",
        (deviceEvents.get("dspZeldaRenderFrame") ?? 0) + 1
      );

      if (render.currentFrame === render.requestedFrames) {
        render.active = false;
        render.awaitingTaskMail = true;
        dspZeldaCommandState.phase = "task-wait";
        pushDspMail(0xdcd10005, true, "zelda-render-frame-end");
        traceDsp("zelda-render-complete", {
          frames: render.requestedFrames,
          clearedBytes: render.clearedBytes,
        });
        deviceEvents.set(
          "dspZeldaRenderComplete",
          (deviceEvents.get("dspZeldaRenderComplete") ?? 0) + 1
        );
      } else {
        dspZeldaCommandState.phase = "waiting";
      }
      return true;
    }

    function handleDspZeldaMail(mail) {
      const payload = mail >>> 0;
      if (dspZeldaCommandState.phase === "halted") return false;

      if (
        (
          dspZeldaCommandState.phase === "waiting"
          || dspZeldaCommandState.phase === "task-wait"
        )
        && ((payload & 0xffff0000) >>> 0) === 0xcdd10000
      ) {
        if (payload === 0xcdd10000) {
          dspZeldaCommandState.phase = "halted";
          dspZeldaCommandState.render.active = false;
          dspZeldaCommandState.render.awaitingTaskMail = false;
          traceDsp("zelda-task-halt", { mail: hex32(payload) });
          deviceEvents.set(
            "dspZeldaTaskHalt",
            (deviceEvents.get("dspZeldaTaskHalt") ?? 0) + 1
          );
          return true;
        }
        if (payload === 0xcdd10001) {
          return rejectDspZeldaCommand("unsupported-task-switch", {
            mail: hex32(payload),
          });
        }
        if (payload === 0xcdd10002) {
          resetDspMailbox();
          return true;
        }
        if (payload !== 0xcdd10003) {
          return rejectDspZeldaCommand("unsupported-task-mail", {
            mail: hex32(payload),
          });
        }
        dspZeldaCommandState.render.awaitingTaskMail = false;
        dspZeldaCommandState.phase = "waiting";
        dspZeldaCommandState.rejected = false;
        dspZeldaCommandState.reason = null;
        traceDsp("zelda-task-continue", { mail: hex32(payload) });
        deviceEvents.set(
          "dspZeldaTaskContinue",
          (deviceEvents.get("dspZeldaTaskContinue") ?? 0) + 1
        );
        return true;
      }
      if (dspZeldaCommandState.phase === "task-wait") {
        return rejectDspZeldaCommand("expected-task-mail", {
          mail: hex32(payload),
        });
      }

      if (dspZeldaCommandState.phase === "rendering") {
        const render = dspZeldaCommandState.render;
        const group = payload >>> 16;
        const expectedGroup = render.currentVoice >>> 4;
        if (
          !render.active
          || group !== expectedGroup
          || group > 3
        ) {
          return rejectDspZeldaCommand("unsupported-render-sync", {
            sync: hex32(payload),
            group,
            expectedGroup,
          });
        }
        render.currentVoice += 16;
        traceDsp("zelda-render-sync", {
          frame: render.currentFrame,
          group,
          activeVoiceMap:
            "0x" + (payload & 0xffff).toString(16).padStart(4, "0"),
        });
        deviceEvents.set(
          "dspZeldaRenderSync",
          (deviceEvents.get("dspZeldaRenderSync") ?? 0) + 1
        );
        if (render.currentVoice === dspZeldaCommandState.setup.voicesPerFrame) {
          return finishDspZeldaRenderFrame();
        }
        dspZeldaCommandState.phase = "waiting";
        return true;
      }

      if (dspZeldaCommandState.phase === "waiting") {
        // The standard Zelda/JAudio protocol starts each command with the
        // raw number of following 32-bit words. During rendering, a zero
        // count transfers the next per-16-voice synchronization bitmap.
        if (payload === 0 && dspZeldaCommandState.render.active) {
          dspZeldaCommandState.phase = "rendering";
          return true;
        }
        if (dspZeldaCommandState.render.active) {
          return rejectDspZeldaCommand("command-during-render", {
            count: hex32(payload),
            frame: dspZeldaCommandState.render.currentFrame,
            voice: dspZeldaCommandState.render.currentVoice,
          });
        }
        if (payload !== 5 && payload !== 3) {
          return rejectDspZeldaCommand("unsupported-count", {
            count: hex32(payload),
          });
        }
        dspZeldaCommandState.phase = "writing";
        dspZeldaCommandState.expectedWords = payload;
        dspZeldaCommandState.commandWordCount = payload;
        dspZeldaCommandState.words.length = 0;
        dspZeldaCommandState.rejected = false;
        dspZeldaCommandState.reason = null;
        return true;
      }

      if (dspZeldaCommandState.phase !== "writing") {
        return rejectDspZeldaCommand("invalid-state", {
          phase: dspZeldaCommandState.phase,
        });
      }

      dspZeldaCommandState.words.push(payload);
      dspZeldaCommandState.expectedWords -= 1;
      if (dspZeldaCommandState.expectedWords !== 0) return true;

      const words = dspZeldaCommandState.words.slice();
      const commandWordCount = dspZeldaCommandState.commandWordCount;
      const commandMail = words[0] >>> 0;
      if ((commandMail & 0x80000000) === 0) {
        return rejectDspZeldaCommand("malformed-command", {
          command: hex32(commandMail),
        });
      }
      const command = (commandMail >>> 24) & 0x7f;
      const expectedCommandWords = command === 0x01
        ? 5
        : command === 0x02
          ? 3
          : null;
      if (expectedCommandWords === null) {
        return rejectDspZeldaCommand("unsupported-command", {
          command,
          commandMail: hex32(commandMail),
        });
      }
      if (commandWordCount !== expectedCommandWords) {
        return rejectDspZeldaCommand("malformed-command-envelope", {
          command,
          commandMail: hex32(commandMail),
          words: commandWordCount,
          expectedWords: expectedCommandWords,
        });
      }

      const sync = (commandMail >>> 16) & 0xffff;
      dspZeldaCommandState.phase = "waiting";
      dspZeldaCommandState.expectedWords = 0;
      dspZeldaCommandState.commandWordCount = 0;
      dspZeldaCommandState.words.length = 0;
      dspZeldaCommandState.lastCommand = commandMail;
      dspZeldaCommandState.lastSync = sync;
      traceDsp("zelda-command", {
        command,
        commandMail: hex32(commandMail),
        sync: "0x" + sync.toString(16).padStart(4, "0"),
      });
      deviceEvents.set(
        "dspZeldaCommand",
        (deviceEvents.get("dspZeldaCommand") ?? 0) + 1
      );

      if (command === 0x01) {
        dspZeldaCommandState.setup = {
          voicesPerFrame: commandMail & 0xffff,
          vpbBaseAddress: words[1] >>> 0,
          coefficientAddress: words[2] >>> 0,
          afcCoeffAddress: words[3] >>> 0,
          reverbPbBaseAddress: words[4] >>> 0,
        };
        traceDsp("zelda-setup", {
          voicesPerFrame: dspZeldaCommandState.setup.voicesPerFrame,
          vpbBaseAddress: hex32(dspZeldaCommandState.setup.vpbBaseAddress),
          coefficientAddress: hex32(
            dspZeldaCommandState.setup.coefficientAddress
          ),
          afcCoeffAddress: hex32(dspZeldaCommandState.setup.afcCoeffAddress),
          reverbPbBaseAddress: hex32(
            dspZeldaCommandState.setup.reverbPbBaseAddress
          ),
        });
        deviceEvents.set(
          "dspZeldaSetup",
          (deviceEvents.get("dspZeldaSetup") ?? 0) + 1
        );

        // Dolphin's standard Zelda protocol acknowledges setup commands in
        // this exact order: interrupting DSP_SYNC, then the non-interrupt
        // F355 token carrying the command's sync value.
        pushDspMail(0xdcd10004, true, "zelda-command-sync");
        pushDspMail((0xf3550000 | sync) >>> 0, false, "zelda-command-ack");
        return true;
      }

      const setup = dspZeldaCommandState.setup;
      if (setup === null) {
        return rejectDspZeldaCommand("render-before-setup");
      }
      if (setup.voicesPerFrame !== 0x40) {
        return rejectDspZeldaCommand("unsupported-voice-count", {
          voicesPerFrame: setup.voicesPerFrame,
        });
      }
      const requestedFrames = (commandMail >>> 16) & 0xff;
      if (requestedFrames === 0) {
        return rejectDspZeldaCommand("empty-render");
      }
      const outputBytes = requestedFrames * 0x50 * 2;
      const outputLeftAddress = words[1] >>> 0;
      const outputRightAddress = words[2] >>> 0;
      if (
        !validateDspZeldaOutputRange(outputLeftAddress, outputBytes)
        || !validateDspZeldaOutputRange(outputRightAddress, outputBytes)
      ) {
        return rejectDspZeldaCommand("output-out-of-bounds", {
          frames: requestedFrames,
          bytesPerChannel: outputBytes,
          leftAddress: hex32(outputLeftAddress),
          rightAddress: hex32(outputRightAddress),
        });
      }
      dspZeldaCommandState.render = {
        active: true,
        awaitingTaskMail: false,
        requestedFrames,
        currentFrame: 0,
        currentVoice: 0,
        outputVolume: commandMail & 0xffff,
        outputLeftAddress,
        outputRightAddress,
        clearedBytes: 0,
      };
      traceDsp("zelda-render-command", {
        frames: requestedFrames,
        voicesPerFrame: setup.voicesPerFrame,
        outputVolume: dspZeldaCommandState.render.outputVolume,
        outputLeftAddress: hex32(outputLeftAddress),
        outputRightAddress: hex32(outputRightAddress),
        bytesPerChannel: outputBytes,
      });
      deviceEvents.set(
        "dspZeldaRenderCommand",
        (deviceEvents.get("dspZeldaRenderCommand") ?? 0) + 1
      );

      // Dolphin's standard Zelda protocol acknowledges commands in this
      // family only after each requested audio frame has completed. The
      // renderer therefore waits for the first zero-count synchronization
      // pair and deliberately emits no command-02 ACK here.
      return true;
    }

    function resetDspMailbox() {
      dspMailQueue.length = 0;
      dspCurrentMail = null;
      dspCpuMailbox = 0;
      dspRomParameter = null;
      dspUcodeUpload = emptyDspUcodeUpload();
      dspUcodeHash = null;
      dspMode = "rom";
      dspUcodeBooted = false;
      dspAxCommandState = emptyDspAxCommandState();
      dspZeldaCommandState = emptyDspZeldaCommandState();
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
      dspUcodeUpload = emptyDspUcodeUpload();
      dspUcodeHash = null;
      dspMode = "init";
      dspUcodeBooted = false;
      dspAxCommandState = emptyDspAxCommandState();
      dspZeldaCommandState = emptyDspZeldaCommandState();
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
          captureDspRomParameter(parameter, mail);
          if (parameter === 0x80f3d001) bootDspUcode();
        }
      } else if (dspMode === "ax") {
        handleDspAxMail(mail);
      } else if (dspMode === "zelda") {
        handleDspZeldaMail(mail);
      }
    }

    function resetFifoRegisterState() {
      cpFifoState.control = 0;
      cpFifoState.base = 0;
      cpFifoState.end = 0;
      cpFifoState.highWatermark = 0;
      cpFifoState.lowWatermark = 0;
      cpFifoState.distance = 0;
      cpFifoState.writePointer = 0;
      cpFifoState.readPointer = 0;
      cpFifoState.breakpoint = 0;
      piFifoState.base = 0;
      piFifoState.end = 0;
      piFifoState.current = 0;
      piFifoState.wrap = false;
      resetCommandProcessorInterruptState("fifo-register-reset");
    }

    function resetCommandProcessorFifoFromPi() {
      cpFifoState.control = cpControlLinkEnable;
      cpFifoState.highWatermark = cpFifoAddressMask;
      cpFifoState.lowWatermark = 0;
      resetCommandProcessorInterruptState("pi-fifo-reset");
    }

    function commandProcessorBreakpointLevel() {
      return (cpFifoState.control & cpControlBreakpointEnable) !== 0
        && cpFifoState.readPointer === cpFifoState.breakpoint;
    }

    function readCommandProcessorStatus() {
      // The browser command processor is synchronous for now, unlike the
      // hardware's independently consuming GP. Guest-published distance is
      // therefore the canonical empty/read-idle source. Later gather and GP
      // routing must advance distance in lockstep with their write/read
      // pointers (including wrap); pointer equality cannot distinguish empty
      // from full and must never silently replace that invariant.
      const empty = cpFifoState.distance === 0;
      const breakpoint = commandProcessorBreakpointLevel();
      const readEnabled = (cpFifoState.control & cpControlReadEnable) !== 0;
      return (
        (cpFifoState.distance > cpFifoState.highWatermark
          ? cpStatusHighWatermark
          : 0)
        | (cpFifoState.distance < cpFifoState.lowWatermark
          ? cpStatusLowWatermark
          : 0)
        | (empty ? cpStatusReadIdle : 0)
        | (empty || !readEnabled || breakpoint ? cpStatusCommandIdle : 0)
        | (breakpoint ? cpStatusBreakpoint : 0)
      );
    }

    function commandProcessorInterruptInputs() {
      const status = readCommandProcessorStatus();
      const readEnabled = (cpFifoState.control & cpControlReadEnable) !== 0;
      const highQualified = readEnabled
        && (status & cpStatusHighWatermark) !== 0;
      const lowQualified = readEnabled
        && (status & cpStatusLowWatermark) !== 0;
      const breakpointQualified = readEnabled
        && (status & cpStatusBreakpoint) !== 0;
      return {
        status,
        highQualified,
        lowQualified,
        breakpointQualified,
        qualifiedSources: (
          (highQualified ? cpStatusHighWatermark : 0)
          | (lowQualified ? cpStatusLowWatermark : 0)
          | (breakpointQualified ? cpStatusBreakpoint : 0)
        ),
      };
    }

    function traceCommandProcessorInterrupt(reason, inputs, force = false) {
      const cause = view.getUint32(mmio + 0x3000, false);
      const pending = (
        (commandProcessorHighInterruptPending ? cpStatusHighWatermark : 0)
        | (commandProcessorLowInterruptPending ? cpStatusLowWatermark : 0)
      );
      const signature = [
        cpFifoState.control,
        inputs.status & (
          cpStatusHighWatermark | cpStatusLowWatermark | cpStatusBreakpoint
        ),
        inputs.qualifiedSources,
        pending,
        commandProcessorInterruptLevelActive ? 1 : 0,
        cause & piCommandProcessorInterruptCause,
      ].join(":");
      if (!force && signature === commandProcessorInterruptTraceSignature) return;
      commandProcessorInterruptTraceSignature = signature;
      commandProcessorInterruptTrace.push({
        cycle: cycles,
        reason,
        control: "0x" + cpFifoState.control.toString(16).padStart(4, "0"),
        status: "0x" + inputs.status.toString(16).padStart(4, "0"),
        qualifiedSources: "0x"
          + inputs.qualifiedSources.toString(16).padStart(4, "0"),
        pending: "0x" + pending.toString(16).padStart(4, "0"),
        distance: hex32(cpFifoState.distance),
        writePointer: hex32(cpFifoState.writePointer),
        readPointer: hex32(cpFifoState.readPointer),
        cause: hex32(cause),
        mask: hex32(view.getUint32(mmio + 0x3004, false)),
      });
      if (commandProcessorInterruptTrace.length > 48) {
        commandProcessorInterruptTrace.shift();
      }
    }

    function refreshCommandProcessorInterruptLevel(reason) {
      const inputs = commandProcessorInterruptInputs();
      // Watermark pending state belongs to the CP source, not to the PI
      // request gate. Real hardware keeps a legitimate pending watermark
      // sticky until producer/consumer movement resolves its raw level, even
      // if software disables that source's interrupt-enable bit meanwhile.
      if (inputs.highQualified && !commandProcessorHighInterruptPending) {
        commandProcessorHighInterruptAssertions += 1;
      }
      if (inputs.lowQualified && !commandProcessorLowInterruptPending) {
        commandProcessorLowInterruptAssertions += 1;
      }
      if (inputs.highQualified) commandProcessorHighInterruptPending = true;
      if (inputs.lowQualified) commandProcessorLowInterruptPending = true;

      const readEnabled = (cpFifoState.control & cpControlReadEnable) !== 0;
      const request = readEnabled && (
        (
          (cpFifoState.control & cpControlHighWatermarkInterruptEnable) !== 0
          && commandProcessorHighInterruptPending
        )
        || (
          (cpFifoState.control & cpControlLowWatermarkInterruptEnable) !== 0
          && commandProcessorLowInterruptPending
        )
        || (
          (cpFifoState.control & cpControlBreakpointInterruptEnable) !== 0
          && inputs.breakpointQualified
        )
      );
      const beforeCause = view.getUint32(mmio + 0x3000, false);
      const cause = (
        request
          ? beforeCause | piCommandProcessorInterruptCause
          : beforeCause & ~piCommandProcessorInterruptCause
      ) >>> 0;
      if (
        (beforeCause & piCommandProcessorInterruptCause) === 0
        && (cause & piCommandProcessorInterruptCause) !== 0
      ) {
        commandProcessorPiAssertions += 1;
      } else if (
        (beforeCause & piCommandProcessorInterruptCause) !== 0
        && (cause & piCommandProcessorInterruptCause) === 0
      ) {
        commandProcessorPiDeassertions += 1;
      }
      view.setUint32(mmio + 0x3000, cause, false);
      commandProcessorQualifiedInterruptSources = inputs.qualifiedSources;
      commandProcessorInterruptLevelActive = request;
      traceCommandProcessorInterrupt(reason, inputs);
      return request;
    }

    function clearCommandProcessorInterrupts(value) {
      const written = value & (
        cpClearHighWatermarkInterrupt
        | cpClearLowWatermarkInterrupt
        | cpClearPerformanceMetrics
      );
      let cleared = 0;
      if (
        (written & cpClearHighWatermarkInterrupt) !== 0
        && commandProcessorHighInterruptPending
      ) {
        commandProcessorHighInterruptPending = false;
        commandProcessorInterruptClears += 1;
        cleared |= cpClearHighWatermarkInterrupt;
      }
      if (
        (written & cpClearLowWatermarkInterrupt) !== 0
        && commandProcessorLowInterruptPending
      ) {
        commandProcessorLowInterruptPending = false;
        commandProcessorInterruptClears += 1;
        cleared |= cpClearLowWatermarkInterrupt;
      }
      if ((written & cpClearPerformanceMetrics) !== 0) {
        commandProcessorPerformanceMetricClears += 1;
      }

      refreshCommandProcessorInterruptLevel("cp-clear");
      if (
        (cleared & cpClearHighWatermarkInterrupt) !== 0
        && commandProcessorHighInterruptPending
      ) {
        commandProcessorActiveClearReassertions += 1;
      }
      if (
        (cleared & cpClearLowWatermarkInterrupt) !== 0
        && commandProcessorLowInterruptPending
      ) {
        commandProcessorActiveClearReassertions += 1;
      }
      traceCommandProcessorInterrupt(
        "cp-clear-complete",
        commandProcessorInterruptInputs(),
        true
      );
    }

    function resetCommandProcessorInterruptState(reason) {
      commandProcessorHighInterruptPending = false;
      commandProcessorLowInterruptPending = false;
      commandProcessorQualifiedInterruptSources = 0;
      commandProcessorInterruptLevelActive = false;
      commandProcessorInterruptResets += 1;
      const cause = view.getUint32(mmio + 0x3000, false)
        & ~piCommandProcessorInterruptCause;
      view.setUint32(mmio + 0x3000, cause >>> 0, false);
      commandProcessorInterruptTraceSignature = null;
      traceCommandProcessorInterrupt(
        reason,
        commandProcessorInterruptInputs(),
        true
      );
    }

    function writeProcessorInterfaceInterruptCause(value) {
      const current = view.getUint32(mmio + 0x3000, false);
      view.setUint32(mmio + 0x3000, current & ~(value >>> 0), false);
      // PI cause is W1C, but CP and EXI are level sources. Hardware therefore
      // reasserts either cause immediately while its request remains active.
      refreshCommandProcessorInterruptLevel("pi-cause-w1c");
      refreshExternalInterfaceInterruptLevel("pi-cause-w1c");
    }

    function serviceCommandProcessorInterrupt(observedCycles) {
      refreshCommandProcessorInterruptLevel("mmio-service");
      const cause = view.getUint32(mmio + 0x3000, false);
      const mask = view.getUint32(mmio + 0x3004, false);
      const msr = view.getUint32(cpu + msrOffset, true);
      if (
        (cause & mask & piCommandProcessorInterruptCause) === 0
        || (msr & 0x00008000) === 0
      ) {
        return false;
      }

      commandProcessorExternalInterruptDeliveries += 1;
      deviceEvents.set(
        "commandProcessorExternalInterrupt",
        (deviceEvents.get("commandProcessorExternalInterrupt") ?? 0) + 1
      );
      deviceEvents.set(
        "externalInterrupt",
        (deviceEvents.get("externalInterrupt") ?? 0) + 1
      );
      traceCommandProcessorInterrupt(
        "pi-deliver@" + observedCycles,
        commandProcessorInterruptInputs(),
        true
      );
      raiseException(cpu, 0x0500);
      return true;
    }

    function commandProcessorPairValue(lowOffset) {
      switch (lowOffset) {
        case 0x20: return cpFifoState.base;
        case 0x24: return cpFifoState.end;
        case 0x28: return cpFifoState.highWatermark;
        case 0x2c: return cpFifoState.lowWatermark;
        case 0x30: return cpFifoState.distance;
        case 0x34: return cpFifoState.writePointer;
        case 0x38: return cpFifoState.readPointer;
        case 0x3c: return cpFifoState.breakpoint;
        default: return null;
      }
    }

    function writeCommandProcessorPairValue(lowOffset, value) {
      const masked = value & cpFifoAddressMask;
      switch (lowOffset) {
        case 0x20: cpFifoState.base = masked; break;
        case 0x24: cpFifoState.end = masked; break;
        case 0x28: cpFifoState.highWatermark = masked; break;
        case 0x2c: cpFifoState.lowWatermark = masked; break;
        case 0x30: cpFifoState.distance = masked; break;
        case 0x34: cpFifoState.writePointer = masked; break;
        case 0x38: cpFifoState.readPointer = masked; break;
        case 0x3c: cpFifoState.breakpoint = masked; break;
        default: return false;
      }
      return true;
    }

    function commandProcessorRegisterRangeOverlaps(physical, size) {
      if (!Number.isInteger(physical) || !Number.isInteger(size) || size <= 0) {
        return false;
      }
      const end = physical + size;
      return (
        physical < 0x0c000006 && end > 0x0c000000
      ) || (
        physical < 0x0c000040 && end > 0x0c000020
      );
    }

    function readCommandProcessorRegister(physical, size) {
      if (size !== 2 || physical < 0x0c000000 || physical > 0x0c00003e) {
        return null;
      }
      const offset = physical - 0x0c000000;
      if (offset === 0x00) return readCommandProcessorStatus();
      if (offset === 0x02) return cpFifoState.control;
      if (offset === 0x04) return 0;
      if (offset < 0x20 || (offset & 1) !== 0) return null;
      const lowOffset = offset & ~0x02;
      const pair = commandProcessorPairValue(lowOffset);
      if (pair === null) return null;
      return (offset & 0x02) === 0
        ? pair & 0xffff
        : (pair >>> 16) & cpFifoHighWordMask;
    }

    function writeCommandProcessorRegister(physical, value, size) {
      if (size !== 2 || physical < 0x0c000000 || physical > 0x0c00003e) {
        return false;
      }
      const offset = physical - 0x0c000000;
      if (offset === 0x00) return true;
      if (offset === 0x04) {
        clearCommandProcessorInterrupts(value);
        return true;
      }
      if (offset === 0x02) {
        cpFifoState.control = value & cpControlMask;
        serviceCommandProcessorFifo();
        return true;
      }
      if (offset < 0x20 || (offset & 1) !== 0) return false;
      const lowOffset = offset & ~0x02;
      const current = commandProcessorPairValue(lowOffset);
      if (current === null) return false;
      const next = (offset & 0x02) === 0
        ? (current & 0x03ff0000) | (value & cpFifoLowWordMask)
        : (current & 0x0000ffff) | ((value & cpFifoHighWordMask) << 16);
      const written = writeCommandProcessorPairValue(lowOffset, next);
      if (written && (offset & 0x02) !== 0) {
        if ([0x30, 0x38, 0x3c].includes(lowOffset)) {
          serviceCommandProcessorFifo();
        } else if ([0x28, 0x2c].includes(lowOffset)) {
          refreshCommandProcessorInterruptLevel(
            "cp-pair-0x" + lowOffset.toString(16).padStart(2, "0")
          );
        }
      }
      return written;
    }

    function readProcessorInterfaceFifoRegister(physical, size) {
      if (size !== 4) return null;
      switch (physical) {
        case 0x0c00300c: return piFifoState.base;
        case 0x0c003010: return piFifoState.end;
        case 0x0c003014:
          return (piFifoState.current | (piFifoState.wrap ? piFifoWrap : 0)) >>> 0;
        case 0x0c003018: return 0;
        default: return null;
      }
    }

    function writeProcessorInterfaceFifoRegister(physical, value, size) {
      if (size !== 4) return false;
      const written = value >>> 0;
      switch (physical) {
        case 0x0c00300c:
          piFifoState.base = written & cpFifoAddressMask;
          return true;
        case 0x0c003010:
          piFifoState.end = written & piFifoEndMask;
          return true;
        case 0x0c003014:
          piFifoState.current = written & cpFifoAddressMask;
          piFifoState.wrap = (written & piFifoWrap) !== 0;
          return true;
        case 0x0c003018:
          if ((written & 1) !== 0) {
            resetGxWriteGatherPipe();
            resetGxCommandProcessorDecoder();
            resetCommandProcessorFifoFromPi();
          }
          return true;
        default: return false;
      }
    }

    function snapshotCommandProcessorFifo() {
      return {
        status: "0x" + readCommandProcessorStatus().toString(16).padStart(4, "0"),
        control: "0x" + cpFifoState.control.toString(16).padStart(4, "0"),
        base: hex32(cpFifoState.base),
        end: hex32(cpFifoState.end),
        highWatermark: hex32(cpFifoState.highWatermark),
        lowWatermark: hex32(cpFifoState.lowWatermark),
        distance: hex32(cpFifoState.distance),
        writePointer: hex32(cpFifoState.writePointer),
        readPointer: hex32(cpFifoState.readPointer),
        breakpoint: hex32(cpFifoState.breakpoint),
        breakpointLevel: commandProcessorBreakpointLevel(),
        interrupt: {
          highPending: commandProcessorHighInterruptPending,
          lowPending: commandProcessorLowInterruptPending,
          qualifiedSources: "0x"
            + commandProcessorQualifiedInterruptSources
              .toString(16).padStart(4, "0"),
          levelActive: commandProcessorInterruptLevelActive,
          piCause: (
            view.getUint32(mmio + 0x3000, false)
            & piCommandProcessorInterruptCause
          ) !== 0,
          highAssertions: commandProcessorHighInterruptAssertions,
          lowAssertions: commandProcessorLowInterruptAssertions,
          clears: commandProcessorInterruptClears,
          activeClearReassertions: commandProcessorActiveClearReassertions,
          performanceMetricClears: commandProcessorPerformanceMetricClears,
          piAssertions: commandProcessorPiAssertions,
          piDeassertions: commandProcessorPiDeassertions,
          externalDeliveries: commandProcessorExternalInterruptDeliveries,
          resets: commandProcessorInterruptResets,
          trace: commandProcessorInterruptTrace,
        },
      };
    }

    function snapshotProcessorInterfaceFifo() {
      return {
        base: hex32(piFifoState.base),
        end: hex32(piFifoState.end),
        current: hex32(piFifoState.current),
        wrap: piFifoState.wrap,
        currentRegister: hex32(
          (piFifoState.current | (piFifoState.wrap ? piFifoWrap : 0)) >>> 0
        ),
      };
    }

    function readInteger(address, pointer, size) {
      const logical = address >>> 0;
      const resolved = typeof resolveDataRange === "function"
        ? resolveDataRange(logical, size, false, true)
        : null;
      const physical = resolved === null
        ? translateDataRange(logical, size, false, true)
        : resolved.kind === "mapped"
          ? resolved.physical
          : null;
      if (physical === null) {
        return typeof recordDataStorageFault === "function"
          ? recordDataStorageFault(
              resolved ?? { kind: "translation-failed", effective: logical },
              logical,
              size,
              false,
              "translation"
            )
          : 0;
      }
      const mapped = {
        kind: "mapped",
        effective: logical,
        physical,
      };
      const reject = (stage, reason) => (
        typeof recordDataStorageFault === "function"
          ? recordDataStorageFault(
              mapped,
              logical,
              size,
              false,
              stage,
              reason
            )
          : 0
      );
      if (physical >= 0x0c002000 && physical < 0x0c003000) {
        const videoInterfaceRead = readVideoInterfaceRegister(
          physical,
          size,
          cycles
        );
        if (videoInterfaceRead.handled) {
          if (videoInterfaceRead.value === null) {
            return reject("device", "video-interface-register-rejected");
          }
          switch (size) {
            case 1:
              view.setUint8(pointer, videoInterfaceRead.value);
              break;
            case 2:
              view.setUint16(pointer, videoInterfaceRead.value, true);
              break;
            case 4:
              view.setUint32(pointer, videoInterfaceRead.value, true);
              break;
            default:
              return reject("format", "integer-size-rejected");
          }
          return 1;
        }
      }
      if (
        physical < 0x0c000040
        && physical + size > 0x0c000000
        && commandProcessorRegisterRangeOverlaps(physical, size)
      ) {
        const commandProcessorValue = readCommandProcessorRegister(physical, size);
        if (commandProcessorValue === null) {
          return reject("device", "command-processor-register-rejected");
        }
        view.setUint16(pointer, commandProcessorValue, true);
        return 1;
      }
      if (
        physical < 0x0c00301c
        && physical + size > 0x0c00300c
      ) {
        const processorInterfaceFifoValue = readProcessorInterfaceFifoRegister(
          physical,
          size
        );
        if (processorInterfaceFifoValue === null) {
          return reject("device", "processor-interface-fifo-register-rejected");
        }
        view.setUint32(pointer, processorInterfaceFifoValue, true);
        return 1;
      }
      for (let channel = 0; channel < 3; channel += 1) {
        const channelBase = 0x0c006800 + channel * 0x14;
        for (const registerOffset of [4, 8, 12]) {
          const register = channelBase + registerOffset;
          if (physical >= register + 4 || physical + size <= register) continue;
          if (physical === register && size === 4) {
            view.setUint32(
              pointer,
              readExternalInterfaceTransferRegister(
                channel,
                registerOffset
              ),
              true
            );
            return 1;
          }
          return reject(
            "device",
            "external-interface-transfer-register-rejected"
          );
        }
      }
      if (physical === 0x0c006c08 && size === 4) {
        updateAudioSampleCounter(cycles);
      }
      if (physical === 0x0c00503a && size === 2) {
        view.setUint16(pointer, dspAudioDmaBlocksLeft(), true);
        return 1;
      }
      if (physical === 0x0c005038 && size === 4) {
        publishDspAudioDmaBlocksLeft();
      }
      const lockedSource = physicalLockedCachePointer(physical, size);
      const source = physicalRamPointer(physical, size)
        ?? physicalMmioPointer(physical, size)
        ?? lockedSource;
      if (source === null) {
        return reject("physical", "translated-physical-unbacked");
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
          return reject("format", "integer-size-rejected");
      }
      if (lockedSource !== null) {
        lockedCacheReads += 1;
        lockedCacheReadBytes += size;
      }
      if (physical === 0x0c005006 && size === 2) consumeDspMail();
      if (size === 4 && physical >= 0x0c006404 && physical <= 0x0c00642c) {
        const channelOffset = physical - 0x0c006404;
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
      if ((written & 0x04) !== 0) {
        peTokenSignal = false;
        peTokenInterruptDelivered = false;
        deviceEvents.set(
          "peTokenAcknowledge",
          (deviceEvents.get("peTokenAcknowledge") ?? 0) + 1
        );
      }
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
        invalidateDataReservationForExternalWrite(
          (ramTarget - ram) >>> 0,
          length
        );
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
      const hardwareOwned = interruptStatuses | 0x0200;
      const status = (current & hardwareOwned) & ~(written & interruptStatuses);
      let next = (written & ~hardwareOwned) | status;
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
      dspCpuMailbox = (((value & 0xffff) << 16) | (dspCpuMailbox & 0xffff)) >>> 0;
      view.setUint16(mmio + 0x5000, value & 0x7fff, false);
    }

    function writeDspMailboxLow(value) {
      dspCpuMailbox = ((dspCpuMailbox & 0xffff0000) | (value & 0xffff)) >>> 0;
      view.setUint16(
        mmio + 0x5000,
        ((dspCpuMailbox >>> 16) & 0x7fff) | 0x8000,
        false
      );
      view.setUint16(mmio + 0x5002, dspCpuMailbox & 0xffff, false);
      handleDspCpuMail(dspCpuMailbox >>> 0);
      dspCpuMailbox &= 0x7fffffff;
      view.setUint16(mmio + 0x5000, (dspCpuMailbox >>> 16) & 0x7fff, false);
    }

    function writeInteger(address, value, size) {
      const logical = address >>> 0;
      const resolved = typeof resolveDataRange === "function"
        ? resolveDataRange(logical, size, true, true)
        : null;
      const physical = resolved === null
        ? translateDataRange(logical, size, true, true)
        : resolved.kind === "mapped"
          ? resolved.physical
          : null;
      if (physical === null) {
        return typeof recordDataStorageFault === "function"
          ? recordDataStorageFault(
              resolved ?? { kind: "translation-failed", effective: logical },
              logical,
              size,
              true,
              "translation",
              undefined,
              value
            )
          : 0;
      }
      const mapped = {
        kind: "mapped",
        effective: logical,
        physical,
      };
      const reject = (stage, reason) => (
        typeof recordDataStorageFault === "function"
          ? recordDataStorageFault(
              mapped,
              logical,
              size,
              true,
              stage,
              reason,
              value
            )
          : 0
      );
      if (
        physical >= 0x0c002000
        && physical < 0x0c003000
      ) {
        if (writeVideoInterfaceRegister(physical, value, size, cycles)) return 1;
        return reject("device", "video-interface-register-rejected");
      }
      if (
        physical < 0x0c003004
        && physical + size > 0x0c003000
      ) {
        if (physical === 0x0c003000 && size === 4) {
          writeProcessorInterfaceInterruptCause(value);
          return 1;
        }
        return reject("device", "processor-interface-register-rejected");
      }
      if (
        physical < 0x0c000040
        && physical + size > 0x0c000000
        && commandProcessorRegisterRangeOverlaps(physical, size)
      ) {
        if (writeCommandProcessorRegister(physical, value, size)) return 1;
        return reject("device", "command-processor-register-rejected");
      }
      if (
        physical < 0x0c00301c
        && physical + size > 0x0c00300c
      ) {
        if (writeProcessorInterfaceFifoRegister(physical, value, size)) return 1;
        return reject("device", "processor-interface-fifo-register-rejected");
      }
      for (let channel = 0; channel < 3; channel += 1) {
        const parameter = 0x0c006800 + channel * 0x14;
        if (physical >= parameter + 4 || physical + size <= parameter) continue;
        if (physical === parameter && size === 4) {
          writeExternalInterfaceParameter(channel, value);
          return 1;
        }
        return reject(
          "device",
          "external-interface-parameter-register-rejected"
        );
      }
      for (let channel = 0; channel < 3; channel += 1) {
        const channelBase = 0x0c006800 + channel * 0x14;
        for (const registerOffset of [4, 8, 12]) {
          const register = channelBase + registerOffset;
          if (physical >= register + 4 || physical + size <= register) continue;
          if (physical === register && size === 4) {
            writeExternalInterfaceTransferRegister(
              channel,
              registerOffset,
              value
            );
            return 1;
          }
          return reject(
            "device",
            "external-interface-transfer-register-rejected"
          );
        }
      }
      if (physical >= 0x0c008000 && physical < 0x0c008020) {
        switch (size) {
          case 1: gxFifoScratch.setUint8(0, value); break;
          case 2: gxFifoScratch.setUint16(0, value, false); break;
          case 4: gxFifoScratch.setUint32(0, value, false); break;
          case 8: gxFifoScratch.setBigUint64(0, BigInt.asUintN(64, value), false); break;
          default: return reject("format", "integer-size-rejected");
        }
        appendGxFifo(size);
        return 1;
      }
      if (physical === 0x0c006434 && size === 4) {
        writeSerialControl(value);
        return 1;
      }
      if (physical === 0x0c006438 && size === 4) {
        writeSerialStatus(value);
        return 1;
      }
      if (physical === 0x0c006000 && size === 4) {
        writeDiskStatus(value);
        return 1;
      }
      if (physical === 0x0c00100a && size === 2) {
        writePixelEngineControl(value);
        return 1;
      }
      if (
        size === 1
        && (physical === 0x0c00100a || physical === 0x0c00100b)
      ) {
        const shift = physical === 0x0c00100a ? 8 : 0;
        writePixelEngineControl((value & 0xff) << shift);
        return 1;
      }
      if (physical === 0x0c006c00 && size === 4) {
        writeAudioControl(value);
        return 1;
      }
      if (physical === 0x0c006c08 && size === 4) {
        aiSampleCounter = value >>> 0;
        aiLastCycle = cycles;
        view.setUint32(mmio + 0x6c08, aiSampleCounter, false);
        return 1;
      }
      if (physical === 0x0c005000 && size === 2) {
        writeDspMailboxHigh(value);
        return 1;
      }
      if (physical === 0x0c005002 && size === 2) {
        writeDspMailboxLow(value);
        return 1;
      }
      if (physical === 0x0c005008 && size === 4) {
        // Retail code can use one aligned word store whose low half lands on
        // DSPCSR. The high half occupies an unmapped register lane.
        writeDspControl(value & 0xffff);
        return 1;
      }
      if (physical === 0x0c00500a && size === 2) {
        writeDspControl(value);
        return 1;
      }
      if (physical === 0x0c005034 && size === 4) {
        view.setUint16(mmio + 0x5034, (value >>> 16) & 0xffff, false);
        writeDspAudioDmaControl(value & 0xffff);
        return 1;
      }
      if (physical === 0x0c005036 && size === 2) {
        writeDspAudioDmaControl(value);
        return 1;
      }
      if (physical === 0x0c005028 && size === 4) {
        startAramDma(value);
        return 1;
      }
      if (physical === 0x0c005028 && size === 2) {
        view.setUint16(mmio + 0x5028, value & 0x83ff, false);
        return 1;
      }
      if (physical === 0x0c00502a && size === 2) {
        const countAndDirection = (
          (view.getUint16(mmio + 0x5028, false) << 16)
          | (value & 0xffe0)
        ) >>> 0;
        startAramDma(countAndDirection);
        return 1;
      }

      const lockedTarget = physicalLockedCachePointer(physical, size);
      const target = physicalRamPointer(physical, size)
        ?? physicalMmioPointer(physical, size)
        ?? lockedTarget;
      if (target === null) {
        return reject("physical", "translated-physical-unbacked");
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
          return reject("format", "integer-size-rejected");
      }
      if (physical < 0x0c006434 && physical + size > 0x0c006430) {
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
      const logical = address >>> 0;
      const reject = (fault, stage, reason) => (
        typeof recordDataStorageFault === "function"
          ? recordDataStorageFault(
              fault,
              logical,
              size,
              false,
              stage,
              reason
            )
          : 0
      );
      if (![0, 4, 5, 6, 7].includes(type)) {
        return reject(
          { kind: "format-rejected", effective: logical },
          "format",
          "quantized-type-rejected"
        );
      }
      const resolved = typeof resolveDataRange === "function"
        ? resolveDataRange(logical, size, false, true)
        : null;
      const physical = resolved === null
        ? translateDataRange(logical, size, false, true)
        : resolved.kind === "mapped"
          ? resolved.physical
          : null;
      if (physical === null) {
        return reject(
          resolved ?? { kind: "translation-failed", effective: logical },
          "translation",
          undefined
        );
      }
      const mapped = { kind: "mapped", effective: logical, physical };
      const lockedSource = physicalLockedCachePointer(physical, size);
      const source = physicalRamPointer(physical, size) ?? lockedSource;
      if (source === null) {
        const device = typeof physicalMmioPointer === "function"
          && physicalMmioPointer(physical, size) !== null;
        return reject(
          mapped,
          device ? "device" : "physical",
          device
            ? "quantized-device-rejected"
            : "translated-physical-unbacked"
        );
      }
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
      const logical = address >>> 0;
      const reject = (fault, stage, reason) => (
        typeof recordDataStorageFault === "function"
          ? recordDataStorageFault(
              fault,
              logical,
              size,
              true,
              stage,
              reason,
              value
            )
          : 0
      );
      if (![0, 4, 5, 6, 7].includes(type)) {
        return reject(
          { kind: "format-rejected", effective: logical },
          "format",
          "quantized-type-rejected"
        );
      }
      const scale = type === 0 ? 0 : signedSix(gqr >>> 8);
      const scaled = value * (2 ** scale);
      const stored = quantizedStoreValue(type, scaled);
      const resolved = typeof resolveDataRange === "function"
        ? resolveDataRange(logical, size, true, true)
        : null;
      const physical = resolved === null
        ? translateDataRange(logical, size, true, true)
        : resolved.kind === "mapped"
          ? resolved.physical
          : null;
      if (physical === null) {
        return reject(
          resolved ?? { kind: "translation-failed", effective: logical },
          "translation",
          undefined
        );
      }
      const mapped = { kind: "mapped", effective: logical, physical };
      if (physical >= 0x0c008000 && physical < 0x0c008020) {
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
      const lockedTarget = physicalLockedCachePointer(physical, size);
      const target = physicalRamPointer(physical, size) ?? lockedTarget;
      if (target === null) {
        const device = typeof physicalMmioPointer === "function"
          && physicalMmioPointer(physical, size) !== null;
        return reject(
          mapped,
          device ? "device" : "physical",
          device
            ? "quantized-device-rejected"
            : "translated-physical-unbacked"
        );
      }
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

    function initializeBatRegisters(offsets, values) {
      for (let index = 0; index < offsets.length; index += 1) {
        const [lowerOffset, upperOffset] = offsets[index];
        const [upper, lower] = values[index];
        view.setUint32(cpu + lowerOffset, lower >>> 0, true);
        view.setUint32(cpu + upperOffset, upper >>> 0, true);
      }
    }

    function initializePageTableRegisters() {
      for (const offset of segmentRegisterOffsets) {
        view.setUint32(cpu + offset, 0, true);
      }
      view.setUint32(cpu + sdr1Offset, 0, true);
    }

    function initializeMemoryManagement() {
      initializeBatRegisters(instructionBatOffsets, defaultInstructionBats);
      initializeBatRegisters(dataBatOffsets, defaultDataBats);
      view.setUint32(cpu + msrOffset, 0x30, true);
    }

    function rebuildDataFastmem() {
      const currentMsr = view.getUint32(cpu + msrOffset, true);
      const currentDataBats = readDataBats();
      const translationSignature = [currentMsr & 0x4010];
      for (const [upper, lower] of currentDataBats) {
        translationSignature.push(upper >>> 0, lower >>> 0);
      }
      if (
        dataFastmemTranslationSignature !== null
        && translationSignature.every((value, index) =>
          dataFastmemTranslationSignature[index] === value
        )
      ) {
        return false;
      }
      dataFastmemTranslationSignature = translationSignature;
      for (let index = 0; index < __FASTMEM_LUT_COUNT__; index += 1) {
        view.setUint32(fastmem + index * 4, 0, true);
      }
      for (let index = 0; index < __FASTMEM_LUT_COUNT__; index += 1) {
        const effective = (index << __FASTMEM_PAGE_SHIFT__) >>> 0;
        const pointer = dataFastmemPointer(
          effective,
          currentMsr,
          currentDataBats,
          ramSize,
          ram
        );
        if (pointer !== null) view.setUint32(fastmem + index * 4, pointer, true);
      }
      return true;
    }

    function currentInstructionTranslationSignature() {
      const signature = [view.getUint32(cpu + msrOffset, true) & 0x4020];
      for (const [upper, lower] of readInstructionBats()) {
        signature.push(upper >>> 0, lower >>> 0);
      }
      for (const offset of segmentRegisterOffsets) {
        signature.push(view.getUint32(cpu + offset, true));
      }
      signature.push(view.getUint32(cpu + sdr1Offset, true));
      return signature;
    }

    function instructionTranslationKey(signature) {
      return signature
        .map(value => (value >>> 0).toString(16).padStart(8, "0"))
        .join(":");
    }

    function instructionBlockKey(effectivePc) {
      check(instructionAddressSpaceKey !== null, "instruction address space is uninitialized");
      return instructionAddressSpaceKey
        + ":"
        + (effectivePc >>> 0).toString(16).padStart(8, "0");
    }

    function instructionRegionKey(effectivePc) {
      return instructionBlockKey(effectivePc);
    }

    function compiledBlock(effectivePc) {
      return blocks.get(instructionBlockKey(effectivePc));
    }

    function hasCompiledBlock(effectivePc) {
      return blocks.has(instructionBlockKey(effectivePc));
    }

    function compiledRegion(effectivePc) {
      return regionsByPc.get(instructionRegionKey(effectivePc));
    }

    function captureInstructionPageDependencies(effectiveStart, byteCount) {
      const start = effectiveStart >>> 0;
      if (
        !Number.isSafeInteger(byteCount) || byteCount <= 0
        || byteCount > 0x100000000 || (start & 3) !== 0
        || (byteCount & 3) !== 0
      ) {
        return {
          dependencies: [],
          fault: { kind: "invalid-range", effective: start },
        };
      }

      const dependencies = [];
      let effective = start;
      let remaining = byteCount;
      while (remaining > 0) {
        // One real, aligned fetch represents this block's use of the 4 KiB
        // page. Hashed translations are retained; real-mode and IBAT fetches
        // are already pinned by the block's instruction namespace.
        const fetched = resolveInstructionFetch(effective, 4, true);
        if (fetched.kind !== "mapped") {
          return { dependencies: [], fault: fetched };
        }
        if (fetched.ptePhysical !== undefined) {
          dependencies.push({
            effective,
            physical: fetched.physical >>> 0,
          });
        }
        const pageBytes = Math.min(
          remaining,
          0x1000 - (effective & 0xfff),
          0x100000000 - effective
        );
        effective = (effective + pageBytes) >>> 0;
        remaining -= pageBytes;
      }
      return { dependencies, fault: null };
    }

    function validateInstructionPageDependencies(dependencies) {
      if (!Array.isArray(dependencies)) return false;
      for (const dependency of dependencies) {
        if (
          dependency === null || !Number.isInteger(dependency.effective)
          || (dependency.effective & 3) !== 0
          || !Number.isInteger(dependency.physical)
        ) return false;
        // A real fetch both validates and touches a resident ITLB way. On a
        // miss it walks/refills the page table and sets R before comparison.
        const fetched = resolveInstructionFetch(dependency.effective, 4, true);
        if (
          fetched.kind !== "mapped" || fetched.ptePhysical === undefined
          || (fetched.physical >>> 0) !== (dependency.physical >>> 0)
        ) return false;
      }
      return true;
    }

    function blockHasInstructionPageDependencies(block) {
      return Array.isArray(block?.instructionPageDependencies)
        && block.instructionPageDependencies.length !== 0;
    }

    function regionHasInstructionPageDependencies(region) {
      return region.pcs.some(regionPc =>
        blockHasInstructionPageDependencies(compiledBlock(regionPc))
      );
    }

    function compiledRegionIsExecutable(region) {
      // A linked Wasm region cannot reproduce the guest's instruction fetch
      // between member blocks. In particular, validating more than two pages
      // in one ITLB set can evict an earlier way before the region starts.
      // Hashed-page regions therefore stay on single-block dispatch until the
      // linker can insert a validation callback at each block boundary.
      if (regionHasInstructionPageDependencies(region)) return false;
      return region.pcs.every(regionPc => {
        const block = compiledBlock(regionPc);
        return block !== undefined
          && validateInstructionPageDependencies(block.instructionPageDependencies);
      });
    }

    function resetInstructionLinkingState() {
      recentPcs.length = 0;
      regionCandidateHits.clear();
      regionFusionHits.clear();
      lastPc = null;
      lastCpuSignature = null;
      samePcCount = 0;
    }

    function invalidateCompiledBlock(block, reason) {
      const key = block.instructionAddressSpaceKey
        + ":"
        + (block.effectiveStart >>> 0).toString(16).padStart(8, "0");
      if (blocks.get(key) !== block) return false;
      blocks.delete(key);

      const invalidatedRegions = new Set();
      for (const region of new Set(regionsByPc.values())) {
        if (
          region.instructionAddressSpaceKey === block.instructionAddressSpaceKey
          && region.pcs.some(regionPc => (regionPc >>> 0) === block.effectiveStart)
        ) {
          invalidatedRegions.add(region);
        }
      }
      for (const [regionKey, region] of regionsByPc) {
        if (invalidatedRegions.has(region)) regionsByPc.delete(regionKey);
      }
      resetInstructionLinkingState();
      accelerations.set(
        "instructionTranslationDependencyInvalidations",
        (accelerations.get("instructionTranslationDependencyInvalidations") ?? 0) + 1
      );
      accelerations.set(
        "instructionTranslationDependencyInvalidatedRegions",
        (accelerations.get("instructionTranslationDependencyInvalidatedRegions") ?? 0)
          + invalidatedRegions.size
      );
      accelerations.set(
        "instructionTranslationDependencyInvalidationReason:" + reason,
        (accelerations.get(
          "instructionTranslationDependencyInvalidationReason:" + reason
        ) ?? 0) + 1
      );
      return true;
    }

    function instructionRangesOverlap(startA, sizeA, startB, sizeB) {
      if (
        !Number.isSafeInteger(sizeA) || sizeA <= 0
        || !Number.isSafeInteger(sizeB) || sizeB <= 0
      ) return false;
      const firstStart = startA >>> 0;
      const secondStart = startB >>> 0;
      if (sizeA >= 0x100000000 || sizeB >= 0x100000000) return true;
      const firstEnd = firstStart + sizeA;
      const secondEnd = secondStart + sizeB;
      const firstSegments = firstEnd <= 0x100000000
        ? [[firstStart, firstEnd]]
        : [[firstStart, 0x100000000], [0, firstEnd - 0x100000000]];
      const secondSegments = secondEnd <= 0x100000000
        ? [[secondStart, secondEnd]]
        : [[secondStart, 0x100000000], [0, secondEnd - 0x100000000]];
      return firstSegments.some(([firstBegin, firstLimit]) =>
        secondSegments.some(([secondBegin, secondLimit]) =>
          firstBegin < secondLimit && secondBegin < firstLimit
        )
      );
    }

    function mapInstructionPhysicalRanges(effectiveStart, byteCount) {
      if (
        !Number.isSafeInteger(byteCount) || byteCount <= 0
        || byteCount > 0x100000000
      ) return [];
      const ranges = [];
      let effective = effectiveStart >>> 0;
      let remaining = byteCount;
      while (remaining > 0) {
        const bytes = Math.min(remaining, 4, 0x100000000 - effective);
        const physical = translateInstructionRange(effective, bytes);
        if (physical === null) return [];
        const previous = ranges.at(-1);
        if (previous !== undefined && previous.start + previous.bytes === physical) {
          previous.bytes += bytes;
        } else {
          ranges.push({ start: physical >>> 0, bytes });
        }
        effective = (effective + bytes) >>> 0;
        remaining -= bytes;
      }
      return ranges;
    }

    function invalidateInstructionCacheRange(effectiveStart, byteCount) {
      const start = effectiveStart >>> 0;
      if (
        !Number.isSafeInteger(byteCount) || byteCount <= 0
        || byteCount > 0x100000000 - start
      ) return 0;

      const firstLine = (start & 0xffffffe0) >>> 0;
      const lineCount = Math.ceil((start + byteCount - firstLine) / 32);
      const virtualLines = [];
      const physicalLines = [];
      for (let index = 0; index < lineCount; index += 1) {
        const virtualLine = firstLine + index * 32;
        virtualLines.push(virtualLine);
        const physicalLine = translateInstructionRange(virtualLine, 32);
        if (physicalLine !== null) physicalLines.push(physicalLine >>> 0);
      }

      const invalidatedBlockKeys = new Set();
      for (const [key, block] of blocks) {
        const virtualOverlap = block.instructionAddressSpaceKey
            === instructionAddressSpaceKey
          && virtualLines.some(line => instructionRangesOverlap(
            block.effectiveStart,
            block.effectiveBytes,
            line,
            32
          ));
        const blockPhysicalRanges = Array.isArray(block.physicalRanges)
          ? block.physicalRanges
          : block.physicalStart !== null && block.physicalBytes > 0
            ? [{ start: block.physicalStart, bytes: block.physicalBytes }]
            : [];
        const physicalOverlap = blockPhysicalRanges.some(range =>
          physicalLines.some(line => instructionRangesOverlap(
            range.start,
            range.bytes,
            line,
            32
          ))
        );
        if (virtualOverlap || physicalOverlap) invalidatedBlockKeys.add(key);
      }
      for (const key of invalidatedBlockKeys) blocks.delete(key);

      const invalidatedRegions = new Set();
      for (const region of new Set(regionsByPc.values())) {
        if (region.pcs.some(regionPc => invalidatedBlockKeys.has(
          region.instructionAddressSpaceKey
            + ":"
            + (regionPc >>> 0).toString(16).padStart(8, "0")
        ))) {
          invalidatedRegions.add(region);
        }
      }
      for (const [key, region] of regionsByPc) {
        if (invalidatedRegions.has(region)) regionsByPc.delete(key);
      }

      accelerations.set(
        "instructionCacheInvalidationLines",
        (accelerations.get("instructionCacheInvalidationLines") ?? 0) + lineCount
      );
      if (invalidatedBlockKeys.size !== 0 || invalidatedRegions.size !== 0) {
        resetInstructionLinkingState();
        accelerations.set(
          "instructionCacheInvalidatedBlocks",
          (accelerations.get("instructionCacheInvalidatedBlocks") ?? 0)
            + invalidatedBlockKeys.size
        );
        accelerations.set(
          "instructionCacheInvalidatedRegions",
          (accelerations.get("instructionCacheInvalidatedRegions") ?? 0)
            + invalidatedRegions.size
        );
      }
      return invalidatedBlockKeys.size;
    }

    function invalidateInstructionCacheLine(effectiveAddress) {
      return invalidateInstructionCacheRange(
        (effectiveAddress & 0xffffffe0) >>> 0,
        32
      );
    }

    function instructionRangeTouchesTlbSet(effectiveStart, byteCount, setIndex) {
      if (
        !Number.isSafeInteger(byteCount) || byteCount <= 0
        || byteCount > 0x100000000
        || !Number.isInteger(setIndex) || setIndex < 0 || setIndex >= 64
      ) return false;

      let effective = effectiveStart >>> 0;
      let remaining = byteCount;
      while (remaining > 0) {
        if (((effective >>> 12) & 0x3f) === setIndex) return true;
        const chunk = Math.min(
          remaining,
          0x1000 - (effective & 0xfff),
          0x100000000 - effective
        );
        effective = (effective + chunk) >>> 0;
        remaining -= chunk;
      }
      return false;
    }

    function invalidateInstructionTranslationSet(effectiveAddress) {
      const setIndex = instructionTlbSetIndex(effectiveAddress);
      const invalidatedBlockKeys = new Set();
      for (const [key, block] of blocks) {
        if (instructionRangeTouchesTlbSet(
          block.effectiveStart,
          block.effectiveBytes,
          setIndex
        )) {
          invalidatedBlockKeys.add(key);
        }
      }
      for (const key of invalidatedBlockKeys) blocks.delete(key);

      const invalidatedRegions = new Set();
      for (const region of new Set(regionsByPc.values())) {
        if (region.pcs.some(regionPc => invalidatedBlockKeys.has(
          region.instructionAddressSpaceKey
            + ":"
            + (regionPc >>> 0).toString(16).padStart(8, "0")
        ))) {
          invalidatedRegions.add(region);
        }
      }
      for (const [key, region] of regionsByPc) {
        if (invalidatedRegions.has(region)) regionsByPc.delete(key);
      }

      if (invalidatedBlockKeys.size !== 0 || invalidatedRegions.size !== 0) {
        resetInstructionLinkingState();
      }
      accelerations.set(
        "instructionTlbInvalidations",
        (accelerations.get("instructionTlbInvalidations") ?? 0) + 1
      );
      accelerations.set(
        "instructionTlbInvalidatedBlocks",
        (accelerations.get("instructionTlbInvalidatedBlocks") ?? 0)
          + invalidatedBlockKeys.size
      );
      accelerations.set(
        "instructionTlbInvalidatedRegions",
        (accelerations.get("instructionTlbInvalidatedRegions") ?? 0)
          + invalidatedRegions.size
      );
      return invalidatedBlockKeys.size;
    }

    function invalidateTranslationLookasideBuffer(effectiveAddress) {
      const instructionSetIndex = instructionTlbSetIndex(effectiveAddress);
      const dataSetIndex = typeof dataTlbSetIndex === "function"
        ? dataTlbSetIndex(effectiveAddress)
        : instructionSetIndex;
      const invalidateSet = (sets, setIndex) => {
        const set = sets[setIndex];
        const invalidated = set.entries.filter(entry => entry !== null).length;
        set.entries[0] = null;
        set.entries[1] = null;
        set.lru = 0;
        return invalidated;
      };
      const instructionEntries = invalidateSet(
        instructionTlbSets,
        instructionSetIndex
      );
      const dataEntries = invalidateSet(dataTlbSets, dataSetIndex);
      const blocks = invalidateInstructionTranslationSet(effectiveAddress);
      accelerations.set(
        "translationTlbInvalidations",
        (accelerations.get("translationTlbInvalidations") ?? 0) + 1
      );
      accelerations.set(
        "instructionTlbInvalidatedEntries",
        (accelerations.get("instructionTlbInvalidatedEntries") ?? 0)
          + instructionEntries
      );
      accelerations.set(
        "dataTlbInvalidatedEntries",
        (accelerations.get("dataTlbInvalidatedEntries") ?? 0) + dataEntries
      );
      return blocks;
    }

    function synchronizeTranslationLookasideBuffer() {
      accelerations.set(
        "translationTlbSynchronizations",
        (accelerations.get("translationTlbSynchronizations") ?? 0) + 1
      );
    }

    function synchronizeInstructionStream() {
      accelerations.set(
        "instructionStreamSynchronizations",
        (accelerations.get("instructionStreamSynchronizations") ?? 0) + 1
      );
    }

    function invalidateAllCompiledCode(reason) {
      const invalidatedBlocks = blocks.size;
      const invalidatedRegions = new Set(regionsByPc.values()).size;
      blocks.clear();
      regionsByPc.clear();
      resetInstructionLinkingState();
      accelerations.set(
        "instructionAddressSpaceInvalidations",
        (accelerations.get("instructionAddressSpaceInvalidations") ?? 0) + 1
      );
      accelerations.set(
        "instructionAddressSpaceInvalidatedBlocks",
        (accelerations.get("instructionAddressSpaceInvalidatedBlocks") ?? 0)
          + invalidatedBlocks
      );
      accelerations.set(
        "instructionAddressSpaceInvalidatedRegions",
        (accelerations.get("instructionAddressSpaceInvalidatedRegions") ?? 0)
          + invalidatedRegions
      );
    }

    function synchronizeInstructionAddressSpace(reason, invalidate = false) {
      const signature = currentInstructionTranslationSignature();
      if (
        instructionTranslationSignature !== null
        && signature.every((value, index) =>
          instructionTranslationSignature[index] === value
        )
      ) {
        return false;
      }
      instructionTranslationSignature = signature;
      instructionAddressSpaceKey = instructionTranslationKey(signature);
      instructionAddressSpaceGeneration += 1;
      if (invalidate) {
        invalidateAllCompiledCode(reason);
      } else {
        resetInstructionLinkingState();
      }
      return true;
    }

    function interruptDeliveryPendingAtCycle(observedCycles) {
      const interruptCause = view.getUint32(mmio + 0x3000, false);
      const interruptMask = view.getUint32(mmio + 0x3004, false);
      return (
        (interruptCause & interruptMask) !== 0
        || decrementerPending
        || runtimeEventDueAtOrBefore(observedCycles)
      );
    }

    function msrChanged() {
      // The compiler terminates this block after publishing its automatic PC.
      // Device interrupt delivery remains in the normal post-block service pass.
      const dataTranslationChanged = rebuildDataFastmem();
      const instructionTranslationChanged = synchronizeInstructionAddressSpace("msr");
      if (
        dataTranslationChanged !== false
        || instructionTranslationChanged !== false
      ) return 0;

      const interruptsEnabled = (
        view.getUint32(cpu + msrOffset, true) & 0x00008000
      ) !== 0;
      // An interrupt-disable with unchanged translations cannot make a device
      // exception newly deliverable. An interrupt-enable may also remain linked
      // when the exact published hook cycle has no asserted interrupt or due
      // device deadline. Otherwise the post-block pass must observe this enable
      // boundary before the following guest instruction executes.
      return (
        !interruptsEnabled
        || !interruptDeliveryPendingAtCycle(cycles)
      ) ? 1 : 0;
    }

    function instructionBatChanged() {
      synchronizeInstructionAddressSpace("ibat", true);
    }

    function segmentRegisterChanged() {
      synchronizeInstructionAddressSpace("sr");
    }

    function sdr1Changed() {
      synchronizeInstructionAddressSpace("sdr1");
    }

    function dataBatChanged() {
      rebuildDataFastmem();
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
      const pointer = instructionRamPointer(pc, 4);
      check(
        pointer !== null,
        "instruction address is outside mapped memory: 0x"
          + (pc >>> 0).toString(16)
      );
      return view.getUint32(pointer, false);
    }

    function instructionDiagnostic(pc) {
      const fetched = fetchInstructionWord(pc, false);
      return fetched.kind === "mapped"
        ? "0x" + fetched.word.toString(16).padStart(8, "0")
        : null;
    }

    function probeInstructionWord(pc) {
      const fetched = fetchInstructionWord(pc, false);
      return fetched.kind === "mapped" ? fetched.word : null;
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

    function inspectSuperMonkeyBallGameplayInput(currentPlayer) {
      if (
        boot.identifier !== "GMBE8P"
        || !Number.isSafeInteger(currentPlayer)
        || currentPlayer < 0
        || currentPlayer >= 4
      ) return null;
      const controller = guestS32(0x80206bd0 + currentPlayer * 4);
      if (
        !Number.isSafeInteger(controller)
        || controller < 0
        || controller >= 4
      ) return null;
      const controllerInfo = 0x801f3b70 + controller * 0x3c;
      const worldInfo = 0x80206bf0 + currentPlayer * 0x40;
      return {
        currentPlayer,
        controller,
        padStatus: inspectPadStatus(controllerInfo),
        world: {
          address: hex32(worldInfo),
          xrot: guestS16(worldInfo),
          zrot: guestS16(worldInfo + 2),
          previousXrot: guestS16(worldInfo + 4),
          previousZrot: guestS16(worldInfo + 6),
          state: guestU8(worldInfo + 8),
          player: guestU8(worldInfo + 9),
          inputLockFrames: guestS32(worldInfo + 0x20),
        },
      };
    }

    function inspectSuperMonkeyBallMainStickRoundtripState() {
      const controller = inspectSuperMonkeyBallPad0();
      if (controller === null) return null;
      return {
        cycle: cycles,
        si: {
          pollIndex: controllerPollIndex,
          appliedSequence: controllerAppliedSequence,
          publishedChannels: serialLastPublishedChannels,
          updatedChannels: serialLastUpdatedChannels,
        },
        padStatus: controller.held,
      };
    }

    function guestU32(address) {
      const pointer = ramPointer(address, 4);
      return pointer === null ? null : view.getUint32(pointer, false);
    }

    function guestU8(address) {
      const pointer = ramPointer(address, 1);
      return pointer === null ? null : view.getUint8(pointer);
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

    function inspectSuperMonkeyBallScenarioState() {
      if (boot.identifier !== "GMBE8P") return null;
      let lastPresentedCopy = null;
      for (let index = gxXfbCopies.length - 1; index >= 0; index -= 1) {
        if (gxXfbCopies[index].index === viLastPresentationCopyIndex) {
          lastPresentedCopy = gxXfbCopies[index];
          break;
        }
      }
      return {
        cycle: cycles,
        pad: {
          held: guestU16(0x801f3b70),
          pressed: guestU16(0x801f3b88),
          released: guestU16(0x801f3b94),
        },
        gameModeRequest: guestS16(0x802f1b90),
        gameMode: guestS16(0x802f1b92),
        gameSubmodeRequest: guestS16(0x802f1b8c),
        gameSubmode: guestS16(0x802f1b8e),
        warningState: guestU8(0x80173cc8),
        warningDialogPhase: guestU8(0x802ba35c),
        warningDialogFlags: guestU32(0x802ba318),
        submodeTimer: guestS32(0x801eec20),
        difficulty: guestS32(0x801eec24),
        flags: guestU32(0x801eec28),
        titleChoice: guestS32(0x801eec30),
        menuSelection: guestS32(0x801eec40),
        playerCount: guestS32(0x801eec44),
        gameType: guestS32(0x801eec48),
        currentPlayer: guestS32(0x801eec4c),
        characterSelection0: guestS32(0x80206bc0),
        textBoxState: guestS32(0x80292b60),
        textBoxTimer: guestS32(0x80292b68),
        selectorCurrent: guestS32(0x801eeda8),
        selectorRequest: guestS32(0x801eedac),
        selectorChoice: guestS32(0x801eede0),
        characterLocked0: guestS32(0x801eedf0),
        infoFlags: guestU32(0x801f3a58),
        infoTimer: guestS16(0x801f3a5c),
        attempts: guestS16(0x801f3a76),
        floor: guestS16(0x801f3a78),
        pauseStatus: guestU32(0x802f1ee0),
        inputLockStatus: guestU32(0x802f1edc),
        demoSkipTimer: guestS32(0x802f1ba8),
        demoResourcesReady: guestS32(0x802f1bb0),
        gameVersion: boot.version,
        viPresentationCount,
        viHostPresentationCount,
        viFieldStagedCount,
        viFieldRejectedCount,
        viLastPresentationCycle,
        viLastPresentationCopyIndex,
        gxXfbCopyCount,
        xfbCaptured: lastPresentedCopy?.captured ?? null,
        xfbCapturedAtCycle: lastPresentedCopy?.capturedAtCycle ?? null,
        xfbDisplayedAtCycle: lastPresentedCopy?.displayedAtCycle ?? null,
        temporalXfbCaptureCapacity: smbTemporalXfbCaptureCapacity,
        temporalXfbCapturesPosted: smbTemporalXfbCapturesPosted,
        rendererFramesAcknowledged,
        rendererFramesInFlight: rendererFramesInFlight.size,
        rendererFailed: rendererFailure !== null,
      };
    }

    function inspectSuperMonkeyBallSustainedPlayState() {
      const state = inspectSuperMonkeyBallScenarioState();
      if (state === null) return null;
      const gameplayInput = inspectSuperMonkeyBallGameplayInput(state.currentPlayer);
      return {
        ...state,
        padStatus: gameplayInput?.padStatus ?? null,
        gameplayInput,
        sustainedViReceiptCapacity: smbSustainedViReceiptCapacity,
        sustainedViReceiptsPosted: smbSustainedViReceiptsPosted,
        sustainedViReceiptsReceived: smbSustainedViReceipts.length,
        sustainedViFailure: smbSustainedViFailure,
      };
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

    function inspectWarioWareGameState() {
      if (boot.identifier !== "GZWE01") return null;

      // Retail GZWE01 stores the four current-game identifiers here.
      // Microgame 0x63 is Repellion, the first live A-button game reached
      // after continuing without a Memory Card.
      const activeGameSlotAddresses = [
        0x80295ed0,
        0x80295ed4,
        0x80295ed8,
        0x80295edc,
      ];
      const activeGameIds = activeGameSlotAddresses.map(guestU32);
      const cardDialogStateAddress = 0x802958ac;
      const cardDialogChoiceAddress = 0x802958b4;
      const cardDialogState = guestS32(cardDialogStateAddress);
      const runtimePointerAddress = 0x802f6860;
      const runtime = guestU32(runtimePointerAddress);
      const runtimeMapped = Number.isSafeInteger(runtime)
        && runtime >= 0x80000000
        && runtime <= 0x817b4c04;
      const gameplayButtonsAddress = runtimeMapped ? runtime + 0x4b160 : null;
      const playerObjectPointerAddress = runtimeMapped ? runtime + 0x4b178 : null;
      const playerResultAddress = runtimeMapped ? runtime + 0x4b3f8 : null;
      const playerObject = playerObjectPointerAddress === null
        ? null
        : guestU32(playerObjectPointerAddress);
      const playerObjectMapped = Number.isSafeInteger(playerObject)
        && playerObject >= 0x80000000
        && playerObject <= 0x817fedcc;
      const playerObjectResultAddress = playerObjectMapped
        ? playerObject + 0x1230
        : null;
      const gameplayButtons = gameplayButtonsAddress === null
        ? null
        : guestU16(gameplayButtonsAddress);
      return {
        activeGameSlots: activeGameSlotAddresses.map((address, index) => ({
          address: hex32(address),
          id: activeGameIds[index],
        })),
        activeMicrogameId: activeGameIds[0],
        player0RepellionActive: activeGameIds[0] === 0x63,
        repellionActive: activeGameIds.includes(0x63),
        cardDialogStateAddress: hex32(cardDialogStateAddress),
        cardDialogState,
        cardDialogChoiceAddress: hex32(cardDialogChoiceAddress),
        cardDialogChoice: guestS32(cardDialogChoiceAddress),
        noMemoryCardDialog: cardDialogState === 11,
        noCardFlowActive: cardDialogState === 11 || cardDialogState === 0x21,
        runtimePointerAddress: hex32(runtimePointerAddress),
        runtime: runtimeMapped ? hex32(runtime) : null,
        gameplayButtonsAddress: hex32(gameplayButtonsAddress),
        gameplayButtons,
        aActive: gameplayButtons === null
          ? null
          : (gameplayButtons & 0x0100) !== 0,
        playerObjectPointerAddress: hex32(playerObjectPointerAddress),
        playerObject: playerObjectMapped ? hex32(playerObject) : null,
        playerResultAddress: hex32(playerResultAddress),
        playerResult: playerResultAddress === null
          ? null
          : guestS32(playerResultAddress),
        playerObjectResultAddress: hex32(playerObjectResultAddress),
        playerObjectResult: playerObjectResultAddress === null
          ? null
          : guestS32(playerObjectResultAddress),
        lastActiveGameplayInput: wariowareLastActiveGameplayInput,
      };
    }

    function sampleWarioWareGameplayInput(sampleCycle) {
      if (boot.identifier !== "GZWE01") return;
      const publication = serialLastActiveHostPublication;
      if (
        publication === null
        || (publication.buttons & 0x0100) === 0
        || publication.observedCycle > sampleCycle
        || controllerAppliedSequence !== publication.sequence
        || guestU32(0x80295ed0) !== 0x63
      ) return;
      const previousSequence =
        wariowareLastActiveGameplayInput?.hostPublication?.sequence;
      if (
        Number.isSafeInteger(previousSequence)
        && previousSequence >= publication.sequence
      ) return;
      const runtime = guestU32(0x802f6860);
      if (
        !Number.isSafeInteger(runtime)
        || runtime < 0x80000000
        || runtime > 0x817b4c04
      ) return;
      const gameplayButtonsAddress = runtime + 0x4b160;
      const gameplayButtons = guestU16(gameplayButtonsAddress);
      if (gameplayButtons === null || (gameplayButtons & 0x0100) === 0) return;
      const playerObject = guestU32(runtime + 0x4b178);
      const playerObjectMapped = Number.isSafeInteger(playerObject)
        && playerObject >= 0x80000000
        && playerObject <= 0x817fedcc;
      wariowareLastActiveGameplayInput = {
        cycle: sampleCycle,
        buttons: gameplayButtons,
        controllerAppliedSequence,
        hostPublication: { ...publication },
        playerObject: playerObjectMapped ? hex32(playerObject) : null,
        playerObjectResult: playerObjectMapped
          ? guestS32(playerObject + 0x1230)
          : null,
      };
    }

    function inspectGuestGameState() {
      return inspectSuperMonkeyBallGameState()
        ?? inspectWarioWareGameState();
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

    function viRegisterAccess(physical, size) {
      const address = physical >>> 0;
      if (address < 0x0c002000 || address >= 0x0c003000) return null;
      const offset = address - 0x0c000000;
      const aligned = size === 1
        || (size === 2 && (offset & 1) === 0)
        || (size === 4 && (offset & 3) === 0);
      if (!aligned || offset + size > 0x3000) {
        return { offset, valid: false };
      }
      return { offset, valid: true };
    }

    function viBeamPositionAtCycle(observedCycles) {
      if (viTiming === null) {
        return { halfLine: 0, vct: 1, hct: 1, sample: 0 };
      }
      if (!viBeamEnabled) {
        const halfLine = viFrozenBeam.halfLine % viTiming.totalHalfLines;
        const sample = Math.min(viFrozenBeam.sample, viTiming.hlw - 1);
        return {
          halfLine,
          vct: 1 + Math.floor(halfLine / 2),
          hct: 1 + (halfLine & 1) * viTiming.hlw + sample,
          sample,
        };
      }
      const elapsedCycles = Math.max(0, observedCycles - viEpochCycle);
      const elapsedHalfLines = Math.floor(
        elapsedCycles / viTiming.cyclesPerHalfLine
      );
      const halfLine = (
        viEpochHalfLine + elapsedHalfLines
      ) % viTiming.totalHalfLines;
      const halfLineCycles = elapsedCycles % viTiming.cyclesPerHalfLine;
      const sample = Math.min(
        viTiming.hlw - 1,
        Math.floor(halfLineCycles / viTiming.cyclesPerSample)
      );
      return {
        halfLine,
        vct: 1 + Math.floor(halfLine / 2),
        hct: 1 + (halfLine & 1) * viTiming.hlw + sample,
        sample,
      };
    }

    function synchronizeVideoInterfaceAtCycle(observedCycles) {
      ensureViSchedule(observedCycles);
      serviceViDueEvents(observedCycles);
      updateViInterruptLevel(observedCycles, false);
    }

    function readVideoInterfaceRegister(physical, size, observedCycles) {
      const access = viRegisterAccess(physical, size);
      if (access === null) return { handled: false, value: null };
      if (!access.valid || ![1, 2, 4].includes(size)) {
        return { handled: true, value: null };
      }
      synchronizeVideoInterfaceAtCycle(observedCycles);
      const offset = access.offset;
      if (offset < 0x202c + 4 && offset + size > 0x202c) {
        const beam = viBeamPositionAtCycle(observedCycles);
        const packed = ((beam.vct & 0xffff) << 16) | (beam.hct & 0xffff);
        const scratch = new DataView(new ArrayBuffer(4));
        scratch.setUint32(0, packed >>> 0, false);
        const beamOffset = offset - 0x202c;
        if (beamOffset < 0 || beamOffset + size > 4) {
          return { handled: true, value: null };
        }
        return {
          handled: true,
          value: size === 1
            ? scratch.getUint8(beamOffset)
            : size === 2
              ? scratch.getUint16(beamOffset, false)
              : scratch.getUint32(beamOffset, false),
        };
      }
      return {
        handled: true,
        value: size === 1
          ? view.getUint8(mmio + offset)
          : size === 2
            ? view.getUint16(mmio + offset, false)
            : view.getUint32(mmio + offset, false),
      };
    }

    function writeViDisplayControl(value, observedCycles) {
      const written = value & 0x03ff;
      const reset = (written & 2) !== 0;
      view.setUint16(mmio + 0x2002, written & ~2, false);
      if (reset) {
        for (let index = 0; index < viInterruptOffsets.length; index += 1) {
          view.setUint32(mmio + viInterruptOffsets[index], 0, false);
        }
        view.setUint32(
          mmio + 0x3000,
          view.getUint32(mmio + 0x3000, false) & ~0x00000100,
          false
        );
        viTiming = null;
        viTimingSignature = null;
        viComparatorSignature = null;
        viSerialPollSignature = null;
        viBeamEnabled = false;
        viFrozenBeam = { halfLine: 0, sample: 0, sampleCycle: 0 };
        viEpochCycle = observedCycles;
        viEpochHalfLine = 0;
        nextViCycle = null;
        nextViPresentCycle = null;
        nextViBoundaryCycle = null;
        nextViTimingBoundaryCycle = null;
        nextSerialPollCycle = null;
        resetViFieldPairing("display-reset", observedCycles);
        viScanoutActive.topBase = null;
        viScanoutActive.bottomBase = null;
        viScanoutActive.picture = null;
        viScanoutPending.topBase = null;
        viScanoutPending.bottomBase = null;
        viScanoutPending.picture = null;
        viScanoutBoundarySnapshots.length = 0;
        viActiveAcv = null;
        viPendingAcv = null;
        viActiveOddVBlank = null;
        viPendingOddVBlank = null;
        viActiveEvenVBlank = null;
        viPendingEvenVBlank = null;
        traceVi("display-reset", observedCycles);
      }
      viScheduleDirty = true;
    }

    function writeViInterruptHalf(index, high, value, observedCycles) {
      const offset = viInterruptOffsets[index];
      const previous = view.getUint32(mmio + offset, false);
      let written = high
        ? (((value & 0xffff) << 16) | (previous & 0xffff)) >>> 0
        : ((previous & 0xffff0000) | (value & 0xffff)) >>> 0;
      if (high) {
        const retainedStatus = previous & written & 0x80000000;
        written = ((written & ~0x80000000) | retainedStatus) >>> 0;
        if (
          (previous & 0x80000000) !== 0
          && (written & 0x80000000) === 0
        ) {
          viInterruptAcknowledgements[index] += 1;
          traceVi("ack", observedCycles, {
            index,
            rawBefore: hex32(previous),
            rawAfter: hex32(written),
          });
        }
      }
      view.setUint32(mmio + offset, written, false);
      viComparatorSignature = null;
    }

    function recordViScanoutWrite(kind, value, observedCycles) {
      viScanoutWriteSerial += 1;
      viScanoutPending[kind] = {
        value: value >>> 0,
        writeCycle: observedCycles,
        writeSerial: viScanoutWriteSerial,
      };
    }

    function captureViPendingRegisters(offset, size, observedCycles) {
      const end = offset + size;
      if (offset < 0x2002 && end > 0x2000) {
        viPendingAcv = (view.getUint16(mmio + 0x2000, false) >>> 4) & 0x03ff;
      }
      if (offset < 0x2010 && end > 0x200c) {
        viPendingOddVBlank = view.getUint32(mmio + 0x200c, false);
      }
      if (offset < 0x2014 && end > 0x2010) {
        viPendingEvenVBlank = view.getUint32(mmio + 0x2010, false);
      }
      if (offset < 0x2020 && end > 0x201c) {
        recordViScanoutWrite(
          "topBase",
          view.getUint32(mmio + 0x201c, false),
          observedCycles
        );
      }
      if (offset < 0x2028 && end > 0x2024) {
        recordViScanoutWrite(
          "bottomBase",
          view.getUint32(mmio + 0x2024, false),
          observedCycles
        );
      }
      if (offset < 0x204a && end > 0x2048) {
        recordViScanoutWrite(
          "picture",
          view.getUint16(mmio + 0x2048, false),
          observedCycles
        );
      }
    }

    function writeViHalfword(offset, value, observedCycles) {
      const written = value & 0xffff;
      if (offset === 0x202c || offset === 0x202e) return true;
      if (offset === 0x2002) {
        writeViDisplayControl(written, observedCycles);
        return true;
      }
      if (offset >= 0x2030 && offset < 0x2040) {
        const delta = offset - 0x2030;
        if ((delta & 1) !== 0) return false;
        writeViInterruptHalf(
          Math.floor(delta / 4),
          (delta & 2) === 0,
          written,
          observedCycles
        );
        return true;
      }
      view.setUint16(mmio + offset, written, false);
      if ([0x201c, 0x2020, 0x2024, 0x2028].includes(offset)) {
        const raw = view.getUint32(mmio + offset, false);
        if ((raw & 0xe0000000) !== 0) {
          view.setUint32(mmio + offset, raw & ~0x10000000, false);
        }
      }
      return true;
    }

    function writeVideoInterfaceRegister(physical, value, size, observedCycles) {
      const access = viRegisterAccess(physical, size);
      if (access === null || !access.valid || ![2, 4].includes(size)) {
        return false;
      }
      synchronizeVideoInterfaceAtCycle(observedCycles);
      const offset = access.offset;
      if (size === 2) {
        if (!writeViHalfword(offset, value, observedCycles)) return false;
      } else {
        if (!writeViHalfword(offset, Number(value) >>> 16, observedCycles)) {
          return false;
        }
        if (!writeViHalfword(offset + 2, Number(value) & 0xffff, observedCycles)) {
          return false;
        }
      }
      captureViPendingRegisters(offset, size, observedCycles);
      const end = offset + size;
      if (
        (offset < 0x2014 && end > 0x2000)
        || (offset < 0x2040 && end > 0x2030)
        || (offset < 0x206e && end > 0x206c)
      ) {
        viScheduleDirty = true;
      }
      ensureViSchedule(observedCycles);
      updateViInterruptLevel(observedCycles, false);
      return true;
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
      const programmedAcv = (verticalTiming >>> 4) & 0x03ff;
      const acv = viActiveAcv ?? programmedAcv;
      const hlw = horizontalTiming0 & 0x03ff;
      const activeOddVBlank = viActiveOddVBlank ?? oddVBlank;
      const activeEvenVBlank = viActiveEvenVBlank ?? evenVBlank;
      const oddPrb = activeOddVBlank & 0x03ff;
      const oddPsb = (activeOddVBlank >>> 16) & 0x03ff;
      const evenPrb = activeEvenVBlank & 0x03ff;
      const evenPsb = (activeEvenVBlank >>> 16) & 0x03ff;
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
          equ,
          acv,
          displayControl & 0x0005,
          hlw,
          oddPrb,
          oddPsb,
          evenPrb,
          evenPsb,
          clockSelect,
        ].join(":"),
        raw: {
          verticalTiming: "0x" + verticalTiming.toString(16).padStart(4, "0"),
          displayControl: "0x" + displayControl.toString(16).padStart(4, "0"),
          horizontalTiming0: "0x" + horizontalTiming0.toString(16).padStart(8, "0"),
          oddVBlank: "0x" + oddVBlank.toString(16).padStart(8, "0"),
          evenVBlank: "0x" + evenVBlank.toString(16).padStart(8, "0"),
          clock: "0x" + clock.toString(16).padStart(4, "0"),
        },
        programmed: {
          acv: programmedAcv,
          oddVBlank: hex32(oddVBlank),
          evenVBlank: hex32(evenVBlank),
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
      const wordsPerLine = (pictureConfiguration >>> 8) & 0x7f;
      const standardWordsPerLine = pictureConfiguration & 0xff;
      const nonInterlaced = (displayControl & 4) !== 0;
      const rowRepeat = nonInterlaced ? 1 : 2;
      return {
        pictureConfiguration,
        wordsPerLine,
        standardWordsPerLine,
        activeLines,
        nonInterlaced,
        width: wordsPerLine * 16,
        fieldStrideBytes: standardWordsPerLine * 32,
        fieldHeight: activeLines,
        rowRepeat,
        height: activeLines * rowRepeat,
        scanoutPolicy: rowRepeat === 2 ? "bob" : "direct",
      };
    }

    function programmedViScanoutEntry(kind, observedCycles) {
      const value = kind === "topBase"
        ? view.getUint32(mmio + 0x201c, false)
        : kind === "bottomBase"
          ? view.getUint32(mmio + 0x2024, false)
          : view.getUint16(mmio + 0x2048, false);
      return {
        value,
        writeCycle: observedCycles,
        writeSerial: 0,
      };
    }

    function cloneViScanoutEntry(entry) {
      return entry === null ? null : { ...entry };
    }

    function viScanoutStateSnapshot() {
      return {
        topBase: cloneViScanoutEntry(viScanoutActive.topBase),
        bottomBase: cloneViScanoutEntry(viScanoutActive.bottomBase),
        picture: cloneViScanoutEntry(viScanoutActive.picture),
      };
    }

    function latchViScanoutBoundary(field, observedCycles) {
      check(field === "top" || field === "bottom", "invalid VI scanout field");
      const latch = (kind, details = {}) => {
        const pending = viScanoutPending[kind]
          ?? programmedViScanoutEntry(kind, observedCycles);
        viScanoutLatchSerial += 1;
        viScanoutActive[kind] = {
          ...pending,
          ...details,
          field,
          latchedAtCycle: observedCycles,
          latchSerial: viScanoutLatchSerial,
        };
      };

      if (field === "top") {
        latch("topBase");
        latch("picture", {
          displayControl: view.getUint16(mmio + 0x2002, false),
          activeLines: viActiveAcv
            ?? ((view.getUint16(mmio + 0x2000, false) >>> 4) & 0x03ff),
          oddVBlank: (
            viActiveOddVBlank ?? view.getUint32(mmio + 0x200c, false)
          ) >>> 0,
        });
      } else {
        // TFBL owns the VI's shared POFF bit, but BFBL samples that line at
        // the bottom-field boundary independently of the active top field.
        // Keep the sampled raw TFBL value with BFBL so a queued presentation
        // cannot later inherit POFF from either a stale top latch or a newer
        // guest register write.
        latch("bottomBase", {
          pageOffsetRaw: view.getUint32(mmio + 0x201c, false),
        });
      }

      const snapshot = viScanoutStateSnapshot();
      traceVi("scanout-latch", observedCycles, {
        field,
        topBaseLatch: snapshot.topBase?.latchSerial ?? null,
        bottomBaseLatch: snapshot.bottomBase?.latchSerial ?? null,
        bottomPageOffsetRaw: snapshot.bottomBase?.pageOffsetRaw ?? null,
        pictureLatch: snapshot.picture?.latchSerial ?? null,
      });
      return snapshot;
    }

    function latchViTimingBoundary(field, observedCycles) {
      check(field === "top" || field === "bottom", "invalid VI timing field");
      let changed = false;
      if (field === "top") {
        const nextAcv = viPendingAcv
          ?? viActiveAcv
          ?? ((view.getUint16(mmio + 0x2000, false) >>> 4) & 0x03ff);
        const nextOddVBlank = viPendingOddVBlank
          ?? viActiveOddVBlank
          ?? view.getUint32(mmio + 0x200c, false);
        changed = viActiveAcv !== nextAcv
          || viActiveOddVBlank !== nextOddVBlank;
        viActiveAcv = nextAcv;
        viActiveOddVBlank = nextOddVBlank;
        viPendingAcv = null;
        viPendingOddVBlank = null;
      } else {
        const nextEvenVBlank = viPendingEvenVBlank
          ?? viActiveEvenVBlank
          ?? view.getUint32(mmio + 0x2010, false);
        changed = viActiveEvenVBlank !== nextEvenVBlank;
        viActiveEvenVBlank = nextEvenVBlank;
        viPendingEvenVBlank = null;
      }
      if (changed) viScheduleDirty = true;
      traceVi("timing-latch", observedCycles, {
        field,
        activeAcv: viActiveAcv,
        activeOddVBlank: viActiveOddVBlank === null
          ? null
          : hex32(viActiveOddVBlank),
        activeEvenVBlank: viActiveEvenVBlank === null
          ? null
          : hex32(viActiveEvenVBlank),
      });
      return changed;
    }

    function viOutputDimensions(scanoutState = viScanoutActive) {
      const picture = scanoutState.picture;
      return decodeViOutputDimensions(
        picture?.value ?? view.getUint16(mmio + 0x2048, false),
        picture?.displayControl ?? view.getUint16(mmio + 0x2002, false),
        picture?.activeLines ?? viTiming?.acv ?? 0
      );
    }

    function viActiveXfbAddress(field, scanoutState = viScanoutActive) {
      check(field === "top" || field === "bottom", "invalid VI scanout field");
      const topRaw = scanoutState.topBase?.value
        ?? view.getUint32(mmio + 0x201c, false);
      if (field === "top") return viXfbAddressFromRaw(topRaw, topRaw);

      const bottomBase = scanoutState.bottomBase;
      if (
        bottomBase === null
        || bottomBase === undefined
        || !Number.isSafeInteger(bottomBase.value)
        || bottomBase.value < 0
        || bottomBase.value > 0xffff_ffff
        || !Number.isSafeInteger(bottomBase.pageOffsetRaw)
        || bottomBase.pageOffsetRaw < 0
        || bottomBase.pageOffsetRaw > 0xffff_ffff
      ) {
        return null;
      }
      return viXfbAddressFromRaw(bottomBase.value, bottomBase.pageOffsetRaw);
    }

    function viCurrentHalfLine(observedCycles) {
      return viTiming === null
        ? null
        : viBeamPositionAtCycle(observedCycles).halfLine;
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
      const hct = raw & 0x03ff;
      const vct = (raw >>> 16) & 0x03ff;
      if (vct === 0 || hct === 0 || hct > 2 * viTiming.hlw) return null;
      const targetSample = (vct - 1) * 2 * viTiming.hlw + (hct - 1);
      if (targetSample >= viTiming.totalHalfLines * viTiming.hlw) return null;
      return {
        hct,
        vct,
        targetSample,
        halfLine: Math.floor(targetSample / viTiming.hlw),
        sample: targetSample % viTiming.hlw,
      };
    }

    function viCycleForRasterSampleAfter(targetSample, observedCycles) {
      if (viTiming === null) return null;
      const frameSamples = viTiming.totalHalfLines * viTiming.hlw;
      const epochSample = viEpochHalfLine * viTiming.hlw;
      const elapsedSamples = Math.floor(
        Math.max(0, observedCycles - viEpochCycle) / viTiming.cyclesPerSample
      );
      const currentSample = (epochSample + elapsedSamples) % frameSamples;
      let distance = (targetSample - currentSample + frameSamples) % frameSamples;
      if (distance === 0) distance = frameSamples;
      return viEpochCycle
        + (elapsedSamples + distance) * viTiming.cyclesPerSample;
    }

    function nextViComparatorCycle(observedCycles) {
      if (viTiming === null || !viTiming.displayEnabled) return null;
      const candidates = viInterruptOffsets
        .map(offset => viComparatorTarget(view.getUint32(mmio + offset, false)))
        .filter(target => target !== null)
        .map(target =>
          viCycleForRasterSampleAfter(target.targetSample, observedCycles)
        );
      return candidates.length === 0 ? null : Math.min(...candidates);
    }

    function nextViPresentationCycleAfter(observedCycles) {
      if (viTiming === null || !viTiming.displayEnabled) return null;
      const candidates = viActiveFieldTargets(viTiming).map(target =>
        viCycleForHalfLineAfter(target.halfLine, observedCycles)
      );
      return candidates.length === 0 ? null : Math.min(...candidates);
    }

    function viTimingFieldTargets(timing) {
      const targets = [{ field: "top", halfLine: 0 }];
      if (!timing.singleField) {
        targets.push({ field: "bottom", halfLine: timing.oddHalfLines });
      }
      return targets;
    }

    function nextViTimingBoundaryCycleAfter(observedCycles) {
      if (viTiming === null || !viTiming.displayEnabled) return null;
      const candidates = viTimingFieldTargets(viTiming).map(target =>
        viCycleForHalfLineAfter(target.halfLine, observedCycles)
      );
      return candidates.length === 0 ? null : Math.min(...candidates);
    }

    function nextViDueEventCycle(observedCycles) {
      let next = null;
      for (const candidate of [
        nextViCycle,
        nextViTimingBoundaryCycle,
        nextViBoundaryCycle,
      ]) {
        if (
          candidate !== null
          && candidate <= observedCycles
          && (next === null || candidate < next)
        ) {
          next = candidate;
        }
      }
      return next;
    }

    function serviceViDueEvents(observedCycles) {
      for (;;) {
        const scheduledCycle = nextViDueEventCycle(observedCycles);
        if (scheduledCycle === null) return;

        const comparatorDue = nextViCycle === scheduledCycle;
        const timingDue = nextViTimingBoundaryCycle === scheduledCycle;
        const scanoutDue = nextViBoundaryCycle === scheduledCycle;
        const halfLine = viCurrentHalfLine(scheduledCycle);
        const timingTarget = timingDue
          ? viTimingFieldTargets(viTiming)
              .find(candidate => candidate.halfLine === halfLine)
          : undefined;
        const scanoutTarget = scanoutDue
          ? viActiveFieldTargets(viTiming)
              .find(candidate => candidate.halfLine === halfLine)
          : undefined;
        const duePresentationCycle = nextViPresentCycle;

        // Stable same-cycle order is architectural: the comparator samples
        // the old raster image, documented timing buffers are promoted, then
        // the active scanout snapshot owns the promoted field geometry.
        if (comparatorDue) {
          serviceViComparatorEvent(scheduledCycle, observedCycles);
        }
        if (timingDue) {
          if (timingTarget !== undefined) {
            latchViTimingBoundary(timingTarget.field, scheduledCycle);
          }
          nextViTimingBoundaryCycle = nextViTimingBoundaryCycleAfter(
            scheduledCycle
          );
        }
        if (scanoutDue) {
          sampleWarioWareGameplayInput(scheduledCycle);
          if (scanoutTarget !== undefined) {
            const snapshot = latchViScanoutBoundary(
              scanoutTarget.field,
              scheduledCycle
            );
            viScanoutBoundarySnapshots.push({
              scheduledCycle,
              field: scanoutTarget.field,
              snapshot,
            });
            if (viScanoutBoundarySnapshots.length > 8) {
              viScanoutBoundarySnapshots.shift();
            }
          }
          nextViBoundaryCycle = nextViPresentationCycleAfter(scheduledCycle);
        }

        if (viScheduleDirty) ensureViSchedule(scheduledCycle);
        if (scanoutDue && duePresentationCycle === scheduledCycle) {
          nextViPresentCycle = scheduledCycle;
        }
      }
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
        return raw & 0x03ff03ff;
      }).join(":");
    }

    function resetViFieldPairing(reason, observedCycles) {
      if (viPendingFieldPair !== null) {
        traceVi("field-pair-reset", observedCycles, {
          reason,
          pairEpoch: viPendingFieldPair.pairEpoch,
          field: viPendingFieldPair.field,
        });
      }
      viPendingFieldPair = null;
    }

    function allocateViPairEpoch() {
      check(
        Number.isSafeInteger(viNextPairEpoch)
          && viNextPairEpoch >= 1
          && viNextPairEpoch <= 0xffff_ffff,
        "VI field-pair epoch exhausted"
      );
      const pairEpoch = viNextPairEpoch;
      viNextPairEpoch += 1;
      return pairEpoch;
    }

    function claimViFieldPair(
      field,
      dimensions,
      resolved,
      sourceRowStep,
      address,
      scanoutState
    ) {
      check(field === "top" || field === "bottom", "invalid VI field parity");
      const presentationMode = dimensions.rowRepeat === 2
        ? "interlaced"
        : "single-field";
      const member = {
        field,
        address,
        copyIndex: resolved?.frame.index ?? 0,
        copyRow: resolved?.row ?? 0,
        width: dimensions.width,
        height: dimensions.height,
        fieldStrideBytes: dimensions.fieldStrideBytes,
        sourceRowStep,
        fieldHeight: dimensions.fieldHeight,
        rowRepeat: dimensions.rowRepeat,
        scanoutPolicy: dimensions.scanoutPolicy,
        scanoutProvenance: {
          base: cloneViScanoutEntry(
            field === "top"
              ? scanoutState.topBase
              : scanoutState.bottomBase
          ),
          picture: cloneViScanoutEntry(scanoutState.picture),
        },
      };
      if (presentationMode !== "interlaced") {
        viPendingFieldPair = null;
        return {
          presentationMode,
          pairEpoch: allocateViPairEpoch(),
          pairCompleting: true,
          fields: { [field]: member },
        };
      }
      const signature = [
        presentationMode,
        dimensions.width,
        dimensions.height,
        dimensions.fieldStrideBytes,
        dimensions.fieldHeight,
        dimensions.rowRepeat,
        sourceRowStep,
        scanoutState.picture?.latchSerial ?? 0,
        resolved?.frame.stride ?? -1,
        resolved?.frame.width ?? -1,
        resolved?.frame.height ?? -1,
      ].join(":");
      if (
        viPendingFieldPair !== null
        && viPendingFieldPair.field !== field
        && viPendingFieldPair.signature === signature
      ) {
        const pending = viPendingFieldPair;
        viPendingFieldPair = null;
        return {
          presentationMode,
          pairEpoch: pending.pairEpoch,
          pairCompleting: true,
          fields: {
            [pending.field]: pending.member,
            [field]: member,
          },
        };
      }
      // Startup can observe either parity first. A duplicate parity abandons
      // the incomplete producer pair and opens a newer epoch rather than
      // allowing two same-parity fields to form a host frame.
      const pairEpoch = allocateViPairEpoch();
      viPendingFieldPair = { pairEpoch, field, signature, member };
      return {
        presentationMode,
        pairEpoch,
        pairCompleting: false,
        fields: { [field]: member },
      };
    }

    function ensureViSchedule(observedCycles) {
      if (!viScheduleDirty) return;
      viScheduleDirty = false;
      const previousTiming = viTiming;
      const wasEnabled = viBeamEnabled;
      const previousBeam = previousTiming === null
        ? { halfLine: viFrozenBeam.halfLine, sample: viFrozenBeam.sample }
        : viBeamPositionAtCycle(observedCycles);
      const previousSampleCycle = previousTiming !== null && wasEnabled
        ? Math.max(0, observedCycles - viEpochCycle)
            % previousTiming.cyclesPerSample
        : viFrozenBeam.sampleCycle ?? 0;
      const wantsEnabled = (
        view.getUint16(mmio + 0x2002, false) & 1
      ) !== 0;
      if (wantsEnabled && !wasEnabled) {
        viActiveAcv = viPendingAcv
          ?? ((view.getUint16(mmio + 0x2000, false) >>> 4) & 0x03ff);
        viActiveOddVBlank = viPendingOddVBlank
          ?? view.getUint32(mmio + 0x200c, false);
        viActiveEvenVBlank = viPendingEvenVBlank
          ?? view.getUint32(mmio + 0x2010, false);
        viPendingAcv = null;
        viPendingOddVBlank = null;
        viPendingEvenVBlank = null;
      }
      const decoded = decodeViTiming();
      if (!decoded.valid) {
        if (viTiming !== null) {
          traceVi("timing-invalid", observedCycles, { raw: decoded.raw });
        }
        viTiming = null;
        viBeamEnabled = false;
        viFrozenBeam = {
          halfLine: previousBeam.halfLine,
          sample: previousBeam.sample,
          sampleCycle: previousSampleCycle,
        };
        viTimingSignature = decoded.signature;
        viComparatorSignature = null;
        viSerialPollSignature = null;
        nextViCycle = null;
        nextViPresentCycle = null;
        nextViBoundaryCycle = null;
        nextViTimingBoundaryCycle = null;
        nextSerialPollCycle = null;
        resetViFieldPairing("timing-invalid", observedCycles);
        return;
      }

      const timingChanged = viTiming === null
        || decoded.signature !== viTimingSignature;
      const enabled = decoded.displayEnabled;
      if (timingChanged || enabled !== wasEnabled) {
        if (
          enabled !== wasEnabled
          || previousTiming === null
          || decoded.singleField !== previousTiming.singleField
          || decoded.acv !== previousTiming.acv
        ) {
          resetViFieldPairing("timing-reschedule", observedCycles);
        }
        viTiming = decoded;
        viTimingSignature = decoded.signature;
        const retainedHalfLine = previousBeam.halfLine % viTiming.totalHalfLines;
        const retainedSample = Math.min(previousBeam.sample, viTiming.hlw - 1);
        const retainedSampleCycle = Math.min(
          previousSampleCycle,
          viTiming.cyclesPerSample - 1
        );
        viEpochHalfLine = retainedHalfLine;
        viEpochCycle = observedCycles
          - retainedSample * viTiming.cyclesPerSample
          - retainedSampleCycle;
        viFrozenBeam = {
          halfLine: retainedHalfLine,
          sample: retainedSample,
          sampleCycle: retainedSampleCycle,
        };
        viBeamEnabled = enabled;
        viComparatorSignature = currentViComparatorSignature();
        viSerialPollSignature = view.getUint32(mmio + 0x6430, false);
        nextViCycle = enabled ? nextViComparatorCycle(observedCycles) : null;
        nextViPresentCycle = enabled
          ? nextViPresentationCycleAfter(observedCycles)
          : null;
        nextViBoundaryCycle = enabled
          ? nextViPresentationCycleAfter(observedCycles)
          : null;
        nextViTimingBoundaryCycle = enabled
          ? nextViTimingBoundaryCycleAfter(observedCycles)
          : null;
        nextSerialPollCycle = enabled
          ? nextViSerialPollCycle(observedCycles)
          : null;
        viTimingReschedules += 1;
        traceVi("timing-reschedule", observedCycles, {
          raw: decoded.raw,
          enabled,
          retainedHalfLine,
          retainedSample,
          retainedSampleCycle,
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

    function gxXfbCopyRowOffset(frame, address) {
      if (address < frame.destination) return null;
      const delta = address - frame.destination;
      if (delta === 0) return 0;
      if (frame.stride === 0 || delta % frame.stride !== 0) return null;
      const row = delta / frame.stride;
      return row < frame.height ? row : null;
    }

    function gxResolveXfbCopy(address) {
      const resident = [...gxXfbCopyDestinations.values()];
      for (let index = resident.length - 1; index >= 0; index -= 1) {
        const frame = resident[index];
        if (frame.destination === address) return { frame, row: 0 };
      }
      for (let index = resident.length - 1; index >= 0; index -= 1) {
        const frame = resident[index];
        const row = gxXfbCopyRowOffset(frame, address);
        if (row !== null && row <= 1) return { frame, row };
      }
      return null;
    }

    function serviceVideoPresentation(observedCycles) {
      while (rendererFramesInFlight.size === 0) {
        const queuedBoundary = viScanoutBoundarySnapshots[0] ?? null;
        const queuedCycle = queuedBoundary?.scheduledCycle ?? null;
        let scheduledCycle = null;
        if (queuedCycle !== null && queuedCycle <= observedCycles) {
          scheduledCycle = queuedCycle;
        } else if (
          nextViPresentCycle !== null
          && nextViPresentCycle <= observedCycles
        ) {
          scheduledCycle = nextViPresentCycle;
        }
        if (scheduledCycle === null) break;
        const halfLine = viCurrentHalfLine(scheduledCycle);
        const boundary = queuedCycle !== scheduledCycle
          ? null
          : viScanoutBoundarySnapshots.shift();
        const target = boundary === null
          ? viActiveFieldTargets(viTiming)
              .find(candidate => candidate.halfLine === halfLine)
          : { field: boundary.field, halfLine };
        if (target !== undefined) {
          const scanoutState = boundary === null
            ? viScanoutStateSnapshot()
            : boundary.snapshot;
          const address = viActiveXfbAddress(target.field, scanoutState);
          const dimensions = viOutputDimensions(scanoutState);
          const resolved = gxResolveXfbCopy(address);
          const sourceRowStep = resolved !== null
            && resolved.frame.stride > 0
            && dimensions.fieldStrideBytes % resolved.frame.stride === 0
            ? dimensions.fieldStrideBytes / resolved.frame.stride
            : 0;
          const fieldPair = claimViFieldPair(
            target.field,
            dimensions,
            resolved,
            sourceRowStep,
            address,
            scanoutState
          );
          const temporalXfbCapture = fieldPair.pairCompleting
            ? claimSmbTemporalXfbCapture()
            : null;
          const sustainedPlayReceipt = claimSmbSustainedViReceipt(fieldPair);
          if (resolved !== null) {
            resolved.frame.displayed = true;
            resolved.frame.displayedAtCycle = scheduledCycle;
            resolved.frame.displayedField = target.field;
            resolved.frame.displayedRow = resolved.row;
          }
          postRendererFrame("vi-present", {
            scheduledCycle,
            field: target.field,
            presentationMode: fieldPair.presentationMode,
            pairEpoch: fieldPair.pairEpoch,
            pairCompleting: fieldPair.pairCompleting,
            pairFields: fieldPair.fields,
            address,
            width: dimensions.width,
            height: dimensions.height,
            copyIndex: resolved?.frame.index ?? 0,
            copyRow: resolved?.row ?? 0,
            pictureConfiguration: dimensions.pictureConfiguration,
            wordsPerLine: dimensions.wordsPerLine,
            standardWordsPerLine: dimensions.standardWordsPerLine,
            activeLines: dimensions.activeLines,
            nonInterlaced: dimensions.nonInterlaced,
            fieldStrideBytes: dimensions.fieldStrideBytes,
            sourceRowStep,
            fieldHeight: dimensions.fieldHeight,
            rowRepeat: dimensions.rowRepeat,
            scanoutPolicy: dimensions.scanoutPolicy,
            ...(temporalXfbCapture === null ? {} : { temporalXfbCapture }),
            ...(sustainedPlayReceipt === null ? {} : { sustainedPlayReceipt }),
          });
          gxFramesPresented += 1;
          viPresentationCount += 1;
          viLastPresentationCycle = scheduledCycle;
          viLastPresentationField = target.field;
          viLastPresentationAddress = address;
          viLastPresentationCopyIndex = resolved?.frame.index ?? 0;
          viLastPresentationCopyRow = resolved?.row ?? 0;
          deviceEvents.set("viField", (deviceEvents.get("viField") ?? 0) + 1);
          traceVi("present", observedCycles, {
            scheduledCycle,
            field: target.field,
            presentationMode: fieldPair.presentationMode,
            pairEpoch: fieldPair.pairEpoch,
            pairCompleting: fieldPair.pairCompleting,
            address: hex32(address),
            copyIndex: resolved?.frame.index ?? null,
            copyRow: resolved?.row ?? null,
          });
        }
        if (
          viTiming?.displayEnabled
          && (
            nextViPresentCycle === null
            || nextViPresentCycle <= scheduledCycle
          )
        ) {
          nextViPresentCycle = nextViPresentationCycleAfter(scheduledCycle);
        }
      }
    }

    function serviceViComparatorEvent(scheduledCycle, observedCycles) {
      const beam = viBeamPositionAtCycle(scheduledCycle);
      const lateness = observedCycles - scheduledCycle;
      viMissedHalfLines += Math.floor(lateness / viTiming.cyclesPerHalfLine);

      const matches = [];
      for (let index = 0; index < viInterruptOffsets.length; index += 1) {
        const offset = viInterruptOffsets[index];
        const raw = view.getUint32(mmio + offset, false);
        const target = viComparatorTarget(raw);
        if (
          target === null
          || target.vct !== beam.vct
          || target.hct !== beam.hct
        ) {
          continue;
        }
        matches.push(index);
        viComparatorMatches[index] += 1;
        if ((raw & 0x80000000) === 0) viStatusAssertions[index] += 1;
        const asserted = (raw | 0x80000000) >>> 0;
        view.setUint32(mmio + offset, asserted, false);
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
        beamVct: beam.vct,
        beamHct: beam.hct,
      });
      nextViCycle = nextViComparatorCycle(scheduledCycle);
    }

    function updateViInterruptLevel(observedCycles, deliver) {
      const active = viInterruptOffsets.some(offset => {
        const value = view.getUint32(mmio + offset, false);
        return ((value & 0x90000000) >>> 0) === 0x90000000;
      });
      let cause = view.getUint32(mmio + 0x3000, false);
      cause = active ? cause | 0x00000100 : cause & ~0x00000100;
      view.setUint32(mmio + 0x3000, cause, false);
      const mask = view.getUint32(mmio + 0x3004, false);
      const msr = view.getUint32(cpu + msrOffset, true);
      if (
        deliver
        && active
        && (mask & 0x00000100) !== 0
        && (msr & 0x00008000) !== 0
      ) {
        viPiDeliveries += 1;
        deviceEvents.set("externalInterrupt", (deviceEvents.get("externalInterrupt") ?? 0) + 1);
        traceVi("pi-deliver", observedCycles, { cause: hex32(cause), mask: hex32(mask) });
        raiseException(cpu, 0x0500);
      }
    }

    function serviceVideoInterrupt(observedCycles) {
      updateViInterruptLevel(observedCycles, true);
    }

    function servicePixelEngine(observedCycles) {
      if (peFinishCycle !== null && observedCycles >= peFinishCycle) {
        peFinishCycle = null;
        peFinishSignal = true;
        peFinishInterruptDelivered = false;
        deviceEvents.set("peFinish", (deviceEvents.get("peFinish") ?? 0) + 1);
      }

      const control = view.getUint16(mmio + 0x100a, false);
      const tokenActive = peTokenSignal && (control & 0x01) !== 0;
      const finishActive = peFinishSignal && (control & 0x02) !== 0;
      let cause = view.getUint32(mmio + 0x3000, false);
      cause = tokenActive ? cause | 0x00000200 : cause & ~0x00000200;
      cause = finishActive ? cause | 0x00000400 : cause & ~0x00000400;
      view.setUint32(mmio + 0x3000, cause >>> 0, false);

      const mask = view.getUint32(mmio + 0x3004, false);
      const msr = view.getUint32(cpu + msrOffset, true);
      const tokenPending = tokenActive
        && (mask & 0x00000200) !== 0
        && !peTokenInterruptDelivered;
      const finishPending = finishActive
        && (mask & 0x00000400) !== 0
        && !peFinishInterruptDelivered;
      if ((msr & 0x00008000) !== 0 && (tokenPending || finishPending)) {
        if (tokenPending) {
          peTokenInterruptDelivered = true;
          deviceEvents.set(
            "peTokenInterrupt",
            (deviceEvents.get("peTokenInterrupt") ?? 0) + 1
          );
        }
        if (finishPending) {
          peFinishInterruptDelivered = true;
          deviceEvents.set(
            "peFinishInterrupt",
            (deviceEvents.get("peFinishInterrupt") ?? 0) + 1
          );
        }
        raiseException(cpu, 0x0500);
      }
      if (!tokenActive) {
        peTokenInterruptDelivered = false;
      }
      if (!finishActive) {
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

    function transitionExternalInterfaceChipSelect(
      channel,
      previousSelect,
      nextSelect
    ) {
      if (!Number.isInteger(channel) || channel < 0 || channel >= 3) {
        throw new RangeError("EXI channel must be 0, 1, or 2");
      }
      if (
        !Number.isInteger(previousSelect)
        || previousSelect < 0
        || previousSelect > 7
        || !Number.isInteger(nextSelect)
        || nextSelect < 0
        || nextSelect > 7
      ) {
        throw new RangeError("EXI chip select must fit three bits");
      }
      if (previousSelect === nextSelect) return false;

      // Dolphin routes a CSR edge to the device selected by old-CS XOR
      // new-CS, then passes the complete new selector to SetCS. IPL resets
      // its command byte count and cursor only when that value is nonzero.
      // Transfer dispatch remains one-hot below, so a multi-select callback
      // can reset framing but cannot activate the modeled IPL transaction.
      const changedSelect = previousSelect ^ nextSelect;
      if (channel === 0) {
        exi0IplChipSelectActive = nextSelect === 2;
      }
      if (
        channel === 0
        && changedSelect === 2
        && nextSelect !== 0
      ) {
        exi0IplCommandWord = 0;
        exi0IplCommandBytes = 0;
        exi0IplCommandWrite = null;
        exi0IplCommandAddress = null;
        exi0IplCursor = 0;
        exi0IplAddressSequence = null;
      }
      return true;
    }

    function writeExternalInterfaceTransferRegister(
      channel,
      registerOffset,
      value
    ) {
      if (!Number.isInteger(channel) || channel < 0 || channel >= 3) {
        throw new RangeError("EXI channel must be 0, 1, or 2");
      }
      if (![4, 8, 12].includes(registerOffset)) {
        throw new RangeError("EXI transfer register offset must be 4, 8, or 12");
      }

      // EXIMAR and EXILENGTH expose bits 5..25; EXICR exposes bits 0..5.
      // Hardware therefore makes the RAM address and transfer length
      // 32-byte aligned while every reserved bit reads back as zero.
      const mask = registerOffset === 12
        ? exiTransferControlMask
        : exiDmaRegisterMask;
      const stored = (value & mask) >>> 0;
      view.setUint32(
        mmio + 0x6800 + channel * 0x14 + registerOffset,
        stored,
        false
      );
      return stored;
    }

    function readExternalInterfaceTransferRegister(channel, registerOffset) {
      if (!Number.isInteger(channel) || channel < 0 || channel >= 3) {
        throw new RangeError("EXI channel must be 0, 1, or 2");
      }
      if (![4, 8, 12].includes(registerOffset)) {
        throw new RangeError("EXI transfer register offset must be 4, 8, or 12");
      }
      const mask = registerOffset === 12
        ? exiTransferControlMask
        : exiDmaRegisterMask;
      return (
        view.getUint32(
          mmio + 0x6800 + channel * 0x14 + registerOffset,
          false
        ) & mask
      ) >>> 0;
    }

    function writeExternalInterfaceParameter(channel, value) {
      if (!Number.isInteger(channel) || channel < 0 || channel >= 3) {
        throw new RangeError("EXI channel must be 0, 1, or 2");
      }
      const parameterOffset = 0x6800 + channel * 0x14;
      const current = view.getUint32(mmio + parameterOffset, false);
      const written = value >>> 0;
      const statusMask = (
        exiDeviceInterrupt
        | exiTransferInterrupt
        | (channel < 2 ? exiAttachInterrupt : 0)
      ) >>> 0;
      const writableMask = (
        exiDeviceInterruptMask
        | exiTransferInterruptMask
        | exiClockMask
        | exiDeviceSelectMask
        | (channel < 2 ? exiAttachInterruptMask : 0)
        | (channel === 0 ? exiRomDisable : 0)
      ) >>> 0;
      const statuses = (current & statusMask) & ~(written & statusMask);
      const readOnly = channel < 2 ? current & exiDeviceConnected : 0;
      const next = (
        (written & writableMask)
        | statuses
        | readOnly
      ) >>> 0;
      if (
        (current & exiTransferInterrupt) !== 0
        && (written & exiTransferInterrupt) !== 0
      ) {
        exiTransferInterruptAcknowledgements += 1;
      }
      view.setUint32(mmio + parameterOffset, next, false);
      transitionExternalInterfaceChipSelect(
        channel,
        (current >>> 7) & 7,
        (next >>> 7) & 7
      );
      refreshExternalInterfaceInterruptLevel("csr-write-channel-" + channel);
      return next;
    }

    function completeExternalInterfaceTransfer(channel) {
      if (!Number.isInteger(channel) || channel < 0 || channel >= 3) {
        throw new RangeError("EXI channel must be 0, 1, or 2");
      }
      const parameterOffset = 0x6800 + channel * 0x14;
      const controlOffset = parameterOffset + 0x0c;
      const control = (
        view.getUint32(mmio + controlOffset, false)
        & exiTransferControlMask
      ) >>> 0;
      if ((control & 1) === 0) return false;
      view.setUint32(mmio + controlOffset, (control & ~1) >>> 0, false);
      view.setUint32(
        mmio + parameterOffset,
        (
          view.getUint32(mmio + parameterOffset, false)
          | exiTransferInterrupt
        ) >>> 0,
        false
      );
      exiTransferCompletions += 1;
      refreshExternalInterfaceInterruptLevel(
        "transfer-complete-channel-" + channel
      );
      return true;
    }

    function refreshExternalInterfaceInterruptLevel(reason) {
      let active = false;
      for (let channel = 0; channel < 3; channel += 1) {
        const parameter = view.getUint32(
          mmio + 0x6800 + channel * 0x14,
          false
        );
        active ||= (
          (parameter & (
            exiDeviceInterruptMask | exiDeviceInterrupt
          )) === (
            exiDeviceInterruptMask | exiDeviceInterrupt
          )
          || (parameter & (
            exiTransferInterruptMask | exiTransferInterrupt
          )) === (
            exiTransferInterruptMask | exiTransferInterrupt
          )
          || (
            channel < 2
            && (parameter & (
              exiAttachInterruptMask | exiAttachInterrupt
            )) === (
              exiAttachInterruptMask | exiAttachInterrupt
            )
          )
        );
      }

      const beforeCause = view.getUint32(mmio + 0x3000, false);
      const cause = (
        active
          ? beforeCause | piExternalInterfaceInterruptCause
          : beforeCause & ~piExternalInterfaceInterruptCause
      ) >>> 0;
      if (
        (beforeCause & piExternalInterfaceInterruptCause) === 0
        && (cause & piExternalInterfaceInterruptCause) !== 0
      ) {
        exiPiAssertions += 1;
      } else if (
        (beforeCause & piExternalInterfaceInterruptCause) !== 0
        && (cause & piExternalInterfaceInterruptCause) === 0
      ) {
        exiPiDeassertions += 1;
      }
      if (active !== exiInterruptLevelActive) {
        exiInterruptLevelChanges += 1;
      }
      exiInterruptLevelActive = active;
      exiInterruptLevelReason = reason;
      view.setUint32(mmio + 0x3000, cause, false);
      return active;
    }

    function serviceExternalInterfaceInterrupt(observedCycles) {
      refreshExternalInterfaceInterruptLevel(
        "mmio-service@" + observedCycles
      );
      const cause = view.getUint32(mmio + 0x3000, false);
      const mask = view.getUint32(mmio + 0x3004, false);
      if (
        (cause & mask & piExternalInterfaceInterruptCause) === 0
      ) {
        return false;
      }
      const msr = view.getUint32(cpu + msrOffset, true);
      if ((msr & 0x00008000) === 0) return false;

      exiExternalInterruptDeliveries += 1;
      deviceEvents.set(
        "exiExternalInterrupt",
        (deviceEvents.get("exiExternalInterrupt") ?? 0) + 1
      );
      deviceEvents.set(
        "externalInterrupt",
        (deviceEvents.get("externalInterrupt") ?? 0) + 1
      );
      raiseException(cpu, 0x0500);
      return true;
    }

    function exiTransferModeName(mode) {
      switch (mode) {
        case 0: return "read";
        case 1: return "write";
        case 2: return "read-write";
        default: return "reserved";
      }
    }

    function exiIplImageStatus() {
      const configured = exiIplImage !== null;
      const isUint8Array = configured
        && Object.prototype.toString.call(exiIplImage) === "[object Uint8Array]";
      const byteLength = isUint8Array ? exiIplImage.byteLength : null;
      return {
        configured,
        valid: isUint8Array && byteLength === exiIplImageBytes,
        byteLength,
        expectedBytes: exiIplImageBytes,
        source: exiIplSource,
      };
    }

    function updateExiSramChecksums(sram) {
      if (
        Object.prototype.toString.call(sram) !== "[object Uint8Array]"
        || sram.byteLength !== exiSramBytes
      ) {
        throw new RangeError(
          `EXI SRAM must be a ${exiSramBytes}-byte Uint8Array`
        );
      }
      let checksum = 0;
      let checksumInverse = 0;
      // The settings checksums cover rtc_bias through flags: four
      // big-endian words at offsets 0x10..0x17 in the aggregate image.
      for (let offset = 0x10; offset < 0x18; offset += 2) {
        const word = (sram[offset] << 8) | sram[offset + 1];
        checksum = (checksum + word) & 0xffff;
        checksumInverse = (checksumInverse + (word ^ 0xffff)) & 0xffff;
      }
      sram[0x04] = checksum >>> 8;
      sram[0x05] = checksum & 0xff;
      sram[0x06] = checksumInverse >>> 8;
      sram[0x07] = checksumInverse & 0xff;
      return { checksum, checksumInverse };
    }

    function createDefaultExiSram() {
      const sram = new Uint8Array(exiSramBytes);
      // Match Dolphin's public deterministic SRAM template (Sram.cpp at
      // 707d3c7a, GPL-2.0-or-later): English, stereo, initial setup
      // complete, and stable placeholder card IDs.
      sram[0x17] = 0x2c;
      for (const [offset, value] of [
        [0x18, "DOLPHINSLOTA"],
        [0x24, "DOLPHINSLOTB"],
      ]) {
        for (let index = 0; index < value.length; index += 1) {
          sram[offset + index] = value.charCodeAt(index);
        }
      }
      sram[0x3e] = 0x6e;
      sram[0x3f] = 0x6d;
      updateExiSramChecksums(sram);
      return sram;
    }

    function readExiRtcSeconds() {
      return (
        (exiSram[0] << 24)
        | (exiSram[1] << 16)
        | (exiSram[2] << 8)
        | exiSram[3]
      ) >>> 0;
    }

    function exiRtcSecondsAtCycle(observedCycles) {
      if (!Number.isSafeInteger(observedCycles) || observedCycles < 0) {
        throw new RangeError(
          "EXI RTC cycle must be a non-negative safe integer"
        );
      }
      return (
        exiRtcStartSeconds
        + Math.floor(observedCycles / exiRtcCyclesPerSecond)
      ) >>> 0;
    }

    function refreshExiRtc(observedCycles) {
      // Dolphin CEXIIPL (EXI_DeviceIPL.cpp at 707d3c7a,
      // GPL-2.0-or-later) snapshots the big-endian RTC whenever the fourth
      // command byte latches. Its deterministic path advances a fixed start
      // time by emulated core ticks; keeping the start at the GameCube epoch
      // makes browser runs independent of host wall time, timezone, and
      // guest-written TB state.
      const seconds = exiRtcSecondsAtCycle(observedCycles);
      exiSram[0] = seconds >>> 24;
      exiSram[1] = seconds >>> 16;
      exiSram[2] = seconds >>> 8;
      exiSram[3] = seconds;
      exi0RtcRefreshCount += 1;
      exi0RtcLastRefreshCycle = observedCycles;
      return seconds;
    }

    function exiIplReadRegion(address) {
      if (!Number.isInteger(address) || address < 0) return null;
      if (address < exiIplImageBytes) return "rom";
      if (
        address >= exiSramBase
        && address < exiSramSettingsBase
      ) {
        return "rtc";
      }
      if (
        address >= exiSramSettingsBase
        && address < exiSramBase + exiSramBytes
      ) {
        return "sram";
      }
      return null;
    }

    function transferExi0IplImmediate(
      control,
      immediate,
      observedCycles
    ) {
      const transferMode = (control >>> 2) & 3;
      const immediateLength = ((control >>> 4) & 3) + 1;
      const immediateBefore = immediate >>> 0;
      const commandWordBefore = exi0IplCommandWord;
      const commandBytesBefore = exi0IplCommandBytes;
      let immediateAfter = immediateBefore;
      let commandCompleted = false;
      let rtcRefreshedSeconds = null;
      let imageStatus = null;
      const dataRegionBefore = exiIplReadRegion(exi0IplCommandAddress);
      const rtcImmediateOutOfBounds = (
        transferMode === 0
        && commandBytesBefore >= 4
        && exi0IplCommandWrite === false
        && dataRegionBefore === "rtc"
        && (
          exi0IplCursor < exiSramBase
          || exi0IplCursor > exiSramSettingsBase
          || immediateLength > exiSramSettingsBase - exi0IplCursor
        )
      );
      const sramImmediateOutOfBounds = (
        transferMode === 0
        && commandBytesBefore >= 4
        && exi0IplCommandWrite === false
        && dataRegionBefore === "sram"
        && (
          exi0IplCursor < exiSramSettingsBase
          || exi0IplCursor > exiSramBase + exiSramBytes
          || immediateLength
            > exiSramBase + exiSramBytes - exi0IplCursor
        )
      );

      const transferByte = input => {
        const inputByte = input & 0xff;
        if (exi0IplCommandBytes < 4) {
          exi0IplCommandWord = (
            (exi0IplCommandWord << 8) | inputByte
          ) >>> 0;
          exi0IplCommandBytes += 1;
          if (exi0IplCommandBytes === 4) {
            exi0IplCommandWrite =
              (exi0IplCommandWord & 0x80000000) !== 0;
            exi0IplCommandAddress =
              (exi0IplCommandWord >>> 6) & 0x01ffffff;
            exi0IplCursor = exi0IplCommandAddress;
            exi0IplAddressSequence = null;
            commandCompleted = true;
            rtcRefreshedSeconds = refreshExiRtc(observedCycles);
          }
          // IPL drives all ones while the four command bytes are clocked.
          return 0xff;
        }

        const readRegion = exiIplReadRegion(exi0IplCommandAddress);
        if (exi0IplCommandWrite === false && readRegion === "rom") {
          imageStatus ??= exiIplImageStatus();
          const source = exi0IplCursor % exiIplImageBytes;
          const output = imageStatus.valid ? exiIplImage[source] : 0;
          if (imageStatus.valid) {
            exi0IplCursor = (exi0IplCursor + 1) >>> 0;
          }
          return output;
        }
        if (exi0IplCommandWrite === false && readRegion === "rtc") {
          if (
            exi0IplCursor >= exiSramBase
            && exi0IplCursor < exiSramSettingsBase
          ) {
            const output = exiSram[exi0IplCursor - exiSramBase];
            exi0IplCursor = (exi0IplCursor + 1) >>> 0;
            exi0RtcImmediateReadBytes += 1;
            return output;
          }
          return inputByte;
        }
        if (exi0IplCommandWrite === false && readRegion === "sram") {
          if (exi0IplCursor < exiSramBase + exiSramBytes) {
            const output = exiSram[exi0IplCursor - exiSramBase];
            exi0IplCursor = (exi0IplCursor + 1) >>> 0;
            exi0SramImmediateReadBytes += 1;
            return output;
          }
          return inputByte;
        }

        // UART and writes are separate device-model layers.
        // Leaving the byte untouched matches Dolphin's IPL TransferByte
        // behavior for an unhandled address while failing closed on state.
        return inputByte;
      };

      if (
        transferMode === 0
        && !rtcImmediateOutOfBounds
        && !sramImmediateOutOfBounds
      ) {
        immediateAfter = 0;
        for (let index = 0; index < immediateLength; index += 1) {
          immediateAfter |= transferByte(0) << (24 - index * 8);
        }
        immediateAfter >>>= 0;
      } else if (transferMode === 1) {
        for (let index = 0; index < immediateLength; index += 1) {
          transferByte(immediateBefore >>> (24 - index * 8));
        }
      }
      // Dolphin's IPL device does not override ImmReadWrite, so mode 2 is a
      // no-op. Mode 3 is reserved. Both still reach Lazuli's bounded transfer
      // completion path so the prior TSTART/TCINT invariant is preserved.

      let operation;
      let outcome;
      let reason = null;
      const commandRegion = exiIplReadRegion(exi0IplCommandAddress);
      if (rtcImmediateOutOfBounds) {
        operation = "rtc-read";
        outcome = "rejected";
        reason = "rtc-source-out-of-bounds";
      } else if (sramImmediateOutOfBounds) {
        operation = "sram-read";
        outcome = "rejected";
        reason = "sram-source-out-of-bounds";
      } else if (transferMode === 2) {
        operation = "ipl-immediate-read-write";
        outcome = "ignored";
        reason = "ipl-read-write-no-op";
      } else if (transferMode === 3) {
        operation = "ipl-immediate-reserved";
        outcome = "rejected";
        reason = "reserved-transfer-mode";
      } else if (commandCompleted) {
        if (
          exi0IplCommandWrite === false
          && commandRegion !== null
        ) {
          operation = commandRegion === "rom"
            ? "ipl-address"
            : commandRegion === "rtc"
              ? "rtc-address"
              : "sram-address";
          outcome = "accepted";
        } else {
          operation = "unhandled";
          outcome = "ignored";
          reason = "non-ipl-command";
        }
      } else if (commandBytesBefore < 4) {
        operation = "ipl-command-frame";
        outcome = "pending";
        reason = "ipl-command-incomplete";
      } else if (
        exi0IplCommandWrite === false
        && commandRegion === "rom"
      ) {
        operation = "ipl-rom-read";
        imageStatus ??= exiIplImageStatus();
        if (!imageStatus.configured) {
          outcome = "unavailable";
          reason = "ipl-image-not-configured";
        } else if (!imageStatus.valid) {
          outcome = "rejected";
          reason = "invalid-ipl-image";
        } else {
          outcome = "complete";
        }
      } else if (
        exi0IplCommandWrite === false
        && commandRegion === "rtc"
      ) {
        operation = "rtc-read";
        outcome = "complete";
      } else if (
        exi0IplCommandWrite === false
        && commandRegion === "sram"
      ) {
        operation = "sram-read";
        outcome = "complete";
      } else {
        operation = "unhandled";
        outcome = "ignored";
        reason = "non-ipl-command";
      }

      return {
        transferMode,
        immediateLength,
        immediateBefore,
        immediateAfter,
        operation,
        outcome,
        reason,
        commandCompleted,
        commandWordBefore,
        commandWordAfter: exi0IplCommandWord,
        commandBytesBefore,
        commandBytesAfter: exi0IplCommandBytes,
        commandRegion,
        rtcRefreshed: rtcRefreshedSeconds !== null,
        rtcSeconds: rtcRefreshedSeconds,
        imageStatus,
      };
    }

    function recordExi0Transfer(transfer) {
      const recorded = {
        sequence: ++exiTransferSequence,
        channel: 0,
        ...transfer,
      };
      exiTransferOutcomes.set(
        recorded.outcome,
        (exiTransferOutcomes.get(recorded.outcome) ?? 0) + 1
      );
      if (recorded.dma) {
        exiDmaAttempts += 1;
        exiDmaOutcomes.set(
          recorded.outcome,
          (exiDmaOutcomes.get(recorded.outcome) ?? 0) + 1
        );
        if (recorded.reason !== null) {
          exiDmaReasons.set(
            recorded.reason,
            (exiDmaReasons.get(recorded.reason) ?? 0) + 1
          );
        }
        if (recorded.outcome === "complete") {
          exiDmaCompletions += 1;
          if (recorded.dmaLength === 0) {
            exiDmaZeroLengthCompletions += 1;
          }
        }
        exiLastDma = recorded;
      }
      exiTransferTrace.push(recorded);
      if (exiTransferTrace.length > exiTransferTraceLimit) {
        exiTransferTrace.shift();
        exiTransferTraceDropped += 1;
      }
      return recorded;
    }

    function serviceExi0(observedCycles) {
      const parameter = view.getUint32(mmio + 0x6800, false);
      const dmaBase = (
        view.getUint32(mmio + 0x6804, false)
        & exiDmaRegisterMask
      ) >>> 0;
      const dmaLength = (
        view.getUint32(mmio + 0x6808, false)
        & exiDmaRegisterMask
      ) >>> 0;
      const controlBefore = (
        view.getUint32(mmio + 0x680c, false)
        & exiTransferControlMask
      ) >>> 0;
      const immediate = view.getUint32(mmio + 0x6810, false);
      if ((controlBefore & 1) === 0) return false;

      const controlAfter = (controlBefore & ~1) >>> 0;
      deviceEvents.set(
        "exiChannel0",
        (deviceEvents.get("exiChannel0") ?? 0) + 1
      );

      const deviceSelect = (parameter >>> 7) & 7;
      const dma = (controlBefore & 2) !== 0;
      const transferMode = (controlBefore >>> 2) & 3;
      const commandWordBefore = exi0IplCommandWord;
      const commandBytesBefore = exi0IplCommandBytes;
      const iplCommandAddressBefore = exi0IplCommandAddress;
      const iplCursorBefore = exi0IplCursor;
      const addressSequenceBefore = exi0IplAddressSequence;
      let operation = "unhandled";
      let outcome = "ignored";
      let reason;
      let dmaTarget = null;
      let imageStatus = null;
      let immediateAfter = immediate;
      let immediateFraming = null;

      if (deviceSelect === 0) {
        outcome = "rejected";
        reason = "no-device-selected";
      } else if (
        (deviceSelect & (deviceSelect - 1)) !== 0
      ) {
        outcome = "rejected";
        reason = "multiple-device-select";
      } else if (deviceSelect !== 2) {
        outcome = "rejected";
        reason = "unsupported-device-select";
      } else if (!dma) {
        immediateFraming = transferExi0IplImmediate(
          controlBefore,
          immediate,
          observedCycles
        );
        immediateAfter = immediateFraming.immediateAfter;
        view.setUint32(mmio + 0x6810, immediateAfter, false);
        operation = immediateFraming.operation;
        outcome = immediateFraming.outcome;
        reason = immediateFraming.reason;
        imageStatus = immediateFraming.imageStatus;
      } else {
        const commandRegion = exiIplReadRegion(exi0IplCommandAddress);
        operation = commandRegion === "sram"
          ? "sram-dma-read"
          : commandRegion === "rtc"
            ? "rtc-dma-read"
            : "ipl-dma-read";
        if (commandRegion === "rom") {
          imageStatus = exiIplImageStatus();
        }
        if (transferMode !== 0) {
          outcome = "rejected";
          reason = "exi-dma-requires-read";
        } else if (
          exi0IplCommandBytes !== 4
          || exi0IplCommandWrite !== false
          || exi0IplAddressSequence === null
          || commandRegion === null
        ) {
          outcome = "rejected";
          reason = "exi-dma-without-readable-address-command";
        } else if (
          commandRegion === "rom"
          && !imageStatus.configured
        ) {
          outcome = "unavailable";
          reason = "ipl-image-not-configured";
        } else if (
          commandRegion === "rom"
          && !imageStatus.valid
        ) {
          outcome = "rejected";
          reason = "invalid-ipl-image";
        } else if (dmaLength === 0) {
          // Generic EXI devices clock zero bytes and still signal transfer
          // completion. The RAM address is not consulted in that case.
          outcome = "complete";
        } else if (commandRegion === "rtc") {
          outcome = "rejected";
          reason = "rtc-immediate-only";
        } else if (
          commandRegion === "rom"
          && (
            exi0IplCursor > imageStatus.byteLength
            || dmaLength > imageStatus.byteLength - exi0IplCursor
          )
        ) {
          outcome = "rejected";
          reason = "ipl-source-out-of-bounds";
        } else if (
          commandRegion === "sram"
          && (
            exi0IplCursor < exiSramSettingsBase
            || exi0IplCursor > exiSramBase + exiSramBytes
            || dmaLength > exiSramBase + exiSramBytes - exi0IplCursor
          )
        ) {
          outcome = "rejected";
          reason = "sram-source-out-of-bounds";
        } else {
          dmaTarget = physicalRamPointer(dmaBase, dmaLength);
          if (dmaTarget === null) {
            outcome = "rejected";
            reason = "ram-target-out-of-bounds";
          } else {
            invalidateDataReservationForExternalWrite(dmaBase, dmaLength);
            if (commandRegion === "rom") {
              bytes.set(
                exiIplImage.subarray(
                  exi0IplCursor,
                  exi0IplCursor + dmaLength
                ),
                dmaTarget
              );
              exi0IplDmaBytes += dmaLength;
            } else if (commandRegion === "sram") {
              const source = exi0IplCursor - exiSramBase;
              bytes.set(
                exiSram.subarray(source, source + dmaLength),
                dmaTarget
              );
              exi0SramDmaReads += 1;
              exi0SramDmaBytes += dmaLength;
            }
            exi0IplCursor = (exi0IplCursor + dmaLength) >>> 0;
            outcome = "complete";
          }
        }
      }

      const commandRegion = immediateFraming?.commandRegion
        ?? exiIplReadRegion(exi0IplCommandAddress);
      const sourceKind = (
        deviceSelect === 2
        && exi0IplCommandWrite === false
      ) ? commandRegion : null;
      const recorded = recordExi0Transfer({
        cycle: observedCycles,
        parameter: hex32(parameter),
        deviceSelect,
        dma,
        transferMode: exiTransferModeName(transferMode),
        transferModeCode: transferMode,
        immediateLength: ((controlBefore >>> 4) & 3) + 1,
        controlBefore: hex32(controlBefore),
        controlAfter: hex32(controlAfter),
        immediate: hex32(immediate),
        immediateAfter: hex32(immediateAfter),
        commandDirection: exi0IplCommandWrite === null
          ? "pending"
          : exi0IplCommandWrite ? "write" : "read",
        commandWordBefore: hex32(commandWordBefore),
        commandWordAfter: hex32(exi0IplCommandWord),
        commandBytesBefore,
        commandBytesAfter: exi0IplCommandBytes,
        commandRegion,
        rtcRefreshed: immediateFraming?.rtcRefreshed ?? false,
        rtcSeconds: immediateFraming?.rtcSeconds ?? null,
        sourceKind,
        commandAddress: hex32(exi0IplCommandAddress),
        dmaBase: hex32(dmaBase),
        dmaLength,
        operation,
        outcome,
        reason: reason ?? null,
        iplCommandAddressBefore: hex32(iplCommandAddressBefore),
        iplCommandAddressAfter: hex32(exi0IplCommandAddress),
        iplCursorBefore: hex32(iplCursorBefore),
        iplCursorAfter: hex32(exi0IplCursor),
        addressSequence: addressSequenceBefore,
        sourceConfigured: (
          sourceKind === "sram"
          || sourceKind === "rtc"
        )
          ? true
          : sourceKind === "rom"
            ? imageStatus?.configured ?? exiIplImage !== null
            : null,
      });
      if (
        immediateFraming?.commandCompleted === true
        && immediateFraming.commandRegion !== null
        && outcome === "accepted"
      ) {
        exi0IplAddressSequence = recorded.sequence;
      }
      completeExternalInterfaceTransfer(0);
      return true;
    }

    function serviceExternalInterface(observedCycles) {
      serviceExi0(observedCycles);
      for (const channel of [1, 2]) {
        if (!completeExternalInterfaceTransfer(channel)) continue;
        const event = "exiChannel" + channel;
        deviceEvents.set(event, (deviceEvents.get(event) ?? 0) + 1);
      }
      serviceExternalInterfaceInterrupt(observedCycles);
    }

    function snapshotExternalInterface() {
      const image = exiIplImageStatus();
      const parameter = view.getUint32(mmio + 0x6800, false);
      const channelParameters = Array.from(
        { length: 3 },
        (_unused, channel) =>
          view.getUint32(mmio + 0x6800 + channel * 0x14, false)
      );
      return {
        channel0: {
          parameter: hex32(parameter),
          deviceSelect: (parameter >>> 7) & 7,
          dmaBase: hex32(view.getUint32(mmio + 0x6804, false)),
          dmaLength: view.getUint32(mmio + 0x6808, false),
          control: hex32(view.getUint32(mmio + 0x680c, false)),
          immediate: hex32(view.getUint32(mmio + 0x6810, false)),
        },
        interrupt: {
          levelActive: exiInterruptLevelActive,
          levelChanges: exiInterruptLevelChanges,
          levelReason: exiInterruptLevelReason,
          piCause: (
            view.getUint32(mmio + 0x3000, false)
            & piExternalInterfaceInterruptCause
          ) !== 0,
          piMask: (
            view.getUint32(mmio + 0x3004, false)
            & piExternalInterfaceInterruptCause
          ) !== 0,
          completions: exiTransferCompletions,
          transferAcknowledgements:
            exiTransferInterruptAcknowledgements,
          piAssertions: exiPiAssertions,
          piDeassertions: exiPiDeassertions,
          externalDeliveries: exiExternalInterruptDeliveries,
          channels: channelParameters.map((value, channel) => ({
            channel,
            parameter: hex32(value),
            exi: (value & exiDeviceInterrupt) !== 0,
            exiMasked: (
              value & (exiDeviceInterruptMask | exiDeviceInterrupt)
            ) === (exiDeviceInterruptMask | exiDeviceInterrupt),
            transfer: (value & exiTransferInterrupt) !== 0,
            transferMasked: (
              value & (exiTransferInterruptMask | exiTransferInterrupt)
            ) === (exiTransferInterruptMask | exiTransferInterrupt),
            attach: channel < 2
              ? (value & exiAttachInterrupt) !== 0
              : false,
            attachMasked: channel < 2
              ? (
                  value & (exiAttachInterruptMask | exiAttachInterrupt)
                ) === (exiAttachInterruptMask | exiAttachInterrupt)
              : false,
          })),
        },
        ipl: {
          ...image,
          chipSelectActive: exi0IplChipSelectActive,
          commandWord: hex32(exi0IplCommandWord),
          commandBytes: exi0IplCommandBytes,
          commandDirection: exi0IplCommandWrite === null
            ? "pending"
            : exi0IplCommandWrite ? "write" : "read",
          commandAddress: hex32(exi0IplCommandAddress),
          cursor: hex32(exi0IplCursor),
          addressSequence: exi0IplAddressSequence,
          dmaBytes: exi0IplDmaBytes,
        },
        sram: {
          base: hex32(exiSramBase),
          byteLength: exiSram.byteLength,
          rtcModeled: true,
          rtcStartSeconds: exiRtcStartSeconds,
          rtcCurrentSeconds: readExiRtcSeconds(),
          rtcCyclesPerSecond: exiRtcCyclesPerSecond,
          rtcRefreshCount: exi0RtcRefreshCount,
          rtcLastRefreshCycle: exi0RtcLastRefreshCycle,
          rtcImmediateReadBytes: exi0RtcImmediateReadBytes,
          settingsBase: hex32(exiSramSettingsBase),
          settingsByteLength: exiSramBytes - 4,
          checksum: (exiSram[0x04] << 8) | exiSram[0x05],
          checksumInverse: (exiSram[0x06] << 8) | exiSram[0x07],
          flags: exiSram[0x17],
          immediateReadBytes: exi0SramImmediateReadBytes,
          dmaReads: exi0SramDmaReads,
          dmaBytes: exi0SramDmaBytes,
        },
        transfers: {
          total: exiTransferSequence,
          retained: exiTransferTrace.length,
          dropped: exiTransferTraceDropped,
          limit: exiTransferTraceLimit,
          outcomes: Object.fromEntries(
            [...exiTransferOutcomes.entries()].sort(([left], [right]) =>
              left.localeCompare(right)
            )
          ),
          dma: {
            attempts: exiDmaAttempts,
            completions: exiDmaCompletions,
            zeroLengthCompletions: exiDmaZeroLengthCompletions,
            outcomes: Object.fromEntries(
              [...exiDmaOutcomes.entries()].sort(([left], [right]) =>
                left.localeCompare(right)
              )
            ),
            reasons: Object.fromEntries(
              [...exiDmaReasons.entries()].sort(([left], [right]) =>
                left.localeCompare(right)
              )
            ),
            last: exiLastDma,
          },
          trace: exiTransferTrace,
        },
      };
    }

    function serviceMmio(observedCycles) {
      if (
        cpFifoState.distance !== 0
        && (cpFifoState.control & cpControlReadEnable) !== 0
      ) {
        serviceCommandProcessorFifo();
      }
      serviceCommandProcessorInterrupt(observedCycles);
      ensureViSchedule(observedCycles);
      serviceViDueEvents(observedCycles);
      serviceExternalInterface(observedCycles);
      serviceAudioInterface(observedCycles);
      serviceDsp(observedCycles);
      serviceSerial(observedCycles);
      servicePixelEngine(observedCycles);
      serviceVideoPresentation(observedCycles);
      serviceVideoInterrupt(observedCycles);
      serviceDisk(observedCycles);
      serviceDecrementer(observedCycles);
    }

    function processSerialCommand(channel, scheduledCycle, observedCycle) {
      const command = view.getUint8(mmio + 0x6480);
      if (channel !== 0) return serialTransferOutcome.noResponse;
      switch (command) {
        case 0x00:
        case 0xff:
          bytes.set([0x09, 0x00, 0x00], mmio + 0x6480);
          return serialTransferOutcome.success;
        case 0x40: {
          const packet = controllerPacketForPoll(
            channel,
            scheduledCycle,
            observedCycle,
            "direct"
          );
          bytes.set(packet, mmio + 0x6480);
          postControllerPollAcknowledgement(
            packet,
            "direct",
            scheduledCycle,
            observedCycle
          );
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
            packet = controllerPacketForPoll(
              channel,
              scheduledCycle,
              observedCycles,
              "periodic"
            );
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
        const buttons = postControllerPollAcknowledgement(
          packet,
          "periodic",
          scheduledCycle,
          observedCycles
        );
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
        const outcome = processSerialCommand(
          transfer.channel,
          transfer.completionCycle,
          observedCycles
        );
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
        invalidateDataReservationForExternalWrite(
          (target - ram) >>> 0,
          dmaLength
        );
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
          invalidateDataReservationForExternalWrite(
            (target - ram) >>> 0,
            diskTransfer.length
          );
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

    function instructionStorageCause(fault) {
      if (fault?.kind === "page-fault") return 0x40000000;
      if (fault?.kind === "guarded" || fault?.kind === "no-execute") {
        return 0x10000000;
      }
      if (fault?.kind === "protection") return 0x08000000;
      return null;
    }

    function raiseInstructionFetchFault(fault) {
      const cause = instructionStorageCause(fault);
      if (cause === null) return false;
      lastUnmappedAccess = {
        kind: "instruction-fetch",
        reason: fault.kind,
        address: hex32(fault.effective),
        pc: hex32(view.getUint32(cpu + pcOffset, true)),
        dispatch: dispatches,
      };
      raiseException(cpu, 0x0400, cause, null);
      return true;
    }

    function raiseException(registers, exception, specialSrr1 = 0, instruction = undefined) {
      const oldPc = view.getUint32(registers + pcOffset, true);
      const oldMsr = view.getUint32(registers + msrOffset, true);
      const exceptionName = "0x" + exception.toString(16).padStart(4, "0");
      exceptionCounts.set(exceptionName, (exceptionCounts.get(exceptionName) ?? 0) + 1);
      const sample = {
        exception: exceptionName,
        pc: "0x" + oldPc.toString(16).padStart(8, "0"),
        instruction: instruction === undefined ? instructionDiagnostic(oldPc) : instruction,
        msr: "0x" + oldMsr.toString(16).padStart(8, "0"),
        dar: "0x" + view.getUint32(registers + darOffset, true).toString(16).padStart(8, "0"),
        dispatch: dispatches,
      };
      if (exception === 0x0300) {
        sample.dsisr = hex32(view.getUint32(registers + dsisrOffset, true));
        sample.dataStorageFault = lastDataStorageFault;
      }
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
      srr1 |= specialSrr1 & specialSrr1Mask;
      view.setUint32(registers + srr0Offset, oldPc + (exception === 0x0c00 ? 4 : 0), true);
      view.setUint32(registers + srr1Offset, srr1, true);

      const exceptionMsr = ((oldMsr >>> 16) & 1) | (oldMsr & 0x00011040);
      const vectorBase = (oldMsr & 0x40) === 0 ? 0 : 0xfff00000;
      view.setUint32(registers + msrOffset, exceptionMsr, true);
      if (((oldMsr ^ exceptionMsr) & 0x4010) !== 0) rebuildDataFastmem();
      if (((oldMsr ^ exceptionMsr) & 0x4020) !== 0) {
        synchronizeInstructionAddressSpace("exception");
      }
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
      const firstStore = probeInstructionWord(currentPc);
      const decrement = probeInstructionWord((currentPc + 4) >>> 0);
      if (firstStore === null || decrement === null) return null;
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
        const store = probeInstructionWord((currentPc + 4 + index * 4) >>> 0);
        if (store === null) return null;
        if (
          (store >>> 26) !== 36
          || ((store >>> 21) & 31) !== valueRegister
          || ((store >>> 16) & 31) !== baseRegister
          || (store & 0xffff) !== (index + 1) * 4
        ) return null;
      }
      const finalStore = probeInstructionWord((currentPc + 0x20) >>> 0);
      if (
        finalStore === null
        || (finalStore >>> 26) !== 37
        || ((finalStore >>> 21) & 31) !== valueRegister
        || ((finalStore >>> 16) & 31) !== baseRegister
        || (finalStore & 0xffff) !== 32
        || probeInstructionWord((currentPc + 0x24) >>> 0) !== 0x4082ffdc
      ) return null;
      return { baseRegister, counterRegister, valueRegister };
    }

    function isCacheLineLoop(currentPc) {
      const cacheInstruction = probeInstructionWord(currentPc);
      return [0x7c0018ac, 0x7c00186c, 0x7c001bac, 0x7c001fec, 0x7c001fac]
        .includes(cacheInstruction)
        && probeInstructionWord((currentPc + 4) >>> 0) === 0x38630020
        && probeInstructionWord((currentPc + 8) >>> 0) === 0x4200fff8;
    }

    function cacheInstructionUsesStoreAccess(cacheInstruction) {
      return cacheInstruction === 0x7c001bac || cacheInstruction === 0x7c001fec;
    }

    function translateCacheLoopRange(cacheInstruction, effectiveStart, byteCount) {
      // The 750 performs a virtual index lookup for icbi without translating it.
      if (cacheInstruction === 0x7c001fac) {
        const start = effectiveStart >>> 0;
        return byteCount <= 0x100000000 - start ? start : null;
      }
      return translateDataRange(
        effectiveStart,
        byteCount,
        cacheInstructionUsesStoreAccess(cacheInstruction),
        true
      );
    }

    function fastForwardRecognizedLoop(currentPc, maximumExecuted) {
      const cacheInstruction = fetchWord(currentPc);
      if (isCacheLineLoop(currentPc)) {
        const groups = view.getUint32(cpu + ctrOffset, true);
        if (groups > 1) {
          const skipped = loopSkipBudget(groups - 1, 6, maximumExecuted);
          if (skipped === 0) return;
          const guestStart = readGpr(3);
          const byteCount = skipped * 32;
          const guestRangeStart = (guestStart & 0xffffffe0) >>> 0;
          const physicalStart = translateCacheLoopRange(
            cacheInstruction,
            guestRangeStart,
            byteCount
          );
          if (physicalStart === null) return;
          if (cacheInstruction === 0x7c001fac) {
            invalidateInstructionCacheRange(guestRangeStart, byteCount);
          }
          if (cacheInstruction === 0x7c001fec) {
            const target = physicalRamPointer(physicalStart, byteCount)
              ?? physicalLockedCachePointer(physicalStart, byteCount);
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
      const physicalStart = translateDataRange(guestStart, byteCount, true, true);
      if (physicalStart === null) return;
      const target = physicalRamPointer(physicalStart, byteCount)
        ?? physicalLockedCachePointer(physicalStart, byteCount);
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
      return isSemanticIdlePattern(compiledBlock(candidatePc)?.pattern)
        || isCacheLineLoop(candidatePc)
        || decodeMemset32ByteLoop(candidatePc) !== null;
    }

    function runtimeEventCycleCandidates(observedCycles, includeCycleLimit = true) {
      ensureViSchedule(observedCycles);
      return [
        viTiming?.displayEnabled ? nextViCycle : null,
        viTiming?.displayEnabled ? nextViPresentCycle : null,
        viTiming?.displayEnabled ? nextViBoundaryCycle : null,
        viTiming?.displayEnabled ? nextViTimingBoundaryCycle : null,
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
      ];
    }

    function runtimeEventDueAtOrBefore(observedCycles) {
      return runtimeEventCycleCandidates(observedCycles, false)
        .some(value => value !== null && value <= observedCycles);
    }

    function nextRuntimeEventCycle(includeCycleLimit = true) {
      const candidates = runtimeEventCycleCandidates(cycles, includeCycleLimit)
        .filter(value => value !== null && value > cycles);
      return candidates.length === 0 ? null : Math.min(...candidates);
    }

    function nextStableWaitEventCycle(semanticIdle, repeatedBoundaryCount) {
      const stableWait = semanticIdle
        ? repeatedBoundaryCount >= 2
        : repeatedBoundaryCount >= 128;
      return stableWait ? nextRuntimeEventCycle(false) : null;
    }

    function stageInstructionBlock(compilerView, inputPointer, pc, maximumWords = 64) {
      if (
        !Number.isSafeInteger(maximumWords)
        || maximumWords <= 0
        || maximumWords > 64
      ) {
        throw new RangeError("instruction block size must be between 1 and 64 words");
      }
      for (let index = 0; index < maximumWords; index += 1) {
        // Staging is compiler lookahead, not an architected instruction
        // fetch. Keep it side-effect-free until the compiler tells us the
        // exact executable extent; otherwise an early branch can set R and
        // perturb ITLB LRU state for instructions the guest never fetches.
        const fetched = fetchInstructionWord(
          (pc + index * 4) >>> 0,
          false
        );
        if (fetched.kind !== "mapped") {
          return { wordCount: index, fault: fetched };
        }
        compilerView.setUint32(inputPointer + index * 4, fetched.word, true);
      }
      return { wordCount: maximumWords, fault: null };
    }

    function compileBlock(compiler, inputPointer, pc) {
      const compilerView = new DataView(compiler.memory.buffer);
      const staged = stageInstructionBlock(compilerView, inputPointer, pc);
      const { wordCount } = staged;
      if (wordCount === 0) {
        // The first instruction really is being fetched, including the
        // MPC750 rule that a matched protection/guarded PTE sets R. Repeat
        // only this faulting word with architectural side effects enabled.
        const fetched = fetchInstructionWord(pc, true);
        return { fault: fetched.kind === "mapped" ? staged.fault : fetched };
      }

      const succeeded = compiler.ppcwasmjit_compile(inputPointer, wordCount);
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
      const maximum = compiler.ppcwasmjit_maximum_executed() >>> 0;
      const effectiveBytes = Math.max(4, (maximum & 0xffff) * 4);
      const retained = captureInstructionPageDependencies(pc, effectiveBytes);
      if (retained.fault !== null) return { fault: retained.fault };
      return {
        maximum,
        pattern: compiler.ppcwasmjit_pattern() >>> 0,
        wasm: new Uint8Array(compiler.memory.buffer, pointer, length).slice(),
        effectiveStart: pc >>> 0,
        effectiveBytes,
        instructionPageDependencies: retained.dependencies,
      };
    }

    async function linkCompiledRegion(compiler, inputPointer, pcs) {
      const compilerView = new DataView(compiler.memory.buffer);
      for (const [index, regionPc] of pcs.entries()) {
        const block = compiledBlock(regionPc);
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
        compiledBlock(regionPc).instance.exports.run,
      ]));
      const { instance } = await WebAssembly.instantiate(wasm, {
        lazuli: { memory },
        lazuli_blocks: blockImports,
      });
      return {
        instance,
        pcs,
        instructionAddressSpaceKey,
        instructionAddressSpaceGeneration,
      };
    }

    function maybeLinkHotRegion(compiler, inputPointer, currentPc) {
      if (compiledRegion(currentPc) !== undefined || isRecognizedLoopPc(currentPc)) {
        return null;
      }
      const previous = recentPcs.lastIndexOf(currentPc);
      if (previous < 0) return null;

      const pcs = [...new Set(recentPcs.slice(previous))];
      if (
        pcs.length === 0 || pcs.length > 16
        || pcs.some(regionPc => {
          const block = compiledBlock(regionPc);
          return block === undefined
            || blockHasInstructionPageDependencies(block)
            || isRecognizedLoopPc(regionPc);
        })
      ) return null;

      const key = pcs.map(regionPc => regionPc.toString(16)).join(",");
      const hits = (regionCandidateHits.get(key) ?? 0) + 1;
      regionCandidateHits.set(key, hits);
      if (hits !== 8) return null;

      return linkCompiledRegion(compiler, inputPointer, pcs).then(region => {
        for (const regionPc of pcs) {
          const key = instructionRegionKey(regionPc);
          if (!regionsByPc.has(key)) regionsByPc.set(key, region);
        }
        accelerations.set(
          "wasmRegionsLinked",
          (accelerations.get("wasmRegionsLinked") ?? 0) + 1
        );
      });
    }

    function maybeFuseRegionExit(compiler, inputPointer, sourceRegion, nextPc) {
      if (sourceRegion.pcs.includes(nextPc) || isRecognizedLoopPc(nextPc)) return null;

      const targetRegion = compiledRegion(nextPc);
      const targetPcs = targetRegion?.pcs ?? [nextPc];
      const pcs = [...new Set([...sourceRegion.pcs, ...targetPcs])];
      if (
        pcs.length === sourceRegion.pcs.length
        || pcs.some(regionPc => {
          const block = compiledBlock(regionPc);
          return block === undefined
            || blockHasInstructionPageDependencies(block)
            || isRecognizedLoopPc(regionPc);
        })
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
        for (const regionPc of pcs) {
          regionsByPc.set(instructionRegionKey(regionPc), region);
        }
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
              viFields: {
                submitted: viPresentationCount,
                staged: viFieldStagedCount,
                presented: viHostPresentationCount,
                rejected: viFieldRejectedCount,
                superseded: viFieldSupersededCount,
                lastStatus: viLastResultStatus,
                lastPairEpoch: viLastResultPairEpoch,
              },
            },
          },
          hostTiming: snapshotWorkerHostTimings(),
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
          writeGather: {
            pendingBytes: gxWriteGatherPendingBytes,
            highWaterBytes: gxWriteGatherHighWaterBytes,
            bursts: gxWriteGatherBursts,
            linkedBursts: gxWriteGatherLinkedBursts,
            unlinkedBursts: gxWriteGatherUnlinkedBursts,
            bytesCommitted: gxWriteGatherBytesCommitted,
            wraps: gxWriteGatherWraps,
            resets: gxWriteGatherResets,
            discardedBytes: gxWriteGatherDiscardedBytes,
            lastDestination: gxWriteGatherLastDestination === null
              ? null
              : hex32(gxWriteGatherLastDestination),
          },
          commandProcessor: {
            serviceCalls: commandProcessorServiceCalls,
            readBursts: commandProcessorReadBursts,
            readBytes: commandProcessorReadBytes,
            readWraps: commandProcessorReadWraps,
            breakpointStops: commandProcessorBreakpointStops,
            readDisabledStops: commandProcessorReadDisabledStops,
            maximumDistance: commandProcessorMaximumDistance,
            maximumRawDistance: commandProcessorMaximumRawDistance,
            distanceNormalizations: commandProcessorDistanceNormalizations,
            lastDistanceNormalization: commandProcessorLastDistanceNormalization === null
              ? null
              : {
                  raw: hex32(commandProcessorLastDistanceNormalization.rawDistance),
                  normalized: hex32(
                    commandProcessorLastDistanceNormalization.normalizedDistance
                  ),
                  base: hex32(commandProcessorLastDistanceNormalization.base),
                  end: hex32(commandProcessorLastDistanceNormalization.end),
                  writePointer: hex32(
                    commandProcessorLastDistanceNormalization.writePointer
                  ),
                  readPointer: hex32(
                    commandProcessorLastDistanceNormalization.readPointer
                  ),
                  control: "0x" + commandProcessorLastDistanceNormalization.control
                    .toString(16).padStart(4, "0"),
                },
            decoderResets: commandProcessorDecoderResets,
            decoderDiscardedBytes: commandProcessorDecoderDiscardedBytes,
          },
          decoder: {
            commands: gxDecodedCommands,
            bufferedBytes: gxFifoBufferedBytes(),
            capacityWatermarkBytes: gxDecodeCapacityWatermarkBytes,
            maximumBufferedBytes: gxDecodeMaximumBufferedBytes,
            retryAtBufferedBytes: gxDecodeRetryAtBufferedBytes,
            decodeAttempts: gxDecodeAttempts,
            blockedDecodeSkips: gxDecodeBlockedSkips,
            compactions: gxDecodeCompactions,
            capacityWatermarkGrowths: gxDecodeCapacityWatermarkGrowths,
            preDecodeHighWaterBytes: gxDecodePreDecodeHighWaterBytes,
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
            lightingRejectedVertices: gxLightingRejectedVertices,
            legacyProjectionNullVertices: gxLegacyProjectionNullVertices,
            exactRequiredDraws: gxExactRequiredDraws,
            exactRequiredVertices: gxExactRequiredVertices,
            exactRequiredCaptureMisses: gxExactRequiredCaptureMisses,
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
          pollIndex: controllerPollIndex,
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
          lastActiveHostPublication: serialLastActiveHostPublication,
          lastRespondedChannels: serialLastRespondedChannels,
          lastPublishedChannels: serialLastPublishedChannels,
          lastUpdatedChannels: serialLastUpdatedChannels,
          lastEnabledChannels: serialLastEnabledChannels,
          guestPad: inspectSuperMonkeyBallPad0(),
          ...controllerState,
        },
        scenario: snapshotControllerScenario(controllerScenario),
        ...(controllerScenario?.id === "smb-sustained-play" ? {
          sustainedPlay: snapshotSmbSustainedPlay(controllerScenario),
        } : {}),
        guestGame: inspectGuestGameState(),
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
            [
              0x0000, 0x0002, 0x0004,
              0x0020, 0x0022, 0x0024, 0x0026,
              0x0028, 0x002a, 0x002c, 0x002e,
              0x0030, 0x0032, 0x0034, 0x0036,
              0x0038, 0x003a, 0x003c, 0x003e,
            ]
              .map(offset => [
                "0x" + offset.toString(16).padStart(4, "0"),
                "0x" + readCommandProcessorRegister(
                  0x0c000000 + offset,
                  2
                ).toString(16).padStart(4, "0"),
              ])
          ),
          commandProcessorFifo: snapshotCommandProcessorFifo(),
          processorInterfaceFifo: snapshotProcessorInterfaceFifo(),
          pixelEngine: Object.fromEntries(
            [0x100a, 0x100e].map(offset => [
              "0x" + offset.toString(16),
              "0x" + view.getUint16(mmio + offset, false).toString(16).padStart(4, "0"),
            ])
          ),
          viTiming: viTiming === null ? decodeViTiming() : {
            ...viTiming,
            currentHalfLine: viCurrentHalfLine(cycles),
            currentVct: viBeamPositionAtCycle(cycles).vct,
            currentHct: viBeamPositionAtCycle(cycles).hct,
            currentFieldParity: viCurrentHalfLine(cycles) < viTiming.oddHalfLines
              ? "odd"
              : "even",
            epochCycle: viEpochCycle,
            epochHalfLine: viEpochHalfLine,
            beamEnabled: viBeamEnabled,
            frozenBeam: viFrozenBeam,
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
            hostPresentationCount: viHostPresentationCount,
            stagedFieldCount: viFieldStagedCount,
            rejectedFieldCount: viFieldRejectedCount,
            supersededFieldCount: viFieldSupersededCount,
            lastResultStatus: viLastResultStatus,
            lastResultPairEpoch: viLastResultPairEpoch,
            lastHostPresentationCycle: viLastHostPresentationCycle,
            lastHostPresentationField: viLastHostPresentationField,
            lastHostPresentationAddress: hex32(viLastHostPresentationAddress),
            lastHostPresentationCopyIndex: viLastHostPresentationCopyIndex,
            lastHostPresentationCopyRow: viLastHostPresentationCopyRow,
            lastHostPresentationPairEpoch: viLastHostPresentationPairEpoch,
            lastHostPresentationSerial: viLastHostPresentationSerial,
            pendingFieldPair: viPendingFieldPair === null
              ? null
              : {
                pairEpoch: viPendingFieldPair.pairEpoch,
                field: viPendingFieldPair.field,
              },
            resultCounts: Object.fromEntries(
              [...viResultCounts.entries()].sort(([left], [right]) =>
                left.localeCompare(right)
              )
            ),
            nextPresentationCycle: nextViPresentCycle,
            nextScanoutBoundaryCycle: nextViBoundaryCycle,
            nextTimingBoundaryCycle: nextViTimingBoundaryCycle,
            scanoutPending: {
              topBase: cloneViScanoutEntry(viScanoutPending.topBase),
              bottomBase: cloneViScanoutEntry(viScanoutPending.bottomBase),
              picture: cloneViScanoutEntry(viScanoutPending.picture),
            },
            scanoutActive: viScanoutStateSnapshot(),
            lastPresentationCycle: viLastHostPresentationCycle,
            lastPresentationField: viLastHostPresentationField,
            lastPresentationAddress: hex32(viLastHostPresentationAddress),
            lastPresentationCopyIndex: viLastHostPresentationCopyIndex,
            lastPresentationCopyRow: viLastHostPresentationCopyRow,
            lastFieldCycle: viLastPresentationCycle,
            lastFieldParity: viLastPresentationField,
            lastFieldAddress: hex32(viLastPresentationAddress),
            lastFieldCopyIndex: viLastPresentationCopyIndex,
            lastFieldCopyRow: viLastPresentationCopyRow,
            serialPoll: {
              raw: hex32(view.getUint32(mmio + 0x6430, false)),
              xLines: (view.getUint32(mmio + 0x6430, false) >>> 16) & 0x03ff,
              yPolls: (view.getUint32(mmio + 0x6430, false) >>> 8) & 0x00ff,
            },
            trace: viTrace,
          },
          viDisplayConfig: "0x" + view.getUint16(mmio + 0x2002, false).toString(16).padStart(4, "0"),
          viPictureConfiguration: "0x" + view.getUint16(mmio + 0x2048, false).toString(16).padStart(4, "0"),
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
          externalInterface: snapshotExternalInterface(),
          diskTransfer,
          serialTransfer,
          peFinishCycle,
          peFinishSignal,
          peTokenValue,
          peTokenSignal,
          peTokenInterruptDelivered,
          dspCurrentMail: hex32(dspCurrentMail),
          dspQueuedMails: dspMailQueue.length,
          dspScheduledMail,
          dspMode,
          dspUcodeHash: dspUcodeHash === null ? null : hex32(dspUcodeHash),
          dspAxCommand: {
            phase: dspAxCommandState.phase,
            sizeWords: dspAxCommandState.sizeWords,
            address:
              dspAxCommandState.address === null
                ? null
                : hex32(dspAxCommandState.address),
            listCount: dspAxCommandState.listCount,
            wordCount: dspAxCommandState.wordCount,
            commandCount: dspAxCommandState.commandCount,
            commandSample: dspAxCommandState.commandSample.map(
              command =>
                "0x" + command.toString(16).padStart(2, "0")
            ),
            writeCount: dspAxCommandState.writeCount,
            clearedBytes: dspAxCommandState.clearedBytes,
            rejected: dspAxCommandState.rejected,
            reason: dspAxCommandState.reason,
            lastTaskMail:
              dspAxCommandState.lastTaskMail === null
                ? null
                : hex32(dspAxCommandState.lastTaskMail),
          },
          dspZeldaCommand: {
            phase: dspZeldaCommandState.phase,
            expectedWords: dspZeldaCommandState.expectedWords,
            commandWordCount: dspZeldaCommandState.commandWordCount,
            bufferedWords: dspZeldaCommandState.words.length,
            rejected: dspZeldaCommandState.rejected,
            reason: dspZeldaCommandState.reason,
            lastCommand:
              dspZeldaCommandState.lastCommand === null
                ? null
                : hex32(dspZeldaCommandState.lastCommand),
            lastSync:
              dspZeldaCommandState.lastSync === null
                ? null
                : "0x" +
                  dspZeldaCommandState.lastSync.toString(16).padStart(4, "0"),
            setup:
              dspZeldaCommandState.setup === null
                ? null
                : {
                    voicesPerFrame:
                      dspZeldaCommandState.setup.voicesPerFrame,
                    vpbBaseAddress: hex32(
                      dspZeldaCommandState.setup.vpbBaseAddress
                    ),
                    coefficientAddress: hex32(
                      dspZeldaCommandState.setup.coefficientAddress
                    ),
                    afcCoeffAddress: hex32(
                      dspZeldaCommandState.setup.afcCoeffAddress
                    ),
                    reverbPbBaseAddress: hex32(
                      dspZeldaCommandState.setup.reverbPbBaseAddress
                    ),
                  },
            render: {
              active: dspZeldaCommandState.render.active,
              awaitingTaskMail:
                dspZeldaCommandState.render.awaitingTaskMail,
              requestedFrames:
                dspZeldaCommandState.render.requestedFrames,
              currentFrame: dspZeldaCommandState.render.currentFrame,
              currentVoice: dspZeldaCommandState.render.currentVoice,
              outputVolume: dspZeldaCommandState.render.outputVolume,
              outputLeftAddress:
                dspZeldaCommandState.render.outputLeftAddress === null
                  ? null
                  : hex32(
                      dspZeldaCommandState.render.outputLeftAddress
                    ),
              outputRightAddress:
                dspZeldaCommandState.render.outputRightAddress === null
                  ? null
                  : hex32(
                      dspZeldaCommandState.render.outputRightAddress
                    ),
              clearedBytes: dspZeldaCommandState.render.clearedBytes,
            },
          },
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
        const backpressureStartedAt = beginWorkerPhaseTiming(
          workerHostTimings.rendererBackpressure
        );
        try {
          await new Promise(resolve => {
            rendererBackpressureResume = resolve;
          });
        } finally {
          recordWorkerPhaseTiming(
            workerHostTimings.rendererBackpressure,
            backpressureStartedAt
          );
        }
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
      resetFifoRegisterState();
      bytes.fill(0, mmio, mmio + mmioSize);
      // PI cause bit 16 is the active-low physical reset button input. Games
      // treat a cleared bit as a held reset button and eventually call
      // OSResetSystem, so power-on must expose the released state.
      view.setUint32(mmio + 0x3000, 0x00010000, false);
      view.setUint16(mmio + 0x5016, 1, false);
      pushDspMail(0x8071feed, false, "initialize");
      deviceEvents.set("dspInitialize", (deviceEvents.get("dspInitialize") ?? 0) + 1);
      initializeTranslationLookasideBuffers();
      initializePageTableRegisters();
      initializeMemoryManagement();
      rebuildDataFastmem();
      synchronizeInstructionAddressSpace("initialize");
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
          lazuli_fifo: { flush: drainGxFifoStagingForJit },
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

      async function finishTerminalControllerScenario() {
        const scenarioStatus = serviceControllerScenario(controllerScenario, cycles);
        if (scenarioStatus !== "complete" && scenarioStatus !== "failed") return;
        const failed = scenarioStatus === "failed";
        await finishAfterRendererDrain(failed ? "stopped" : "paused", {
          stage: failed ? "scenario-failed" : "scenario-complete",
          pc: hex32(pc),
          error: failed ? controllerScenario.failure.reason : undefined,
          instructions,
          cycles,
          dispatches,
          compiledBlocks: blocks.size,
        });
        throw Symbol.for("reported");
      }

      for (;;) {
        if (runnerSnapshotRequested) publishRunnerSnapshot();
        while (rendererFramesInFlight.size !== 0 || rendererFailure !== null) {
          await honorRendererBackpressure();
          if (runnerStopRequested) break;
          serviceVideoPresentation(cycles);
        }
        if (runnerPaused || runnerStopRequested) await honorRunnerControl();
        await finishTerminalControllerScenario();
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
        let block = compiledBlock(pc);
        if (
          block !== undefined
          && !validateInstructionPageDependencies(block.instructionPageDependencies)
        ) {
          invalidateCompiledBlock(block, "pre-execution-validation");
          block = undefined;
        }
        if (block === undefined) {
          try {
            block = compileBlock(compiler, inputPointer, pc);
          } catch (error) {
            await finishAfterRendererDrain("stopped", {
              stage,
              pc: "0x" + pc.toString(16).padStart(8, "0"),
              instruction: instructionDiagnostic(pc),
              error: String(error?.message ?? error),
              instructions,
              cycles,
              dispatches,
              compiledBlocks: blocks.size,
            });
            throw Symbol.for("reported");
          }
          if (block.fault !== undefined) {
            if (raiseInstructionFetchFault(block.fault)) {
              pc = view.getUint32(cpu + pcOffset, true);
              continue;
            }
            lastUnmappedAccess = {
              kind: "instruction-fetch",
              reason: block.fault.kind,
              address: hex32(block.fault.effective),
              physical: block.fault.physical === undefined
                ? null
                : hex32(block.fault.physical),
              pc: hex32(pc),
              dispatch: dispatches,
            };
            await finishAfterRendererDrain("stopped", {
              stage: "instruction-fetch",
              pc: hex32(pc),
              instruction: null,
              error: block.fault.kind === "unbacked"
                ? "instruction fetch reached unbacked physical storage"
                : "instruction fetch requires segment/page-table translation",
              instructionFetch: lastUnmappedAccess,
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
          block.effectiveStart = pc >>> 0;
          block.effectiveBytes = Math.max(4, (block.maximum & 0xffff) * 4);
          block.physicalRanges = mapInstructionPhysicalRanges(
            block.effectiveStart,
            block.effectiveBytes
          );
          block.physicalStart = block.physicalRanges.length === 1
            ? block.physicalRanges[0].start
            : null;
          block.physicalBytes = block.physicalRanges.length === 1
            ? block.physicalRanges[0].bytes
            : 0;
          block.instance = instance;
          block.instructionAddressSpaceKey = instructionAddressSpaceKey;
          block.instructionAddressSpaceGeneration = instructionAddressSpaceGeneration;
          delete block.wasm;
          blocks.set(instructionBlockKey(pc), block);
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
        const retainedRegion = compiledRegion(pc);
        const region = retainedRegion !== undefined
          && compiledRegionIsExecutable(retainedRegion)
          ? retainedRegion
          : undefined;
        const eventCycle = nextRuntimeEventCycle();
        const regionCycleBudget = eventCycle === null
          ? 0x7fffffff
          : Math.min(0x7fffffff, eventCycle - cycles);
        const regionBlockBudget = Math.min(4096, dispatchLimit - dispatches);
        if (region !== undefined && regionCycleBudget > 0 && regionBlockBudget > 0) {
          stage = "execute-region";
          view.setUint32(regionControl + regionCyclePrefixOffset, 0, true);
          view.setUint32(regionControl + regionExitRequestOffset, 0, true);
          view.setUint32(regionControl + hookCycleOffset, 0, true);
          regionRunning = true;
          const executionStartedAt = beginWorkerExecutionTiming();
          try {
            const result = region.instance.exports.run(
              regionControl,
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
            if (executionStartedAt !== null) {
              recordWorkerPhaseTiming(workerHostTimings.execution, executionStartedAt);
            }
          }
          if (executedBlocks !== 0) {
            executedRegion = true;
            regionRequestedExit = view.getUint32(
              regionControl + regionExitRequestOffset,
              true
            ) !== 0;
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
          view.setUint32(regionControl + regionCyclePrefixOffset, 0, true);
          view.setUint32(regionControl + regionExitRequestOffset, 0, true);
          view.setUint32(regionControl + hookCycleOffset, 0, true);
          try {
            const executionStartedAt = beginWorkerExecutionTiming();
            let executed;
            try {
              executed = block.instance.exports.run(regionControl, cpu, fastmem) >>> 0;
            } finally {
              if (executionStartedAt !== null) {
                recordWorkerPhaseTiming(workerHostTimings.execution, executionStartedAt);
              }
            }
            executedInstructions = executed & 0xffff;
            executedCycles = executed >>> 16;
            executedBlocks = 1;
          } catch (error) {
            await finishAfterRendererDrain("stopped", {
              stage,
              pc: "0x" + pc.toString(16).padStart(8, "0"),
              instruction: instructionDiagnostic(pc),
              error: String(error?.message ?? error),
              instructions,
              cycles,
              dispatches,
              compiledBlocks: blocks.size,
            });
            throw Symbol.for("reported");
          }
        }

        const observedCycles = cycles + executedCycles;
        drainGxFifoStagingAtCycle(observedCycles);
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

        await finishTerminalControllerScenario();

        const semanticIdle = !executedRegion
          && executedBlocks === 1
          && pc === executedPc
          && isSemanticIdlePattern(block.pattern);
        const deviceEventCycle = nextStableWaitEventCycle(
          semanticIdle,
          samePcCount
        );
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
          await finishTerminalControllerScenario();
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
    function newRendererPhaseTiming(sampleStride) {
      return { eligibleCalls: 0, sampleStride, samples: 0, totalMs: 0, maxMs: 0 };
    }
    function beginRendererPhaseTiming(timing) {
      const eligibleCall = timing.eligibleCalls;
      timing.eligibleCalls += 1;
      return eligibleCall % timing.sampleStride === 0 ? performance.now() : null;
    }
    function recordRendererPhaseTiming(timing, startedAt, endedAt) {
      if (startedAt === null) return;
      const stoppedAt = endedAt === undefined ? performance.now() : endedAt;
      const durationMs = stoppedAt - startedAt;
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      timing.samples += 1;
      timing.totalMs = Math.min(Number.MAX_VALUE, timing.totalMs + durationMs);
      timing.maxMs = Math.max(timing.maxMs, durationMs);
    }
    function snapshotRendererPhaseTiming(
      timing,
      eligibleCalls = timing?.eligibleCalls ?? timing?.samples ?? 0,
      sampleStride = timing?.sampleStride ?? 1
    ) {
      return {
        eligibleCalls: Number(eligibleCalls),
        sampleStride: Number(sampleStride),
        samples: Number(timing?.samples ?? 0),
        totalMs: Number(timing?.totalMs ?? 0),
        maxMs: Number(timing?.maxMs ?? 0),
      };
    }
    function newRendererWallPhases() {
      return {
        operationQueueWait: newRendererPhaseTiming(64),
        operationDispatch: newRendererPhaseTiming(64),
        operationTotal: newRendererPhaseTiming(64),
        queueDrain: newRendererPhaseTiming(64),
      };
    }
    function snapshotRendererWallPhases(hostPhases, webgpuPhases) {
      return {
        operationQueueWait: snapshotRendererPhaseTiming(hostPhases.operationQueueWait),
        operationDispatch: snapshotRendererPhaseTiming(hostPhases.operationDispatch),
        operationTotal: snapshotRendererPhaseTiming(hostPhases.operationTotal),
        queueDrain: snapshotRendererPhaseTiming(hostPhases.queueDrain),
        packetParse: snapshotRendererPhaseTiming(webgpuPhases.packetParse),
        topologyExpansion: snapshotRendererPhaseTiming(
          webgpuPhases.topologyExpansion,
          webgpuPhases.drawSampling.eligibleCalls,
          webgpuPhases.drawSampling.sampleStride
        ),
        resourcePreparation: snapshotRendererPhaseTiming(
          webgpuPhases.resourcePreparation,
          webgpuPhases.drawSampling.eligibleCalls,
          webgpuPhases.drawSampling.sampleStride
        ),
        gxFrameExecution: snapshotRendererPhaseTiming(webgpuPhases.gxFrameExecution),
      };
    }
    function newRendererHostMetrics() {
      return {
        operations: { enqueued: 0, pending: 0, highWater: 0 },
        workerMessages: { gxFrames: 0, drawCalls: 0, receivedArrayBufferBytes: 0 },
        wall: {
          workerStartToLastReportMs: null,
          phases: newRendererWallPhases(),
        },
      };
    }
    let rendererHostMetrics = newRendererHostMetrics();
    let rendererWorkerStartedAt = performance.now();
    let lastPresentedViProjection = null;
    const temporalSelectedXfbCapacity = 8;
    let temporalSelectedXfbFrames = [];
    function compositorCaptureOptIn(search) {
      const params = new URLSearchParams(search);
      const captureValues = params.getAll("compositorCapture");
      if (captureValues.length === 0) return false;
      const scenarioValues = params.getAll("scenario");
      const headlessRunValues = params.getAll("headlessRun");
      if (
        captureValues.length !== 1
        || captureValues[0] !== "1"
        || scenarioValues.length !== 1
        || scenarioValues[0] !== "smb-ready-play"
        || headlessRunValues.length !== 1
        || headlessRunValues[0].length === 0
      ) {
        throw new Error(
          "compositor capture requires exactly one non-empty headlessRun with "
          + "scenario=smb-ready-play&compositorCapture=1"
        );
      }
      return true;
    }
    const compositorCaptureEnabled = compositorCaptureOptIn(location.search);
    const compositorCaptureTimeoutMs = 60_000;
    let compositorCaptureWorkerEpoch = 0;
    let compositorCaptureSequence = 0;
    let activeCompositorCapture = null;
    let acknowledgedCompositorCaptureToken = null;

    function freezeCompositorGeometry(canvas, viewport, visual) {
      return Object.freeze({
        canvas: Object.freeze({ ...canvas }),
        viewport: Object.freeze({
          ...viewport,
          visual: Object.freeze({ ...visual }),
        }),
      });
    }
    function captureCompositorGeometry() {
      if (
        document.visibilityState !== "visible"
        || !display.isConnected
        || globalThis.visualViewport === null
        || globalThis.visualViewport === undefined
      ) {
        throw new Error("compositor capture requires a visible connected canvas");
      }
      const rect = display.getBoundingClientRect();
      const visualViewport = globalThis.visualViewport;
      const canvas = {
        bufferWidth: Number(display.width),
        bufferHeight: Number(display.height),
        left: Number(rect.left),
        top: Number(rect.top),
        right: Number(rect.right),
        bottom: Number(rect.bottom),
        width: Number(rect.width),
        height: Number(rect.height),
      };
      const viewport = {
        width: Number(globalThis.innerWidth),
        height: Number(globalThis.innerHeight),
        devicePixelRatio: Number(globalThis.devicePixelRatio),
        scrollX: Number(globalThis.scrollX),
        scrollY: Number(globalThis.scrollY),
      };
      const visual = {
        offsetLeft: Number(visualViewport.offsetLeft),
        offsetTop: Number(visualViewport.offsetTop),
        pageLeft: Number(visualViewport.pageLeft),
        pageTop: Number(visualViewport.pageTop),
        width: Number(visualViewport.width),
        height: Number(visualViewport.height),
        scale: Number(visualViewport.scale),
      };
      const finite = [
        ...Object.values(canvas),
        ...Object.values(viewport),
        ...Object.values(visual),
      ].every(Number.isFinite);
      if (
        !finite
        || !Number.isSafeInteger(canvas.bufferWidth)
        || !Number.isSafeInteger(canvas.bufferHeight)
        || canvas.bufferWidth <= 0
        || canvas.bufferHeight <= 0
        || !Number.isSafeInteger(canvas.width)
        || !Number.isSafeInteger(canvas.height)
        || canvas.width !== canvas.bufferWidth
        || canvas.height !== canvas.bufferHeight
        || canvas.width <= 0
        || canvas.height <= 0
        || viewport.width <= 0
        || viewport.height <= 0
        || viewport.devicePixelRatio <= 0
        || visual.width <= 0
        || visual.height <= 0
        || visual.scale <= 0
      ) {
        throw new Error("compositor capture geometry is invalid");
      }
      return freezeCompositorGeometry(canvas, viewport, visual);
    }
    function compositorGeometryEqual(left, right) {
      return JSON.stringify(left) === JSON.stringify(right);
    }
    function compositorCaptureProvenance(capture) {
      const surface = capture?.presentedSurface;
      const presentation = capture?.presentation;
      const rendererSequence = Number(capture?.rendererSequence);
      const presentationSerial = Number(surface?.presentationSerial);
      const pairEpoch = Number(surface?.pairEpoch);
      const ordinal = Number(capture?.ordinal);
      const width = Number(surface?.width);
      const height = Number(surface?.height);
      if (
        capture?.scenario !== "smb-ready-play"
        || capture?.step !== "post-play-presented"
        || presentation?.selected !== true
        || presentation?.status !== "vi-interlaced-frame-ready"
        || presentation?.presentationMode !== "interlaced"
        || presentation?.compositionPolicy !== "field-pair-weave"
        || surface?.presentationMode !== presentation.presentationMode
        || surface?.compositionPolicy !== presentation.compositionPolicy
        || pairEpoch !== Number(presentation?.pairEpoch)
        || presentationSerial !== Number(presentation?.presentationSerial)
        || width !== Number(presentation?.width)
        || height !== Number(presentation?.height)
        || !Number.isSafeInteger(ordinal)
        || ordinal < 1
        || ordinal > temporalSelectedXfbCapacity
        || !Number.isSafeInteger(rendererSequence)
        || rendererSequence < 1
        || !Number.isSafeInteger(presentationSerial)
        || presentationSerial < 1
        || !Number.isSafeInteger(pairEpoch)
        || pairEpoch < 1
        || pairEpoch > 0xffff_ffff
        || !Number.isSafeInteger(width)
        || width <= 0
        || width > 1024
        || !Number.isSafeInteger(height)
        || height <= 0
        || height > 1024
      ) {
        throw new Error("compositor capture provenance is invalid");
      }
      try {
        for (const parity of ["top", "bottom"]) {
          if (!presentedFieldMatchesExpected(
            surface.fields?.[parity],
            presentation.fields?.[parity]
          )) {
            throw new Error("mismatch");
          }
        }
      } catch (_error) {
        throw new Error("compositor capture provenance is invalid");
      }
      return {
        scenario: capture.scenario,
        step: capture.step,
        ordinal,
        rendererSequence,
        presentationSerial,
        pairEpoch,
        presentationMode: surface.presentationMode,
        completionField: presentation.completionField,
        compositionPolicy: surface.compositionPolicy,
        fields: {
          top: { ...presentation.fields.top },
          bottom: { ...presentation.fields.bottom },
        },
        width,
        height,
      };
    }
    function finishCompositorCapture(active, error = null) {
      if (active.settled) return false;
      active.settled = true;
      clearTimeout(active.timeoutId);
      if (active.animationFrameId !== null) {
        cancelAnimationFrame(active.animationFrameId);
        active.animationFrameId = null;
      }
      if (activeCompositorCapture === active) activeCompositorCapture = null;
      if (error === null) active.resolve(active.descriptor);
      else active.reject(error);
      return true;
    }
    function failCompositorCapture(message) {
      const error = message instanceof Error ? message : new Error(String(message));
      acknowledgedCompositorCaptureToken = null;
      if (activeCompositorCapture !== null) {
        finishCompositorCapture(activeCompositorCapture, error);
      }
      return error;
    }
    function resetCompositorCaptureForWorker(replacingWorker) {
      compositorCaptureWorkerEpoch += 1;
      compositorCaptureSequence = 0;
      acknowledgedCompositorCaptureToken = null;
      if (activeCompositorCapture !== null) {
        finishCompositorCapture(
          activeCompositorCapture,
          new Error(replacingWorker
            ? "compositor capture cancelled by worker replacement"
            : "compositor capture cancelled by worker reset")
        );
      }
    }
    function buildCompositorCaptureDescriptor(provenance, geometry) {
      compositorCaptureSequence += 1;
      const token = [
        "lazuli-compositor-v3",
        compositorCaptureWorkerEpoch,
        compositorCaptureSequence,
        provenance.rendererSequence,
        provenance.presentationSerial,
        crypto.randomUUID(),
      ].join(":");
      return Object.freeze({
        protocol: "lazuli-compositor-capture-v3",
        token,
        ...provenance,
        geometry,
      });
    }
    function waitForCompositorCapture(capture, sourceWorker) {
      if (!compositorCaptureEnabled) return Promise.resolve(null);
      if (activeCompositorCapture !== null) {
        const error = failCompositorCapture("duplicate compositor capture request");
        return Promise.reject(error);
      }
      const provenance = compositorCaptureProvenance(capture);
      acknowledgedCompositorCaptureToken = null;
      return new Promise((resolve, reject) => {
        const active = {
          acknowledged: false,
          animationFrameId: null,
          descriptor: null,
          firstGeometry: null,
          reject,
          resolve,
          settled: false,
          sourceWorker,
          timeoutId: null,
          workerEpoch: compositorCaptureWorkerEpoch,
        };
        activeCompositorCapture = active;
        const ensureCurrent = () => {
          if (
            activeCompositorCapture !== active
            || active.workerEpoch !== compositorCaptureWorkerEpoch
            || worker !== sourceWorker
          ) {
            throw new Error("compositor capture worker was replaced");
          }
          if (document.visibilityState !== "visible") {
            throw new Error("compositor capture document became hidden");
          }
        };
        const fail = error => {
          acknowledgedCompositorCaptureToken = null;
          finishCompositorCapture(active, error);
        };
        active.timeoutId = setTimeout(() => {
          fail(new Error("compositor capture acknowledgement timed out"));
        }, compositorCaptureTimeoutMs);
        active.animationFrameId = requestAnimationFrame(() => {
          active.animationFrameId = null;
          try {
            ensureCurrent();
            active.firstGeometry = captureCompositorGeometry();
          } catch (error) {
            fail(error);
            return;
          }
          active.animationFrameId = requestAnimationFrame(() => {
            active.animationFrameId = null;
            try {
              ensureCurrent();
              const geometry = captureCompositorGeometry();
              if (!compositorGeometryEqual(active.firstGeometry, geometry)) {
                throw new Error("compositor capture geometry changed between animation frames");
              }
              active.descriptor = buildCompositorCaptureDescriptor(provenance, geometry);
            } catch (error) {
              fail(error);
            }
          });
        });
      });
    }
    function pendingCompositorCapture() {
      return activeCompositorCapture?.descriptor ?? null;
    }
    function acknowledgeCompositorCapture(token) {
      if (!compositorCaptureEnabled) {
        throw new Error("compositor capture is not enabled");
      }
      const active = activeCompositorCapture;
      if (active === null) {
        if (
          typeof token === "string"
          && acknowledgedCompositorCaptureToken !== null
          && token === acknowledgedCompositorCaptureToken
        ) return true;
        throw new Error("no compositor capture is pending");
      }
      if (
        document.visibilityState !== "visible"
        || active.descriptor === null
        || typeof token !== "string"
        || token !== active.descriptor.token
      ) {
        const error = failCompositorCapture("invalid compositor capture acknowledgement");
        throw error;
      }
      if (active.acknowledged) return true;
      active.acknowledged = true;
      acknowledgedCompositorCaptureToken = token;
      finishCompositorCapture(active);
      return true;
    }
    if (compositorCaptureEnabled) {
      document.body.dataset.compositorCapture = "enabled";
      Object.defineProperty(globalThis, "lazuliCompositorCapture", {
        configurable: false,
        enumerable: true,
        value: Object.freeze({
          acknowledge: acknowledgeCompositorCapture,
          pending: pendingCompositorCapture,
        }),
        writable: false,
      });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") {
          failCompositorCapture("compositor capture document became hidden");
        }
      });
    }
    function resetRendererHostMetrics() {
      rendererHostMetrics = newRendererHostMetrics();
      rendererWorkerStartedAt = performance.now();
      temporalSelectedXfbFrames = [];
      lastPresentedViProjection = null;
    }
    let rendererOperationTail = Promise.resolve();
    function appendRendererOperation(operation) {
      const pending = rendererOperationTail.then(operation, operation);
      rendererOperationTail = pending.then(
        () => undefined,
        () => undefined
      );
      return pending;
    }
    function enqueueRendererOperation(operation) {
      const metrics = rendererHostMetrics.operations;
      const phases = rendererHostMetrics.wall?.phases ?? null;
      const queuedAt = phases === null
        ? null
        : beginRendererPhaseTiming(phases.operationTotal);
      if (phases !== null) {
        phases.operationQueueWait.eligibleCalls += 1;
        phases.operationDispatch.eligibleCalls += 1;
      }
      metrics.enqueued += 1;
      metrics.pending += 1;
      metrics.highWater = Math.max(metrics.highWater, metrics.pending);
      const measuredOperation = phases === null
        ? operation
        : () => {
            const dispatchStartedAt = queuedAt === null ? null : performance.now();
            recordRendererPhaseTiming(
              phases.operationQueueWait,
              queuedAt,
              dispatchStartedAt
            );
            try {
              return operation(phases);
            } finally {
              recordRendererPhaseTiming(phases.operationDispatch, dispatchStartedAt);
            }
          };
      const pending = appendRendererOperation(measuredOperation);
      const settle = () => {
        metrics.pending -= 1;
        if (phases !== null) {
          recordRendererPhaseTiming(phases.operationTotal, queuedAt);
        }
      };
      pending.then(
        settle,
        settle
      );
      return pending;
    }
    async function sha256Hex(bytes) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    }
    function presentedXfbRgbBytes(rgba, width, height) {
      if (
        !(rgba instanceof Uint8Array)
        || !Number.isSafeInteger(width)
        || !Number.isSafeInteger(height)
        || width <= 0
        || height <= 0
        || rgba.byteLength !== width * height * 4
      ) {
        throw new Error("WebGPU XFB readback has an invalid tight RGBA8 layout");
      }
      const rgb = new Uint8Array(width * height * 3);
      for (let source = 0, destination = 0; source < rgba.byteLength; source += 4) {
        rgb[destination++] = rgba[source];
        rgb[destination++] = rgba[source + 1];
        rgb[destination++] = rgba[source + 2];
      }
      return rgb;
    }
    function summarizePresentedXfbRgba(rgba, width, height) {
      if (
        !(rgba instanceof Uint8Array)
        || !Number.isSafeInteger(width)
        || !Number.isSafeInteger(height)
        || width <= 0
        || height <= 0
        || rgba.byteLength !== width * height * 4
      ) {
        throw new Error("WebGPU XFB readback has an invalid tight RGBA8 layout");
      }
      let black = 0;
      let white = 0;
      const colors = new Set();
      for (let offset = 0; offset < rgba.byteLength; offset += 4) {
        const red = rgba[offset];
        const green = rgba[offset + 1];
        const blue = rgba[offset + 2];
        colors.add((red << 16) | (green << 8) | blue);
        if (red === 0 && green === 0 && blue === 0) black += 1;
        else if (red === 255 && green === 255 && blue === 255) white += 1;
      }
      return {
        black,
        white,
        other: width * height - black - white,
        unique: colors.size,
      };
    }
    function viScanoutProvenance(value) {
      const scanoutPolicy = String(value?.scanoutPolicy);
      const fieldStrideBytes = Number(value?.fieldStrideBytes);
      const sourceRowStep = Number(value?.sourceRowStep);
      const fieldHeight = Number(value?.fieldHeight);
      const rowRepeat = Number(value?.rowRepeat);
      const displayHeight = Number(value?.displayHeight ?? value?.height);
      const selectedRow = Number(value?.row ?? value?.copyRow);
      const logicalHeight = value?.logicalHeight === undefined
        ? null
        : Number(value.logicalHeight);
      if (
        (scanoutPolicy !== "bob" && scanoutPolicy !== "direct")
        || !Number.isSafeInteger(fieldStrideBytes)
        || fieldStrideBytes <= 0
        || !Number.isSafeInteger(sourceRowStep)
        || sourceRowStep <= 0
        || !Number.isSafeInteger(fieldHeight)
        || fieldHeight <= 0
        || (rowRepeat !== 1 && rowRepeat !== 2)
        || scanoutPolicy !== (rowRepeat === 2 ? "bob" : "direct")
        || !Number.isSafeInteger(displayHeight)
        || displayHeight !== fieldHeight * rowRepeat
        || !Number.isSafeInteger(selectedRow)
        || selectedRow < 0
        || (logicalHeight !== null && (
          !Number.isSafeInteger(logicalHeight)
          || logicalHeight <= 0
          || selectedRow + (fieldHeight - 1) * sourceRowStep >= logicalHeight
        ))
      ) {
        throw new Error("WebGPU VI scanout provenance is invalid");
      }
      return {
        scanoutPolicy,
        fieldStrideBytes,
        sourceRowStep,
        fieldHeight,
        rowRepeat,
      };
    }
    function viScanoutProvenanceEqual(left, right) {
      return [
        "scanoutPolicy",
        "fieldStrideBytes",
        "sourceRowStep",
        "fieldHeight",
        "rowRepeat",
      ].every(name => left?.[name] === right?.[name]);
    }
    function readPresentedFieldProvenance(value) {
      const address = Number(value?.address);
      const generation = Number(value?.generation);
      const row = Number(value?.row);
      const sourceRow = Number(value?.sourceRow);
      const textureWidth = Number(value?.textureWidth);
      const textureHeight = Number(value?.textureHeight);
      const logicalWidth = Number(value?.logicalWidth);
      const logicalHeight = Number(value?.logicalHeight);
      const surfaceId = Number(value?.surfaceId);
      if (
        value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || !Number.isSafeInteger(address)
        || address < 0
        || address > 0xffff_ffff
        || !Number.isSafeInteger(generation)
        || generation < 1
        || !Number.isSafeInteger(row)
        || row < 0
        || row > 1
        || !Number.isSafeInteger(sourceRow)
        || sourceRow < 0
        || !Number.isSafeInteger(textureWidth)
        || textureWidth <= 0
        || !Number.isSafeInteger(textureHeight)
        || textureHeight <= 0
        || !Number.isSafeInteger(logicalWidth)
        || logicalWidth <= 0
        || !Number.isSafeInteger(logicalHeight)
        || logicalHeight <= 0
        || !Number.isSafeInteger(surfaceId)
        || surfaceId < 1
      ) {
        throw new Error("WebGPU presented field provenance is invalid");
      }
      const scanout = viScanoutProvenance(value);
      return {
        address: "0x" + address.toString(16).padStart(8, "0"),
        generation,
        row,
        sourceRow,
        surfaceId,
        textureWidth,
        textureHeight,
        logicalWidth,
        logicalHeight,
        ...scanout,
      };
    }
    function readPresentedFrameProvenance(capture) {
      const pairEpoch = Number(capture?.pairEpoch);
      const presentationMode = String(capture?.presentationMode);
      const displayWidth = Number(capture?.displayWidth);
      const displayHeight = Number(capture?.displayHeight);
      const compositionPolicy = String(capture?.scanoutPolicy);
      const rawFields = capture?.fields;
      if (
        !Number.isSafeInteger(pairEpoch)
        || pairEpoch < 1
        || pairEpoch > 0xffff_ffff
        || ![
          "progressive",
          "single-field",
          "interlaced",
        ].includes(presentationMode)
        || !Number.isSafeInteger(displayWidth)
        || displayWidth <= 0
        || !Number.isSafeInteger(displayHeight)
        || displayHeight <= 0
        || compositionPolicy !== (
          presentationMode === "interlaced" ? "weave" : "direct"
        )
        || rawFields === null
        || typeof rawFields !== "object"
        || Array.isArray(rawFields)
      ) {
        throw new Error("WebGPU presented frame provenance is invalid");
      }
      const fields = {};
      for (const parity of ["top", "bottom"]) {
        if (rawFields[parity] !== undefined) {
          fields[parity] = readPresentedFieldProvenance(rawFields[parity]);
        }
      }
      const fieldNames = Object.keys(fields);
      if (
        (
          presentationMode === "interlaced"
          && (
            fieldNames.length !== 2
            || fields.top === undefined
            || fields.bottom === undefined
          )
        )
        || (
          presentationMode !== "interlaced"
          && fieldNames.length !== 1
        )
        || fieldNames.some(parity =>
          fields[parity].logicalWidth !== displayWidth
          || fields[parity].rowRepeat !== (
            presentationMode === "interlaced" ? 2 : 1
          )
          || fields[parity].fieldHeight * fields[parity].rowRepeat
            !== displayHeight
        )
      ) {
        throw new Error("WebGPU presented frame fields are invalid");
      }
      return {
        pairEpoch,
        presentationMode,
        compositionPolicy: presentationMode === "interlaced"
          ? "field-pair-weave"
          : "direct",
        displayWidth,
        displayHeight,
        fields,
      };
    }
    function presentedFieldRows(rgba, width, height, parity) {
      const rowParity = parity === "top" ? 0 : parity === "bottom" ? 1 : -1;
      if (
        rowParity < 0
        || !(rgba instanceof Uint8Array)
        || !Number.isSafeInteger(width)
        || width <= 0
        || !Number.isSafeInteger(height)
        || height <= 0
        || rgba.byteLength !== width * height * 4
      ) {
        throw new Error("WebGPU paired field rows are invalid");
      }
      const fieldHeight = Math.floor((height + 1 - rowParity) / 2);
      const rowBytes = width * 4;
      const rows = new Uint8Array(rowBytes * fieldHeight);
      for (
        let sourceRow = rowParity, destinationRow = 0;
        sourceRow < height;
        sourceRow += 2, destinationRow += 1
      ) {
        rows.set(
          rgba.subarray(sourceRow * rowBytes, (sourceRow + 1) * rowBytes),
          destinationRow * rowBytes
        );
      }
      return { width, height: fieldHeight, rgba: rows };
    }
    async function summarizePresentedFieldRows(rgba, width, height, parity) {
      const field = presentedFieldRows(rgba, width, height, parity);
      const [rgbaSha256, rgbSha256] = await Promise.all([
        sha256Hex(field.rgba),
        sha256Hex(presentedXfbRgbBytes(field.rgba, field.width, field.height)),
      ]);
      return {
        width: field.width,
        height: field.height,
        rgbaByteLength: field.rgba.byteLength,
        rgbaSha256,
        rgbSha256,
        rgb: summarizePresentedXfbRgba(field.rgba, field.width, field.height),
      };
    }
    async function attachPresentedFieldEvidence(provenance, rgba, width, height) {
      const fields = {};
      for (const parity of Object.keys(provenance.fields)) {
        const evidence = provenance.presentationMode === "interlaced"
          ? await summarizePresentedFieldRows(rgba, width, height, parity)
          : {
            width,
            height,
            rgbaByteLength: rgba.byteLength,
            rgbaSha256: await sha256Hex(rgba),
            rgbSha256: await sha256Hex(presentedXfbRgbBytes(rgba, width, height)),
            rgb: summarizePresentedXfbRgba(rgba, width, height),
          };
        fields[parity] = { ...provenance.fields[parity], ...evidence };
      }
      return { ...provenance, fields };
    }
    function legacyPresentedXfbProjection(provenance) {
      const preferredParity = lastPresentedViProjection?.pairEpoch
        === provenance.pairEpoch
        ? lastPresentedViProjection.field
        : provenance.fields.bottom === undefined ? "top" : "bottom";
      const field = provenance.fields[preferredParity];
      if (field === undefined) {
        throw new Error("WebGPU presented frame has no compatibility field");
      }
      return {
        address: field.address,
        generation: field.generation,
        row: field.row,
        sourceRow: field.sourceRow,
        textureWidth: field.textureWidth,
        textureHeight: field.textureHeight,
        logicalWidth: field.logicalWidth,
        logicalHeight: field.logicalHeight,
        scanoutPolicy: field.scanoutPolicy,
        fieldStrideBytes: field.fieldStrideBytes,
        sourceRowStep: field.sourceRowStep,
        fieldHeight: field.fieldHeight,
        rowRepeat: field.rowRepeat,
      };
    }
    async function readSelectedXfb(includePresentationSerial = false) {
      if (!webGpuRenderer.has_presented_xfb()) return null;
      const capture = await webGpuRenderer.read_presented_xfb_rgba();
      const rgba = capture.rgba instanceof Uint8Array
        ? capture.rgba
        : new Uint8Array(capture.rgba);
      const width = Number(capture.width);
      const height = Number(capture.height);
      const provenance = await attachPresentedFieldEvidence(
        readPresentedFrameProvenance(capture),
        rgba,
        width,
        height
      );
      if (
        width !== provenance.displayWidth
        || height !== provenance.displayHeight
      ) {
        throw new Error("selected WebGPU XFB dimensions do not match provenance");
      }
      const rgb = summarizePresentedXfbRgba(rgba, width, height);
      const [rgbaSha256, rgbSha256] = await Promise.all([
        sha256Hex(rgba),
        sha256Hex(presentedXfbRgbBytes(rgba, width, height)),
      ]);
      const result = {
        ...provenance,
        ...legacyPresentedXfbProjection(provenance),
        format: String(capture.format),
        layout: String(capture.layout),
        width,
        height,
        rgbaByteLength: rgba.byteLength,
        rgbaSha256,
        rgbSha256,
        rgb,
      };
      if (includePresentationSerial) {
        const presentationSerial = Number(capture.presentationSerial);
        if (!Number.isSafeInteger(presentationSerial) || presentationSerial < 1) {
          throw new Error("selected WebGPU XFB presentation serial is invalid");
        }
        result.presentationSerial = presentationSerial;
      }
      return result;
    }
    async function readPresentedSurface() {
      if (!webGpuRenderer.has_presented_surface()) return null;
      const capture = await webGpuRenderer.read_presented_surface_rgba();
      const rgba = capture.rgba instanceof Uint8Array
        ? capture.rgba
        : new Uint8Array(capture.rgba);
      const width = Number(capture.width);
      const height = Number(capture.height);
      const provenance = await attachPresentedFieldEvidence(
        readPresentedFrameProvenance(capture),
        rgba,
        width,
        height
      );
      if (
        width !== provenance.displayWidth
        || height !== provenance.displayHeight
      ) {
        throw new Error("WebGPU surface dimensions do not match provenance");
      }
      const surfaceFormat = String(capture.surfaceFormat);
      if (![
        "rgba8unorm",
        "rgba8unorm-srgb",
        "bgra8unorm",
        "bgra8unorm-srgb",
      ].includes(surfaceFormat)) {
        throw new Error(`WebGPU surface readback has unsupported format ${surfaceFormat}`);
      }
      const rgb = summarizePresentedXfbRgba(rgba, width, height);
      const [rgbaSha256, rgbSha256] = await Promise.all([
        sha256Hex(rgba),
        sha256Hex(presentedXfbRgbBytes(rgba, width, height)),
      ]);
      return {
        ...provenance,
        ...legacyPresentedXfbProjection(provenance),
        presentationSerial: Number(capture.presentationSerial),
        surfaceFormat,
        format: String(capture.format),
        layout: String(capture.layout),
        width,
        height,
        rgbaByteLength: rgba.byteLength,
        rgbaSha256,
        rgbSha256,
        rgb,
      };
    }
    function expectedViPairField(value) {
      const field = value?.field;
      const address = Number(value?.address);
      const copyIndex = Number(value?.copyIndex);
      const copyRow = Number(value?.copyRow);
      const width = Number(value?.width);
      const height = Number(value?.height);
      if (
        (field !== "top" && field !== "bottom")
        || !Number.isSafeInteger(address)
        || address < 0
        || address > 0xffff_ffff
        || !Number.isSafeInteger(copyIndex)
        || copyIndex < 1
        || !Number.isSafeInteger(copyRow)
        || copyRow < 0
        || copyRow > 1
        || !Number.isSafeInteger(width)
        || width <= 0
        || !Number.isSafeInteger(height)
        || height <= 0
      ) {
        throw new Error("worker VI pair field provenance is invalid");
      }
      return {
        field,
        address: "0x" + address.toString(16).padStart(8, "0"),
        copyIndex,
        copyRow,
        width,
        height,
        ...viScanoutProvenance({ ...value, row: copyRow }),
      };
    }
    function expectedViPairFields(frame) {
      const fields = {};
      const rawFields = frame?.pairFields;
      if (
        rawFields === null
        || typeof rawFields !== "object"
        || Array.isArray(rawFields)
      ) {
        throw new Error("worker VI pair provenance is unavailable");
      }
      for (const parity of ["top", "bottom"]) {
        if (rawFields[parity] !== undefined) {
          const field = expectedViPairField(rawFields[parity]);
          if (field.field !== parity) {
            throw new Error("worker VI pair parity is invalid");
          }
          fields[parity] = field;
        }
      }
      if (
        frame.presentationMode === "interlaced"
          ? fields.top === undefined || fields.bottom === undefined
          : Object.keys(fields).length !== 1
      ) {
        throw new Error("worker VI pair is incomplete");
      }
      return fields;
    }
    function presentedFieldMatchesExpected(actual, expected) {
      return actual?.address === expected?.address
        && actual?.generation === expected?.copyIndex
        && actual?.row === expected?.copyRow
        && viScanoutProvenanceEqual(actual, expected);
    }
    async function captureTemporalSelectedXfb(
      message,
      presentationResult,
      frames = temporalSelectedXfbFrames
    ) {
      const rendererSequence = Number(message.rendererSequence);
      const frame = message.frame;
      const request = frame?.temporalXfbCapture;
      const ordinal = Number(request?.ordinal);
      const capacity = Number(request?.capacity);
      const address = Number(frame?.address);
      const copyIndex = Number(frame?.copyIndex);
      const copyRow = Number(frame?.copyRow);
      const width = Number(frame?.width);
      const height = Number(frame?.height);
      if (
        message?.type !== "vi-present"
        || request?.scenario !== "smb-ready-play"
        || request?.step !== "post-play-presented"
        || presentationResult?.accepted !== true
        || presentationResult?.presented !== true
        || presentationResult?.status !== "vi-interlaced-frame-ready"
        || presentationResult?.pairEpoch !== Number(frame?.pairEpoch)
        || presentationResult?.presentationSerial === null
        || frame?.pairCompleting !== true
        || frame?.presentationMode !== "interlaced"
        || !Number.isSafeInteger(rendererSequence)
        || !Number.isSafeInteger(ordinal)
        || ordinal !== frames.length + 1
        || capacity !== temporalSelectedXfbCapacity
        || frames.length >= temporalSelectedXfbCapacity
        || (frame?.field !== "top" && frame?.field !== "bottom")
        || !Number.isSafeInteger(address)
        || address < 0
        || address > 0xffff_ffff
        || !Number.isSafeInteger(copyIndex)
        || copyIndex < 0
        || !Number.isSafeInteger(copyRow)
        || copyRow < 0
        || copyRow > 1
        || !Number.isSafeInteger(width)
        || width <= 0
        || width > 1024
        || !Number.isSafeInteger(height)
        || height <= 0
        || height > 1024
      ) {
        throw new Error("invalid temporal selected-XFB capture request");
      }
      const pictureConfiguration = Number(frame.pictureConfiguration);
      const wordsPerLine = Number(frame.wordsPerLine);
      const standardWordsPerLine = Number(frame.standardWordsPerLine);
      const activeLines = Number(frame.activeLines);
      const nonInterlaced = frame.nonInterlaced;
      if (
        !Number.isSafeInteger(pictureConfiguration)
        || pictureConfiguration < 0
        || pictureConfiguration > 0xffff
        || wordsPerLine !== ((pictureConfiguration >>> 8) & 0x7f)
        || standardWordsPerLine !== (pictureConfiguration & 0xff)
        || activeLines !== Number(frame.fieldHeight)
        || nonInterlaced !== (Number(frame.rowRepeat) === 1)
        || width !== wordsPerLine * 16
        || Number(frame.fieldStrideBytes) !== standardWordsPerLine * 32
      ) {
        throw new Error("invalid temporal VI raw scanout geometry");
      }
      const scanout = viScanoutProvenance({ ...frame, row: copyRow });
      const expectedFields = expectedViPairFields(frame);
      const [selectedXfb, presentedSurface] = await Promise.all([
        readSelectedXfb(true),
        readPresentedSurface(),
      ]);
      if (presentedSurface === null) {
        throw new Error("requested WebGPU presented-surface capture is unavailable");
      }
      const presentationAddress = "0x" + address.toString(16).padStart(8, "0");
      if (
        selectedXfb === null
        || selectedXfb.presentationSerial !== presentedSurface.presentationSerial
        || selectedXfb.presentationSerial !== presentationResult.presentationSerial
        || selectedXfb.pairEpoch !== presentationResult.pairEpoch
        || selectedXfb.pairEpoch !== presentedSurface.pairEpoch
        || selectedXfb.presentationMode !== frame.presentationMode
        || selectedXfb.presentationMode !== presentedSurface.presentationMode
        || selectedXfb.compositionPolicy !== presentedSurface.compositionPolicy
        || selectedXfb.displayWidth !== width
        || selectedXfb.displayHeight !== height
        || presentedSurface.displayWidth !== width
        || presentedSurface.displayHeight !== height
        || !["top", "bottom"].every(parity =>
          presentedFieldMatchesExpected(
            selectedXfb.fields?.[parity],
            expectedFields[parity]
          )
          && presentedFieldMatchesExpected(
            presentedSurface.fields?.[parity],
            expectedFields[parity]
          )
          && selectedXfb.fields?.[parity]?.rgbaSha256
            === presentedSurface.fields?.[parity]?.rgbaSha256
          && selectedXfb.fields?.[parity]?.rgbSha256
            === presentedSurface.fields?.[parity]?.rgbSha256
        )
      ) {
        throw new Error("captured WebGPU presentation identity does not match");
      }
      const capture = {
        scenario: request.scenario,
        step: request.step,
        ordinal,
        rendererSequence,
        presentation: {
          selected: presentationResult.presented,
          status: presentationResult.status,
          presentationMode: frame.presentationMode,
          pairEpoch: presentationResult.pairEpoch,
          presentationSerial: presentationResult.presentationSerial,
          completionField: frame.field,
          compositionPolicy: selectedXfb.compositionPolicy,
          fields: expectedFields,
          field: frame.field,
          address: presentationAddress,
          copyIndex,
          copyRow,
          width,
          height,
          pictureConfiguration,
          wordsPerLine,
          standardWordsPerLine,
          activeLines,
          nonInterlaced,
          ...scanout,
        },
        selectedXfb,
        presentedSurface,
      };
      frames.push(capture);
      return capture;
    }
    function captureSmbSustainedViReceipt(message, presentationResult) {
      const frame = message?.frame;
      const request = frame?.sustainedPlayReceipt;
      const rendererSequence = Number(message?.rendererSequence);
      const ordinal = Number(request?.ordinal);
      const capacity = Number(request?.capacity);
      const address = Number(frame?.address);
      const copyIndex = Number(frame?.copyIndex);
      const copyRow = Number(frame?.copyRow);
      const width = Number(frame?.width);
      const height = Number(frame?.height);
      const gameplay = request?.gameplay;
      if (
        message?.type !== "vi-present"
        || request?.scenario !== "smb-sustained-play"
        || request?.step !== "sustained-play-presented"
        || !Number.isSafeInteger(rendererSequence)
        || !Number.isSafeInteger(ordinal)
        || ordinal < 1
        || ordinal > 120
        || capacity !== 120
        || presentationResult === null
        || typeof presentationResult !== "object"
        || Array.isArray(presentationResult)
        || typeof presentationResult.accepted !== "boolean"
        || typeof presentationResult.presented !== "boolean"
        || typeof presentationResult.status !== "string"
        || presentationResult.pairEpoch !== Number(frame?.pairEpoch)
        || (
          presentationResult.presentationSerial !== null
          && !Number.isSafeInteger(presentationResult.presentationSerial)
        )
        || (frame?.field !== "top" && frame?.field !== "bottom")
        || !Number.isSafeInteger(address)
        || address < 0
        || address > 0xffff_ffff
        || !Number.isSafeInteger(copyIndex)
        || copyIndex < 0
        || !Number.isSafeInteger(copyRow)
        || copyRow < 0
        || copyRow > 1
        || !Number.isSafeInteger(width)
        || width <= 0
        || !Number.isSafeInteger(height)
        || height <= 0
        || gameplay === null
        || typeof gameplay !== "object"
        || Array.isArray(gameplay)
      ) {
        throw new Error("invalid sustained PLAY VI receipt request");
      }
      const gameplaySnapshot = {};
      for (const field of [
        "gameModeRequest",
        "gameMode",
        "gameSubmodeRequest",
        "gameSubmode",
        "infoTimer",
        "attempts",
        "floor",
      ]) {
        if (!Number.isSafeInteger(gameplay[field])) {
          throw new Error(`invalid sustained PLAY gameplay field ${field}`);
        }
        gameplaySnapshot[field] = gameplay[field];
      }
      return {
        scenario: request.scenario,
        step: request.step,
        ordinal,
        capacity,
        rendererSequence,
        drained: true,
        accepted: presentationResult.accepted,
        presented: presentationResult.presented,
        status: presentationResult.status,
        pairEpoch: presentationResult.pairEpoch,
        presentationSerial: presentationResult.presentationSerial,
        presentation: {
          mode: frame.presentationMode,
          pairCompleting: frame.pairCompleting,
          field: frame.field,
          address: "0x" + address.toString(16).padStart(8, "0"),
          copyIndex,
          copyRow,
          width,
          height,
        },
        gameplay: gameplaySnapshot,
      };
    }
    function temporalPairedEvidenceMatches(evidence, presentation) {
      return evidence !== null
        && evidence.pairEpoch === presentation.pairEpoch
        && evidence.presentationMode === presentation.presentationMode
        && evidence.compositionPolicy === presentation.compositionPolicy
        && evidence.displayWidth === presentation.width
        && evidence.displayHeight === presentation.height
        && ["top", "bottom"].every(parity =>
          presentedFieldMatchesExpected(
            evidence.fields?.[parity],
            presentation.fields?.[parity]
          )
        );
    }
    function temporalPairedFieldSummary(evidence, parity) {
      const field = evidence?.fields?.[parity] ?? null;
      const pixels = field === null ? 0 : field.width * field.height;
      return {
        address: field?.address ?? null,
        generation: field?.generation ?? null,
        rgbaSha256: field?.rgbaSha256 ?? null,
        rgbSha256: field?.rgbSha256 ?? null,
        monochrome: field !== null && field.rgb.unique === 1,
        allBlack: field !== null && field.rgb.black === pixels,
        allWhite: field !== null && field.rgb.white === pixels,
      };
    }
    function summarizeTemporalSelectedXfb(frames) {
      const classified = frames.map(frame => {
        const selected = frame.selectedXfb;
        const pixels = selected === null ? 0 : selected.width * selected.height;
        const matchesPresentation = temporalPairedEvidenceMatches(
          selected,
          frame.presentation
        );
        const top = temporalPairedFieldSummary(selected, "top");
        const bottom = temporalPairedFieldSummary(selected, "bottom");
        const completion = selected?.fields?.[frame.presentation.completionField] ?? null;
        return {
          ordinal: frame.ordinal,
          rendererSequence: frame.rendererSequence,
          pairEpoch: frame.presentation.pairEpoch,
          copyIndex: frame.presentation.copyIndex,
          generation: completion?.generation ?? null,
          rgbaSha256: selected?.rgbaSha256 ?? null,
          rgbSha256: selected?.rgbSha256 ?? null,
          selected: frame.presentation.selected && selected !== null,
          matchesPresentation,
          monochrome: selected !== null && selected.rgb.unique === 1,
          allBlack: selected !== null && selected.rgb.black === pixels,
          allWhite: selected !== null && selected.rgb.white === pixels,
          sourceBlackWhiteSplit:
            (top.allBlack && bottom.allWhite)
            || (top.allWhite && bottom.allBlack),
          fields: { top, bottom },
        };
      });
      const rgbaHashes = classified
        .map(frame => frame.rgbaSha256)
        .filter(hash => hash !== null);
      const rgbHashes = classified
        .map(frame => frame.rgbSha256)
        .filter(hash => hash !== null);
      const monochrome = classified.filter(frame => frame.monochrome);
      const blackWhite = classified.filter(frame => frame.allBlack || frame.allWhite);
      const adjacentFramesAlternate = (candidates, key) => candidates.length >= 2
        && candidates.every((frame, index) => index === 0
          || frame[key] !== candidates[index - 1][key]);
      const blackAndWhiteAlternate = candidates => candidates.length >= 2
        && candidates.every((frame, index) => index === 0
          || frame.allBlack !== candidates[index - 1].allBlack);
      return {
        captured: classified.length,
        capacity: temporalSelectedXfbCapacity,
        complete: classified.length === temporalSelectedXfbCapacity,
        distinctRgbaHashes: new Set(rgbaHashes).size,
        distinctRgbHashes: new Set(rgbHashes).size,
        distinctPairEpochs: new Set(classified.map(frame => frame.pairEpoch)).size,
        distinctGenerations: new Set(classified
          .map(frame => frame.generation)
          .filter(generation => generation !== null)).size,
        distinctCopyIndices: new Set(classified.map(frame => frame.copyIndex)).size,
        missingOrUnselectedOrdinals: classified
          .filter(frame => !frame.selected)
          .map(frame => frame.ordinal),
        mismatchedPresentationOrdinals: classified
          .filter(frame => frame.selected && !frame.matchesPresentation)
          .map(frame => frame.ordinal),
        generationRegressions: classified
          .filter((frame, index) => index !== 0
            && frame.generation !== null
            && classified[index - 1].generation !== null
            && frame.generation < classified[index - 1].generation)
          .map(frame => frame.ordinal),
        copyIndexRegressions: classified
          .filter((frame, index) => index !== 0
            && frame.copyIndex < classified[index - 1].copyIndex)
          .map(frame => frame.ordinal),
        monochromeOrdinals: monochrome.map(frame => frame.ordinal),
        blackOrdinals: classified.filter(frame => frame.allBlack).map(frame => frame.ordinal),
        whiteOrdinals: classified.filter(frame => frame.allWhite).map(frame => frame.ordinal),
        allFramesMonochrome: classified.length !== 0
          && monochrome.length === classified.length,
        alternatingMonochromePair: monochrome.length === classified.length
          && new Set(rgbHashes).size === 2
          && adjacentFramesAlternate(classified, "rgbSha256"),
        blackWhiteAlternating: blackWhite.length === classified.length
          && blackAndWhiteAlternate(classified),
        sourceBlackWhiteSplitOrdinals: classified
          .filter(frame => frame.sourceBlackWhiteSplit)
          .map(frame => frame.ordinal),
        frames: classified,
      };
    }
    function summarizeTemporalPresentedSurfaces(frames) {
      const classified = frames.map(frame => {
        const surface = frame.presentedSurface;
        const pixels = surface === null ? 0 : surface.width * surface.height;
        const matchesPresentation = temporalPairedEvidenceMatches(
          surface,
          frame.presentation
        );
        const top = temporalPairedFieldSummary(surface, "top");
        const bottom = temporalPairedFieldSummary(surface, "bottom");
        const completion = surface?.fields?.[frame.presentation.completionField] ?? null;
        return {
          ordinal: frame.ordinal,
          rendererSequence: frame.rendererSequence,
          pairEpoch: frame.presentation.pairEpoch,
          presentationSerial: surface?.presentationSerial ?? null,
          copyIndex: frame.presentation.copyIndex,
          generation: completion?.generation ?? null,
          rgbaSha256: surface?.rgbaSha256 ?? null,
          rgbSha256: surface?.rgbSha256 ?? null,
          captured: surface !== null,
          matchesPresentation,
          monochrome: surface !== null && surface.rgb.unique === 1,
          allBlack: surface !== null && surface.rgb.black === pixels,
          allWhite: surface !== null && surface.rgb.white === pixels,
          sourceBlackWhiteSplit:
            (top.allBlack && bottom.allWhite)
            || (top.allWhite && bottom.allBlack),
          fields: { top, bottom },
        };
      });
      const rgbaHashes = classified
        .map(frame => frame.rgbaSha256)
        .filter(hash => hash !== null);
      const rgbHashes = classified
        .map(frame => frame.rgbSha256)
        .filter(hash => hash !== null);
      const monochrome = classified.filter(frame => frame.monochrome);
      const blackWhite = classified.filter(frame => frame.allBlack || frame.allWhite);
      const adjacentFramesAlternate = (candidates, key) => candidates.length >= 2
        && candidates.every((frame, index) => index === 0
          || frame[key] !== candidates[index - 1][key]);
      const blackAndWhiteAlternate = candidates => candidates.length >= 2
        && candidates.every((frame, index) => index === 0
          || frame.allBlack !== candidates[index - 1].allBlack);
      return {
        captured: classified.filter(frame => frame.captured).length,
        capacity: temporalSelectedXfbCapacity,
        complete: classified.length === temporalSelectedXfbCapacity
          && classified.every(frame => frame.captured),
        distinctRgbaHashes: new Set(rgbaHashes).size,
        distinctRgbHashes: new Set(rgbHashes).size,
        distinctPairEpochs: new Set(classified.map(frame => frame.pairEpoch)).size,
        distinctPresentationSerials: new Set(classified
          .map(frame => frame.presentationSerial)
          .filter(serial => serial !== null)).size,
        missingOrdinals: classified
          .filter(frame => !frame.captured)
          .map(frame => frame.ordinal),
        mismatchedPresentationOrdinals: classified
          .filter(frame => frame.captured && !frame.matchesPresentation)
          .map(frame => frame.ordinal),
        presentationSerialRegressions: classified
          .filter((frame, index) => index !== 0
            && frame.presentationSerial !== null
            && classified[index - 1].presentationSerial !== null
            && frame.presentationSerial <= classified[index - 1].presentationSerial)
          .map(frame => frame.ordinal),
        monochromeOrdinals: monochrome.map(frame => frame.ordinal),
        blackOrdinals: classified.filter(frame => frame.allBlack).map(frame => frame.ordinal),
        whiteOrdinals: classified.filter(frame => frame.allWhite).map(frame => frame.ordinal),
        allFramesMonochrome: classified.length !== 0
          && monochrome.length === classified.length,
        alternatingMonochromePair: monochrome.length === classified.length
          && new Set(rgbHashes).size === 2
          && adjacentFramesAlternate(classified, "rgbSha256"),
        blackWhiteAlternating: blackWhite.length === classified.length
          && blackAndWhiteAlternate(classified),
        sourceBlackWhiteSplitOrdinals: classified
          .filter(frame => frame.sourceBlackWhiteSplit)
          .map(frame => frame.ordinal),
        frames: classified,
      };
    }
    function captureSelectedXfb() {
      return appendRendererOperation(readSelectedXfb);
    }
    function snapshotRendererPerformance(hostMetrics = rendererHostMetrics) {
      const webgpu = webGpuRenderer.diagnostics();
      const webgpuPhases = webGpuRenderer.host_diagnostics();
      return {
        scope: "current-worker",
        wasmBridge: {
          calls: Number(webgpu.wasmBridgeCalls ?? 0),
          typedArrayBytes: Number(webgpu.wasmBridgeTypedArrayBytes ?? 0),
        },
        queue: {
          drains: Number(webgpu.drainCalls ?? 0),
          submits: Number(webgpu.queueSubmissions ?? 0),
        },
        resources: {
          bindGroups: Number(webgpu.bindGroupsCreated ?? 0),
          buffers: Number(webgpu.buffersCreated ?? 0),
          renderPipelines: Number(webgpu.renderPipelinesCreated ?? 0),
          textures: Number(webgpu.texturesCreated ?? 0),
        },
        operations: { ...hostMetrics.operations },
        workerMessages: { ...hostMetrics.workerMessages },
        workload: {
          expandedVertexBytes: Number(webgpu.expandedVertexBytes ?? 0),
          gxFramePacketBytes: Number(webgpu.gxFramePacketBytes ?? 0),
          gxFramePacketPayloadBytes: Number(webgpu.gxFramePacketPayloadBytes ?? 0),
          textureUploadBytes: Number(webgpu.textureUploadBytes ?? 0),
          textureWrites: Number(webgpu.textureWrites ?? 0),
        },
        wall: {
          workerStartToLastReportMs: hostMetrics.wall.workerStartToLastReportMs,
          phases: snapshotRendererWallPhases(hostMetrics.wall.phases, webgpuPhases),
        },
        webgpu,
      };
    }
    function captureRendererPerformance() {
      return appendRendererOperation(snapshotRendererPerformance);
    }
    function captureRendererTerminal(
      hostMetrics = rendererHostMetrics,
      temporalFrames = temporalSelectedXfbFrames
    ) {
      return appendRendererOperation(async () => {
        const metrics = snapshotRendererPerformance(hostMetrics);
        const selectedXfb = await readSelectedXfb();
        const temporalSelectedXfb = {
          scanoutEvidenceVersion: 3,
          capacity: temporalSelectedXfbCapacity,
          frames: temporalFrames.map(frame => ({
            ...frame,
            presentation: {
              ...frame.presentation,
              fields: Object.fromEntries(Object.entries(frame.presentation.fields)
                .map(([parity, field]) => [parity, { ...field }]))
            },
            selectedXfb: frame.selectedXfb === null
              ? null
              : {
                ...frame.selectedXfb,
                fields: Object.fromEntries(Object.entries(frame.selectedXfb.fields)
                  .map(([parity, field]) => [
                    parity,
                    { ...field, rgb: { ...field.rgb } },
                  ])),
                rgb: { ...frame.selectedXfb.rgb },
              },
            presentedSurface: frame.presentedSurface === null
              ? null
              : {
                ...frame.presentedSurface,
                fields: Object.fromEntries(Object.entries(frame.presentedSurface.fields)
                  .map(([parity, field]) => [
                    parity,
                    { ...field, rgb: { ...field.rgb } },
                  ])),
                rgb: { ...frame.presentedSurface.rgb },
              },
          })),
          oracle: summarizeTemporalSelectedXfb(temporalFrames),
          surfaceOracle: summarizeTemporalPresentedSurfaces(temporalFrames),
        };
        return { metrics, selectedXfb, temporalSelectedXfb };
      });
    }
    const localIplImageBytes = 2 * 1024 * 1024;
    const palIplHeader =
      "(C) 1999-2001 Nintendo.  All rights reserved."
      + "(C) 1999 ArtX Inc.  All rights reserved."
      + "PAL  Revision 1.0  ";

    function hasPalIplHeader(image) {
      if (image[palIplHeader.length] !== 0) return false;
      for (let index = 0; index < palIplHeader.length; index += 1) {
        if (image[index] !== palIplHeader.charCodeAt(index)) return false;
      }
      return true;
    }

    function descrambleRetailIplRange(image, start, end) {
      let accumulator = 0;
      let accumulatorBits = 0;
      let t = 0x2953;
      let u = 0xd9c2;
      let v = 0x3ff1;
      let x = 1;
      let index = start;
      while (index < end) {
        const t0 = t & 1;
        const t1 = (t >>> 1) & 1;
        const u0 = u & 1;
        const u1 = (u >>> 1) & 1;
        const v0 = v & 1;

        x ^= t1 ^ v0;
        x ^= u0 | u1;
        x ^= (t0 ^ u1 ^ v0) & (t0 ^ u0);

        if (t0 === u0) {
          v >>>= 1;
          if (v0 !== 0) v ^= 0xb3d0;
        }
        if (t0 === 0) {
          u >>>= 1;
          if (u0 !== 0) u ^= 0xfb10;
        }
        t >>>= 1;
        if (t0 !== 0) t ^= 0xa740;

        accumulatorBits += 1;
        accumulator = (accumulator * 2 + x) & 0xff;
        if (accumulatorBits === 8) {
          image[index] ^= accumulator;
          index += 1;
          accumulatorBits = 0;
        }
      }
    }

    function decodeRetailIplImage(input) {
      if (
        Object.prototype.toString.call(input) !== "[object Uint8Array]"
      ) {
        throw new TypeError("IPL image must be a Uint8Array");
      }
      if (input.byteLength !== localIplImageBytes) {
        throw new RangeError(
          `IPL image must be exactly ${localIplImageBytes} bytes`
        );
      }
      const image = input.slice();
      if (image.indexOf(0) === -1) {
        throw new Error("IPL header is not NUL-terminated");
      }
      const region = hasPalIplHeader(image) ? "PAL" : "NTSC";
      const decodedEnd = region === "PAL" ? 0x001aeee8 : 0x0015ee40;
      descrambleRetailIplRange(image, 0x100, decodedEnd);
      return {
        image,
        region,
        decodedBytes: decodedEnd - 0x100,
      };
    }

    async function readLocalIplFile(file) {
      if (!(file instanceof Blob)) {
        throw new TypeError("IPL picker did not provide a file");
      }
      if (file.size !== localIplImageBytes) {
        throw new RangeError("IPL file must be exactly 2 MiB");
      }
      return decodeRetailIplImage(new Uint8Array(await file.arrayBuffer()));
    }

    function activateLocalIpl(decoded) {
      selectedLocalIpl = {
        image: decoded.image,
        region: decoded.region,
      };
      if (activeDiscConfig !== null) {
        startWorker(activeDiscConfig, activeDiscLabel);
      }
      return selectedLocalIpl;
    }

    globalThis.lazuliRendererDiagnostics = Object.freeze({
      capturePerformance: captureRendererPerformance,
      captureSelectedXfb,
      captureTerminal: captureRendererTerminal,
    });
    function gxClearEfb(clear) {
      const {
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        copyState,
      } = clear;
      const [red, green, blue, alpha] = copyState.clearRgba;
      webGpuRenderer.clear_efb_copy(
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        copyState.zMode,
        copyState.blendMode,
        copyState.pixelControl,
        red,
        green,
        blue,
        alpha,
        copyState.clearDepth,
      );
    }
    const source = document.querySelector("#runner-source").textContent;
    const debugSurface = document.querySelector(".shell").dataset.surface === "debug";
    const compatibilityScenarioIds = new Set([
      "smb-ready-play",
      "smb-sustained-play",
    ]);
    function compatibilityScenarioSearch(scenario) {
      if (!compatibilityScenarioIds.has(scenario)) {
        throw new Error("unsupported compatibility scenario");
      }
      return `?scenario=${scenario}`;
    }
    function runnerSearchForSurface(isDebugSurface, search, compatibilitySearch = "") {
      return isDebugSurface ? search : compatibilitySearch;
    }
    const defaultDiscSourceConfig = __HAS_DISC__
      ? {
          kind: "logical-range-endpoint",
          url: new URL("/disc", location.href).href,
        }
      : __HAS_BOOT_ASSET__
        ? { kind: "boot-assets" }
        : null;
    const discStatus = document.querySelector("#disc-status");
    const iplStatus = document.querySelector("#ipl-status");
    let worker = null;
    let workerUrl = null;
    let terminalPublicationSequence = 0;
    let controllerScenarioState = null;
    let selectedCompatibilityRunnerSearch = "";
    let selectedLocalIpl = null;
    let activeDiscConfig = null;
    let activeDiscLabel = null;

    function resetPresentation() {
      output.textContent = "STARTING";
      return enqueueRendererOperation(async phases => {
        webGpuRenderer.reset();
        await drainWebGpuRenderer(phases);
        webGpuRenderer.reset_diagnostics();
      }).catch(handleRendererError);
    }

    function startWorker(discConfig, label) {
      activeDiscConfig = discConfig;
      activeDiscLabel = label;
      const replacingWorker = worker !== null;
      resetCompositorCaptureForWorker(replacingWorker);
      controllerScenarioState = null;
      if (replacingWorker) {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
        resetPresentation();
      } else {
        webGpuRenderer.reset_diagnostics();
      }
      resetRendererHostMetrics();
      const workerDiscConfig = discConfig.kind === "file"
        ? { kind: "file-message" }
        : discConfig;
      const workerIplConfig = selectedLocalIpl === null
        ? { kind: "bundled-default" }
        : { kind: "file-message" };
      document.body.dataset.status = "loading";
      runnerStatus.textContent = "loading";
      const bootstrap = [
        `globalThis.runnerSearch = ${JSON.stringify(
          runnerSearchForSurface(
            debugSurface,
            location.search,
            selectedCompatibilityRunnerSearch
          )
        )};`,
        `globalThis.runnerScenarioOptional = ${JSON.stringify(!debugSurface)};`,
        `globalThis.discSourceConfig = ${JSON.stringify(workerDiscConfig)};`,
        `globalThis.iplSourceConfig = ${JSON.stringify(workerIplConfig)};`,
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
      if (selectedLocalIpl !== null) {
        const workerImage = selectedLocalIpl.image.slice();
        worker.postMessage({
          type: "ipl-source-image",
          image: workerImage.buffer,
          region: selectedLocalIpl.region,
        }, [workerImage.buffer]);
      }
      globalThis.lazuliWorker = worker;
      discStatus.textContent = label;
      queueMicrotask(() => { lastControllerPacket = ""; });
      return worker;
    }

    function selectCompatibilityScenario(scenario) {
      if (debugSurface) {
        throw new Error("compatibility debug control requires the release surface");
      }
      if (location.search !== "" || location.hash !== "") {
        throw new Error("compatibility debug control requires a queryless frontend");
      }
      if (worker !== null) {
        throw new Error("compatibility scenario must be selected before disc activation");
      }
      selectedCompatibilityRunnerSearch = compatibilityScenarioSearch(scenario);
      return Object.freeze({ scenario });
    }
    Object.defineProperty(globalThis, "lazuliCompatibilityDebug", {
      configurable: false,
      enumerable: true,
      value: Object.freeze({
        selectScenario: selectCompatibilityScenario,
      }),
      writable: false,
    });

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
    const iplFileInput = document.querySelector("#ipl-file");
    const iplPickerLabel = document.querySelector("#ipl-picker-label");
    let iplSelectionSequence = 0;
    iplFileInput.addEventListener("click", event => {
      event.currentTarget.value = "";
    });
    iplFileInput.addEventListener("change", async event => {
      const file = event.currentTarget.files?.[0];
      if (file === undefined) return;
      const sequence = ++iplSelectionSequence;
      iplFileInput.disabled = true;
      iplPickerLabel.textContent = "Reading IPL…";
      iplStatus.textContent = "reading local IPL";
      try {
        const decoded = await readLocalIplFile(file);
        if (sequence !== iplSelectionSequence) return;
        activateLocalIpl(decoded);
        iplPickerLabel.textContent = `IPL: ${decoded.region}`;
        iplStatus.textContent = `local IPL: ${file.name} (${decoded.region})`;
      } catch (error) {
        if (sequence !== iplSelectionSequence) return;
        iplPickerLabel.textContent = "IPL rejected";
        iplStatus.textContent = String(error?.message ?? error);
      } finally {
        if (sequence === iplSelectionSequence) iplFileInput.disabled = false;
      }
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
    function normalizePageControllerState(state) {
      if (state === null || typeof state !== "object" || Array.isArray(state)) {
        throw new TypeError("controller scenario state must be an object");
      }
      const integer = (name, maximum) => {
        const value = state[name];
        if (!Number.isSafeInteger(value)) {
          throw new TypeError(`controller scenario state ${name} must be a safe integer`);
        }
        if (value < 0 || value > maximum) {
          throw new RangeError(
            `controller scenario state ${name} must be between 0 and ${maximum}`
          );
        }
        return value;
      };
      return {
        buttons: integer("buttons", 0xffff),
        stickX: integer("stickX", 0xff),
        stickY: integer("stickY", 0xff),
        cStickX: integer("cStickX", 0xff),
        cStickY: integer("cStickY", 0xff),
        triggerL: integer("triggerL", 0xff),
        triggerR: integer("triggerR", 0xff),
        analogA: integer("analogA", 0xff),
        analogB: integer("analogB", 0xff),
      };
    }
    function samplePageControllerState() {
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
      return state;
    }
    function publishControllerState() {
      const scenarioInput = controllerScenarioState === null
        ? null
        : {
            scenario: controllerScenarioState.scenario,
            step: controllerScenarioState.step,
            phase: controllerScenarioState.phase,
            requestSequence: controllerScenarioState.requestSequence,
          };
      const state = controllerScenarioState?.state ?? samplePageControllerState();
      const packet = JSON.stringify(
        scenarioInput === null ? state : { state, scenarioInput }
      );
      if (packet !== lastControllerPacket) {
        lastControllerPacket = packet;
        controllerSequence += 1;
        const message = { type: "controller", sequence: controllerSequence, state };
        if (scenarioInput !== null) message.scenarioInput = scenarioInput;
        worker?.postMessage(message);
      }
      return state;
    }
    function applyControllerScenarioInput(message) {
      if (
        typeof message.scenario !== "string"
        || message.scenario.length === 0
        || typeof message.step !== "string"
        || message.step.length === 0
        || (message.phase !== "active" && message.phase !== "neutral")
        || !Number.isSafeInteger(message.requestSequence)
        || message.requestSequence < 1
      ) {
        throw new TypeError("controller scenario input request is invalid");
      }
      if (
        controllerScenarioState !== null
        && controllerScenarioState.scenario === message.scenario
        && controllerScenarioState.step === message.step
        && message.requestSequence <= controllerScenarioState.requestSequence
      ) return false;
      controllerScenarioState = {
        scenario: message.scenario,
        step: message.step,
        phase: message.phase,
        requestSequence: message.requestSequence,
        state: normalizePageControllerState(message.state),
      };
      publishControllerState();
      return true;
    }
    function sampleController() {
      publishControllerState();
      requestAnimationFrame(sampleController);
    }
    sampleController();
    function submitGxFrame(message) {
      const packet = message.packet;
      if (!(packet instanceof ArrayBuffer)) {
        throw new TypeError("GX frame message packet must be an ArrayBuffer");
      }
      const diagnostics = message.diagnostics ?? {};
      const copyKind = Number(diagnostics.copyKind);
      const index = Number(diagnostics.index);
      const drawCalls = Number(diagnostics.drawCalls);
      const vertices = Number(diagnostics.vertices);
      if (
        (copyKind !== 1 && copyKind !== 2)
        || !Number.isSafeInteger(index)
        || index < 0
        || !Number.isSafeInteger(drawCalls)
        || drawCalls < 0
        || !Number.isSafeInteger(vertices)
        || vertices < 0
      ) {
        throw new TypeError("GX frame message diagnostics are invalid");
      }
      rendererHostMetrics.workerMessages.gxFrames += 1;
      rendererHostMetrics.workerMessages.drawCalls += drawCalls;
      rendererHostMetrics.workerMessages.receivedArrayBufferBytes += packet.byteLength;
      const residentTextureKeys = Array.from(
        webGpuRenderer.submit_gx_frame(new Uint8Array(packet)) ?? [],
        key => String(key)
      );
      if (copyKind === 1) {
        document.body.dataset.gxTextureCopies = String(index);
      } else {
        document.body.dataset.xfbCopies = String(index);
        document.body.dataset.gxDrawCalls = String(drawCalls);
        document.body.dataset.gxVertices = String(vertices);
      }
      return { residentTextureKeys };
    }
    async function drainWebGpuRenderer(phases = rendererHostMetrics.wall?.phases ?? null) {
      const drainStartedAt = phases === null
        ? null
        : beginRendererPhaseTiming(phases.queueDrain);
      try {
        await webGpuRenderer.drain();
        webGpuRenderer.check_health();
      } finally {
        if (phases !== null) {
          recordRendererPhaseTiming(phases.queueDrain, drainStartedAt);
        }
      }
    }
    function validateViPresentationResult(frame, result) {
      if (result === null || typeof result !== "object" || Array.isArray(result)) {
        throw new TypeError("WebGPU VI presentation result is not an object");
      }
      const accepted = result.accepted;
      const presented = result.presented;
      const status = result.status;
      const pairEpoch = Number(result.pairEpoch);
      const presentationSerial = result.presentationSerial;
      const expectedReadyStatus = new Map([
        ["progressive", "vi-progressive-frame-ready"],
        ["single-field", "vi-single-field-frame-ready"],
        ["interlaced", "vi-interlaced-frame-ready"],
      ]).get(frame?.presentationMode);
      const readyStatuses = new Set([
        "vi-progressive-frame-ready",
        "vi-single-field-frame-ready",
        "vi-interlaced-frame-ready",
      ]);
      const stagedStatuses = new Set([
        "vi-field-pair-awaiting",
        "vi-field-pair-superseded",
      ]);
      if (
        typeof accepted !== "boolean"
        || typeof presented !== "boolean"
        || typeof status !== "string"
        || status.length === 0
        || expectedReadyStatus === undefined
        || (frame?.field !== "top" && frame?.field !== "bottom")
        || !Number.isSafeInteger(pairEpoch)
        || pairEpoch < 1
        || pairEpoch > 0xffff_ffff
        || pairEpoch !== Number(frame?.pairEpoch)
        || (presented && !accepted)
      ) {
        throw new TypeError("WebGPU VI presentation result is invalid");
      }
      if (presented) {
        if (
          !readyStatuses.has(status)
          || status !== expectedReadyStatus
          || !Number.isSafeInteger(Number(presentationSerial))
          || Number(presentationSerial) < 1
          || frame?.pairCompleting !== true
        ) {
          throw new TypeError("WebGPU VI presented result is invalid");
        }
      } else if (presentationSerial !== null) {
        throw new TypeError("non-presented WebGPU VI result has a serial");
      } else if (accepted) {
        if (
          !stagedStatuses.has(status)
          || frame.presentationMode !== "interlaced"
          || frame?.pairCompleting !== false
        ) {
          throw new TypeError("WebGPU VI staged result is invalid");
        }
      } else if (
        readyStatuses.has(status)
        || stagedStatuses.has(status)
        || !status.startsWith("vi-field-")
      ) {
        throw new TypeError("WebGPU VI rejected result is invalid");
      }
      return {
        accepted,
        presented,
        status,
        pairEpoch,
        presentationSerial: presented ? Number(presentationSerial) : null,
      };
    }
    function handleRendererFrame(message, render, sourceWorker = worker) {
      const rendererSequence = Number(message.rendererSequence);
      const temporalFrames = message.frame?.temporalXfbCapture === undefined
        ? null
        : temporalSelectedXfbFrames;
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
      return enqueueRendererOperation(phases => {
        if (!isCurrentWorker()) return { ok: false, value: null };
        let value;
        try {
          value = render();
        } catch (error) {
          return fail(error);
        }
        return (async () => {
          await drainWebGpuRenderer(phases);
          if (!isCurrentWorker()) return { ok: false, value: null };
          if (message.type === "vi-present" && value?.presented === true) {
            lastPresentedViProjection = {
              pairEpoch: value.pairEpoch,
              field: message.frame.field,
            };
          }
          if (message.frame?.temporalXfbCapture !== undefined) {
            if (value?.presented !== true) {
              throw new Error(
                "temporal XFB capture requires a completed WebGPU host frame"
              );
            }
            const temporalCapture = await captureTemporalSelectedXfb(
              message,
              value,
              temporalFrames
            );
            if (
              typeof compositorCaptureEnabled !== "undefined"
              && compositorCaptureEnabled
            ) {
              await waitForCompositorCapture(temporalCapture, sourceWorker);
            }
            if (!isCurrentWorker()) return { ok: false, value: null };
          }
          const sustainedPlayReceipt = message.frame?.sustainedPlayReceipt === undefined
            ? null
            : captureSmbSustainedViReceipt(message, value);
          if (Number.isSafeInteger(rendererSequence)) {
            const completion = {
              type: "renderer-frame-complete",
              rendererSequence,
            };
            if (Array.isArray(value?.residentTextureKeys)) {
              completion.residentTextureKeys = value.residentTextureKeys;
            }
            if (sustainedPlayReceipt !== null) {
              completion.sustainedPlayReceipt = sustainedPlayReceipt;
            }
            if (message.type === "vi-present") {
              completion.viPresentationResult = { ...value };
            }
            sourceWorker?.postMessage(completion);
          }
          return { ok: true, value };
        })().catch(fail);
      });
    }
    function handleRendererOperation(render, sourceWorker = worker) {
      return enqueueRendererOperation(phases => {
        if (worker !== sourceWorker) return { ok: false, value: null };
        let value;
        try {
          value = render();
        } catch (error) {
          if (worker === sourceWorker) handleRendererError(error);
          return { ok: false, value: null };
        }
        return drainWebGpuRenderer(phases).then(
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
    function parseWorkerTerminalReport(text) {
      if (typeof text !== "string" || text.trimStart().charCodeAt(0) !== 0x7b) return null;
      try {
        const report = JSON.parse(text);
        return report !== null && typeof report === "object" && !Array.isArray(report)
          ? report
          : null;
      } catch (_error) {
        return null;
      }
    }
    async function publishWorkerTerminalReport(text, sourceWorker = worker) {
      if (worker !== sourceWorker) return false;
      const publicationSequence = ++terminalPublicationSequence;
      const isCurrentPublication = () => worker === sourceWorker
        && terminalPublicationSequence === publicationSequence;
      const report = parseWorkerTerminalReport(text);
      if (report === null) {
        handleWorkerError({
          currentTarget: sourceWorker,
          message: "worker terminal report is not valid JSON",
        });
        return false;
      }
      const hostMetrics = rendererHostMetrics;
      const temporalFrames = temporalSelectedXfbFrames;
      const backend = document.body.dataset.renderer ?? null;
      hostMetrics.wall.workerStartToLastReportMs = Math.max(
        0,
        performance.now() - rendererWorkerStartedAt
      );
      output.textContent = "CAPTURING";
      try {
        const capture = await captureRendererTerminal(hostMetrics, temporalFrames);
        if (!isCurrentPublication()) return false;
        report.rendering = { ...capture, backend };
        output.textContent = JSON.stringify(report, null, 2);
        return true;
      } catch (error) {
        if (!isCurrentPublication()) return false;
        handleRendererError(error, false);
        return false;
      }
    }
    function handleWorkerMessage(event) {
      const sourceWorker = event.currentTarget ?? worker;
      if (sourceWorker !== worker) return;
      const message = event.data;
      if (message?.type === "controller-poll") {
        acknowledgeControllerPoll(message.buttons, message.sequence);
      } else if (message?.type === "controller-scenario-input") {
        applyControllerScenarioInput(message);
      } else if (message?.type === "dataset") {
        document.body.dataset[message.name] = message.value;
        if (message.name === "status") runnerStatus.textContent = message.value;
      } else if (message?.type === "gx-clear") {
        return handleRendererOperation(() => gxClearEfb(message.clear), sourceWorker);
      } else if (message?.type === "gx-frame") {
        return handleRendererFrame(message, () => submitGxFrame(message), sourceWorker);
      } else if (message?.type === "vi-present") {
        const frame = message.frame;
        return handleRendererFrame(message, () => validateViPresentationResult(
          frame,
          webGpuRenderer.present_xfb(
            frame.address,
            frame.copyIndex,
            frame.copyRow,
            frame.presentationMode,
            frame.field,
            frame.pairEpoch,
            frame.width,
            frame.height,
            frame.fieldStrideBytes,
            frame.fieldHeight,
            frame.rowRepeat,
            frame.temporalXfbCapture !== undefined
          )
        ),
          sourceWorker
        ).then(presentation => {
          if (!presentation.ok) return;
          const result = presentation.value;
          document.body.dataset.viField = frame.field;
          document.body.dataset.viPresentationMode = frame.presentationMode;
          document.body.dataset.viPairEpoch = String(result.pairEpoch);
          document.body.dataset.viResult = result.status;
          document.body.dataset.viAccepted = String(result.accepted);
          document.body.dataset.viXfbAddress =
            "0x" + frame.address.toString(16).padStart(8, "0");
          document.body.dataset.viCopyIndex = String(frame.copyIndex);
          document.body.dataset.viCopyRow = String(frame.copyRow);
          document.body.dataset.viScanoutPolicy = String(frame.scanoutPolicy);
          document.body.dataset.viFields = String(
            Number(document.body.dataset.viFields ?? 0) + 1
          );
          if (result.presented) {
            document.body.dataset.viPresents = String(
              Number(document.body.dataset.viPresents ?? 0) + 1
            );
            document.body.dataset.viPresentationSerial =
              String(result.presentationSerial);
          } else if (result.accepted) {
            document.body.dataset.viStaged = String(
              Number(document.body.dataset.viStaged ?? 0) + 1
            );
          } else {
            document.body.dataset.viRejected = String(
              Number(document.body.dataset.viRejected ?? 0) + 1
            );
          }
        });
      } else if (message?.type === "finish") {
        return publishWorkerTerminalReport(message.text, sourceWorker);
      }
    }
    function handleWorkerError(event) {
      if (event.currentTarget !== undefined && event.currentTarget !== worker) return;
      const message = String(event.message || "unknown worker error");
      const rendererError = String(event.rendererError ?? message);
      terminalPublicationSequence += 1;
      document.body.dataset.status = "stopped";
      runnerStatus.textContent = "worker error";
      discStatus.textContent = message;
      output.textContent = JSON.stringify({
        status: "stopped",
        stage: "worker",
        error: message,
        rendering: {
          backend: document.body.dataset.renderer ?? null,
          error: rendererError,
        },
      }, null, 2);
    }
    function handleRendererError(error, notifyWorker = true) {
      const detail = String(error?.message ?? error);
      if (notifyWorker) {
        worker?.postMessage({ type: "renderer-failed", error: detail });
      }
      handleWorkerError({
        message: `WebGPU renderer failed: ${detail}`,
        rendererError: detail,
      });
    }
    addEventListener("beforeunload", () => {
      failCompositorCapture("compositor capture cancelled by document unload");
      worker?.terminate();
      if (workerUrl !== null) URL.revokeObjectURL(workerUrl);
    }, { once: true });
  </script>
</body>
</html>
"##;
