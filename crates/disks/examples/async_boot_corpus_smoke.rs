//! Optional metadata-only smoke for Lazuli's canonical seven-game CISO corpus.
//!
//! Run with:
//! `cargo run -p disks --example async_boot_corpus_smoke -- /path/to/games [...fallback-dirs]`

use std::ffi::OsStr;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use disks::async_boot::{BootReaderStage, DiscBootReader, DiscFormat};

#[derive(Debug, Clone, Copy)]
struct CorpusGame {
    file: &'static str,
    bytes: u64,
    identifier: &'static [u8; 6],
    revision: u8,
}

const CORPUS: [CorpusGame; 7] = [
    CorpusGame {
        file: "WarioWare, Inc. - Mega Party Game$! (USA).ciso",
        bytes: 889_225_792,
        identifier: b"GZWE01",
        revision: 0,
    },
    CorpusGame {
        file: "Luigi's Mansion (USA, Canada).ciso",
        bytes: 199_262_784,
        identifier: b"GLME01",
        revision: 0,
    },
    CorpusGame {
        file: "Legend of Zelda, The - The Wind Waker (USA, Canada).ciso",
        bytes: 1_088_455_232,
        identifier: b"GZLE01",
        revision: 0,
    },
    CorpusGame {
        file: "Super Smash Bros. Melee (USA) (En,Ja) (Rev 2).ciso",
        bytes: 1_449_165_376,
        identifier: b"GALE01",
        revision: 2,
    },
    CorpusGame {
        file: "F-Zero GX (USA).ciso",
        bytes: 1_438_679_616,
        identifier: b"GFZE01",
        revision: 0,
    },
    CorpusGame {
        file: "Metroid Prime (USA) (Rev 2).ciso",
        bytes: 1_344_307_776,
        identifier: b"GM8E01",
        revision: 2,
    },
    CorpusGame {
        file: "Star Wars - Rogue Squadron II - Rogue Leader (USA).ciso",
        bytes: 1_400_930_880,
        identifier: b"GSWE64",
        revision: 0,
    },
];

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args_os();
    let program = arguments
        .next()
        .unwrap_or_else(|| OsStr::new("async_boot_corpus_smoke").to_owned());
    let directories: Vec<PathBuf> = arguments.map(PathBuf::from).collect();
    if directories.is_empty() {
        return Err(format!(
            "usage: {} /path/to/canonical-games-directory [...fallback-dirs]",
            Path::new(&program).display()
        )
        .into());
    }

    let mut corpus_bytes_read = 0_u64;
    for (index, expected) in CORPUS.iter().enumerate() {
        let candidates: Vec<_> = directories
            .iter()
            .map(|directory| directory.join(expected.file))
            .filter(|path| path.is_file())
            .collect();
        let path = match candidates.as_slice() {
            [path] => path,
            [] => {
                return Err(
                    format!("could not find {} in any supplied directory", expected.file).into(),
                );
            }
            _ => {
                return Err(format!(
                    "found {} in multiple supplied directories: {candidates:?}",
                    expected.file
                )
                .into());
            }
        };
        let mut file = File::open(path)?;
        let container_bytes = file.metadata()?.len();
        if container_bytes != expected.bytes {
            return Err(format!(
                "{} has {} bytes; corpus declares {}",
                path.display(),
                container_bytes,
                expected.bytes
            )
            .into());
        }

        let epoch = index as u64 + 1;
        let mut reader = DiscBootReader::new(container_bytes, epoch)
            .map_err(|error| format!("{} could not start planning: {error:?}", path.display()))?;
        let mut bytes_read = 0_u64;
        while !matches!(
            reader.stage(),
            BootReaderStage::Ready | BootReaderStage::Failed
        ) {
            let requests: Vec<_> = reader.requests().collect();
            if requests.is_empty() {
                return Err(
                    format!("{} stalled without a physical request", path.display()).into(),
                );
            }
            for request in requests {
                file.seek(SeekFrom::Start(request.container_offset))?;
                let staging = reader.staging_mut(request).map_err(|error| {
                    format!("{} rejected its own request: {error:?}", path.display())
                })?;
                file.read_exact(staging)?;
                bytes_read = bytes_read
                    .checked_add(u64::from(request.length))
                    .ok_or("metadata byte count overflow")?;
                reader.complete(request, request.length).map_err(|error| {
                    format!("{} rejected an exact completion: {error:?}", path.display())
                })?;
            }
        }
        if let Some(error) = reader.failure() {
            return Err(format!("{} failed Rust planning: {error:?}", path.display()).into());
        }
        let plan = reader
            .plan()
            .ok_or_else(|| format!("{} produced no boot plan", path.display()))?;
        if &plan.identity.identifier != expected.identifier
            || plan.identity.version != expected.revision
        {
            return Err(format!(
                "{} disc identity mismatch: got {} rev {}, expected {} rev {}",
                path.display(),
                String::from_utf8_lossy(&plan.identity.identifier),
                plan.identity.version,
                String::from_utf8_lossy(expected.identifier),
                expected.revision
            )
            .into());
        }
        match plan.format {
            DiscFormat::Ciso {
                block_bytes: 0x20_0000,
                ..
            } => {}
            format => {
                return Err(format!(
                    "{} has noncanonical container geometry: {format:?}",
                    path.display()
                )
                .into());
            }
        }
        corpus_bytes_read = corpus_bytes_read
            .checked_add(bytes_read)
            .ok_or("corpus byte count overflow")?;
        println!(
            "ok {} rev {}: {} requested metadata bytes ({})",
            String::from_utf8_lossy(expected.identifier),
            expected.revision,
            bytes_read,
            expected.file
        );
    }

    println!(
        "ok {} canonical CISO plans; {} total metadata bytes read",
        CORPUS.len(),
        corpus_bytes_read
    );
    Ok(())
}
