use std::hash::{Hash, Hasher};
use std::path::Path;

use cranelift_codegen::isa::TargetIsa;
use fjall::{Database, KeyspaceCreateOptions};
use zerocopy::IntoBytes;

use crate::{Artifact, CodegenSettings, Sequence};

// Increment whenever the translated artifact ABI or frontend semantics change. Cached machine
// code is intentionally invalidated across these boundaries even when the guest sequence and
// Cranelift settings are otherwise identical.
const ARTIFACT_CACHE_SCHEMA_VERSION: u32 = 4;

struct Hash128(twox_hash::XxHash3_128);

impl Hasher for Hash128 {
    fn finish(&self) -> u64 {
        unimplemented!()
    }

    #[inline(always)]
    fn write(&mut self, bytes: &[u8]) {
        self.0.write(bytes);
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ArtifactKey(u128);

impl ArtifactKey {
    pub fn new(isa: &dyn TargetIsa, settings: &CodegenSettings, seq: &Sequence) -> Self {
        Self::with_schema(ARTIFACT_CACHE_SCHEMA_VERSION, isa, settings, seq)
    }

    fn with_schema(
        schema_version: u32,
        isa: &dyn TargetIsa,
        settings: &CodegenSettings,
        seq: &Sequence,
    ) -> Self {
        let mut hasher = Hash128(twox_hash::XxHash3_128::with_seed(0));
        schema_version.hash(&mut hasher);
        isa.name().hash(&mut hasher);
        isa.triple().hash(&mut hasher);
        isa.flags().hash(&mut hasher);
        isa.isa_flags_hash_key().hash(&mut hasher);
        settings.hash(&mut hasher);
        seq.hash(&mut hasher);
        Self(hasher.0.finish_128())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_cache_schema_changes_key() {
        assert_eq!(ARTIFACT_CACHE_SCHEMA_VERSION, 4);

        let flags = cranelift_codegen::settings::Flags::new(cranelift_codegen::settings::builder());
        let isa = jitclif::isa::x86_64_v1().finish(flags).unwrap();
        let settings = CodegenSettings::default();
        let sequence = Sequence::default();

        let current =
            ArtifactKey::with_schema(ARTIFACT_CACHE_SCHEMA_VERSION, &*isa, &settings, &sequence);
        let previous = ArtifactKey::with_schema(
            ARTIFACT_CACHE_SCHEMA_VERSION - 1,
            &*isa,
            &settings,
            &sequence,
        );

        assert_ne!(current.0, previous.0);
    }
}

pub struct Cache {
    db: Database,
    pending: u16,
    compressor: zstd::bulk::Compressor<'static>,
    decompressor: zstd::bulk::Decompressor<'static>,
    decompress_buffer: Vec<u8>,
}

impl Cache {
    pub fn new(path: impl AsRef<Path>) -> Self {
        _ = std::fs::create_dir(&path);

        let db = Database::builder(&path)
            .journal_compression(fjall::CompressionType::None)
            .manual_journal_persist(true)
            .open()
            .unwrap();

        Self {
            db,
            pending: 0,
            compressor: zstd::bulk::Compressor::new(5).unwrap(),
            decompressor: zstd::bulk::Decompressor::new().unwrap(),
            decompress_buffer: vec![0; 4 * 1024 * 1024],
        }
    }

    pub fn get(&mut self, key: ArtifactKey) -> Option<Artifact> {
        let artifacts = self
            .db
            .keyspace("artifacts", KeyspaceCreateOptions::default)
            .unwrap();

        let artifact = artifacts.get(key.0.as_bytes()).unwrap()?;

        // decompress
        let count = self
            .decompressor
            .decompress_to_buffer(&artifact, &mut self.decompress_buffer)
            .unwrap();

        // deserialize
        let deserialized = rmp_serde::from_slice(&self.decompress_buffer[..count]).unwrap();
        Some(deserialized)
    }

    pub fn insert(&mut self, key: ArtifactKey, compiled: &Artifact) {
        let artifacts = self
            .db
            .keyspace("artifacts", KeyspaceCreateOptions::default)
            .unwrap();

        // serialize
        let serialized = rmp_serde::to_vec(&compiled).unwrap();

        // compress
        let compressed = self.compressor.compress(&serialized).unwrap();
        artifacts.insert(key.0.as_bytes(), compressed).unwrap();

        self.pending += 1;
        if self.pending >= 256 {
            self.pending = 0;
            self.db.persist(fjall::PersistMode::Buffer).unwrap();
        }
    }
}

impl Drop for Cache {
    fn drop(&mut self) {
        self.db.persist(fjall::PersistMode::SyncAll).unwrap();
    }
}
