#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Serve dev-only all-game Rust-resident evidence over opaque byte ranges."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import threading
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit


RANGE_PATTERN = re.compile(r"bytes=(\d+)-(\d+)")
KEY_PATTERN = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
CHUNK_BYTES = 4 * 1024 * 1024
CORPUS_PRODUCTION_EVIDENCE_LOCK_SCHEMA = "lazuli-resident-corpus-evidence-lock-v2"
FIDELITY_PRODUCTION_EVIDENCE_LOCK_SCHEMA = (
    "lazuli-resident-renderer-fidelity-evidence-lock-v3"
)
PRODUCTION_SOURCE_PATHS = {
    CORPUS_PRODUCTION_EVIDENCE_LOCK_SCHEMA: {
        "tools/resident_machine_first_frame.html",
        "tools/resident_machine_first_frame.mjs",
        "tools/resident_machine_evidence_v1.mjs",
        "tools/resident_machine_first_frame_report.mjs",
        "tools/resident_machine_fidelity_checkpoints.mjs",
        "tools/resident_machine_fidelity_checkpoint_worker.mjs",
        "tools/resident_machine_fidelity_checkpoint_report.mjs",
        "tools/resident_machine_fidelity_lock.mjs",
        "tools/resident_machine_fidelity_combined_report.mjs",
        "tools/resident_machine_fidelity_server.py",
        "tools/resident_machine_fidelity_watchdog.py",
        "tools/resident_machine_corpus_server.py",
        "crates/lazuli-abi/src/lib.rs",
        "tools/resident_machine_game_fidelity_v1.mjs",
        "tools/resident_machine_production_fidelity_capture.mjs",
        "tools/resident_machine_production_fidelity_local.mjs",
        "tools/resident_machine_production_fidelity_bundle.mjs",
        "tools/resident_machine_production_fidelity_gate.mjs",
        "tools/resident_machine_corpus.html",
        "tools/resident_machine_corpus.mjs",
        "tools/resident_machine_corpus_report.mjs",
        "web/release.mjs",
        "tools/browser_boot_headless_cdp.mjs",
        "tools/browser_game_compatibility_corpus.mjs",
        "tools/browser_boot_devtools_socket.mjs",
        "tools/browser_boot_disc_identity.mjs",
    },
    FIDELITY_PRODUCTION_EVIDENCE_LOCK_SCHEMA: {
        "tools/resident_machine_first_frame.html",
        "tools/resident_machine_first_frame.mjs",
        "tools/resident_machine_evidence_v1.mjs",
        "tools/resident_machine_first_frame_report.mjs",
        "tools/resident_machine_fidelity_checkpoints.mjs",
        "tools/resident_machine_fidelity_checkpoint_worker.mjs",
        "tools/resident_machine_fidelity_checkpoint_report.mjs",
        "tools/resident_machine_fidelity_lock.mjs",
        "tools/resident_machine_fidelity_combined_report.mjs",
        "tools/resident_machine_fidelity_server.py",
        "tools/resident_machine_fidelity_watchdog.py",
        "tools/resident_machine_corpus_server.py",
        "crates/lazuli-abi/src/lib.rs",
        "tools/resident_machine_game_fidelity_v1.mjs",
        "tools/resident_machine_production_fidelity_capture.mjs",
        "tools/resident_machine_production_fidelity_local.mjs",
        "tools/resident_machine_production_fidelity_bundle.mjs",
        "tools/resident_machine_production_fidelity_gate.mjs",
        "tools/resident_machine_corpus_report.mjs",
        "tools/resident_machine_corpus.html",
        "tools/resident_machine_corpus.mjs",
        "web/release.mjs",
        "tools/browser_boot_headless_cdp.mjs",
        "tools/browser_game_compatibility_corpus.mjs",
        "tools/browser_boot_devtools_socket.mjs",
        "tools/browser_boot_disc_identity.mjs",
    },
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class FrozenFile:
    path: Path
    device: int
    inode: int
    size: int
    modified_ns: int

    @classmethod
    def open(cls, path: Path) -> "FrozenFile":
        resolved = path.resolve(strict=True)
        metadata = resolved.stat()
        if not resolved.is_file():
            raise ValueError(f"not a regular file: {path}")
        return cls(
            path=resolved,
            device=metadata.st_dev,
            inode=metadata.st_ino,
            size=metadata.st_size,
            modified_ns=metadata.st_mtime_ns,
        )

    def unchanged(self) -> bool:
        metadata = self.path.stat()
        return (
            metadata.st_dev,
            metadata.st_ino,
            metadata.st_size,
            metadata.st_mtime_ns,
        ) == (self.device, self.inode, self.size, self.modified_ns)


@dataclass(frozen=True)
class OpaqueGame:
    key: str
    priority: int
    source: FrozenFile
    sha256: str
    etag: str


class TransportCounters:
    def __init__(self, keys: list[str]) -> None:
        self.lock = threading.Lock()
        self.counters = {
            key: {
                "physicalReadRequests": 0,
                "physicalReadBytes": 0,
                "invalidRangeRequests": 0,
                "preconditionFailures": 0,
            }
            for key in keys
        }

    def increment(self, key: str, field: str, amount: int = 1) -> None:
        with self.lock:
            self.counters[key][field] += amount

    def snapshot(self, key: str) -> dict[str, int]:
        with self.lock:
            return dict(self.counters[key])


class ResidentCorpusHandler(BaseHTTPRequestHandler):
    workspace: Path
    artifacts: dict[str, FrozenFile]
    artifact_manifest: bytes
    corpus_manifest: bytes
    games: dict[str, OpaqueGame]
    counters: TransportCounters
    max_range_bytes: int
    execution_assets: dict[str, FrozenFile] = {}
    authority_lock_bytes: bytes | None = None
    production_source_snapshots: dict[str, bytes] | None = None

    def log_message(self, _format: str, *_arguments: object) -> None:
        pass

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def send_bytes(
        self,
        body: bytes,
        content_type: str,
        status: HTTPStatus = HTTPStatus.OK,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_frozen_file(self, source: FrozenFile) -> None:
        if not source.unchanged():
            self.send_error(HTTPStatus.PRECONDITION_FAILED, "served file changed")
            return
        content_type = mimetypes.guess_type(source.path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(source.size))
        self.end_headers()
        if self.command == "HEAD":
            return
        with source.path.open("rb") as file:
            while chunk := file.read(CHUNK_BYTES):
                self.wfile.write(chunk)

    def send_raw_range(self, game: OpaqueGame) -> None:
        if not game.source.unchanged():
            self.counters.increment(game.key, "preconditionFailures")
            self.send_error(HTTPStatus.PRECONDITION_FAILED, "opaque container changed")
            return
        if_match = self.headers.get("If-Match")
        if if_match is not None and if_match != game.etag:
            self.counters.increment(game.key, "preconditionFailures")
            self.send_error(HTTPStatus.PRECONDITION_FAILED, "opaque container ETag changed")
            return
        match = RANGE_PATTERN.fullmatch(self.headers.get("Range") or "")
        if match is None:
            self.counters.increment(game.key, "invalidRangeRequests")
            self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "exact byte range required")
            return
        start = int(match.group(1))
        end = int(match.group(2))
        length = end - start + 1
        if (
            start > end
            or end >= game.source.size
            or length > self.max_range_bytes
        ):
            self.counters.increment(game.key, "invalidRangeRequests")
            self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "range outside transport bounds")
            return
        descriptor = os.open(game.source.path, os.O_RDONLY)
        try:
            body = os.pread(descriptor, length, start)
        finally:
            os.close(descriptor)
        if len(body) != length:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "short physical read")
            return
        self.counters.increment(game.key, "physicalReadRequests")
        self.counters.increment(game.key, "physicalReadBytes", length)
        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Range", f"bytes {start}-{end}/{game.source.size}")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", game.etag)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def safe_workspace_path(self, request_path: str) -> Path | None:
        relative = unquote(request_path).lstrip("/")
        candidate = (self.workspace / relative).resolve()
        try:
            candidate.relative_to(self.workspace)
        except ValueError:
            return None
        return candidate if candidate.is_file() else None

    def transport_snapshot(self, query: str) -> None:
        parameters = parse_qs(query, keep_blank_values=True)
        keys = parameters.get("game", [])
        if len(keys) != 1 or keys[0] not in self.games or set(parameters) != {"game"}:
            self.send_error(HTTPStatus.BAD_REQUEST, "one known game key is required")
            return
        key = keys[0]
        body = json.dumps(
            {
                "schema": "lazuli-resident-opaque-transport-v1",
                "gameKey": key,
                **self.counters.snapshot(key),
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8") + b"\n"
        self.send_bytes(body, "application/json")

    def serve(self) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path
        if path == "/":
            path = "/tools/resident_machine_corpus.html"
        if path == "/resident-corpus/manifest.json":
            self.send_bytes(self.corpus_manifest, "application/json")
            return
        if path == "/resident-corpus/transport.json":
            self.transport_snapshot(parsed.query)
            return
        if path.startswith("/resident-corpus/games/") and path.endswith("/disc"):
            key = unquote(path.removeprefix("/resident-corpus/games/").removesuffix("/disc"))
            game = self.games.get(key)
            if game is None or not KEY_PATTERN.fullmatch(key):
                self.send_error(HTTPStatus.NOT_FOUND)
            else:
                self.send_raw_range(game)
            return
        if path == "/resident-artifacts/manifest.json":
            self.send_bytes(self.artifact_manifest, "application/json")
            return
        if path.startswith("/resident-artifacts/"):
            name = path.removeprefix("/resident-artifacts/")
            source = self.artifacts.get(name)
            if source is None:
                self.send_error(HTTPStatus.NOT_FOUND)
            else:
                self.send_frozen_file(source)
            return
        if path == "/resident-authority/evidence-lock.json" and self.authority_lock_bytes is not None:
            self.send_bytes(self.authority_lock_bytes, "application/json")
            return
        execution_asset = self.execution_assets.get(path)
        if execution_asset is not None:
            self.send_frozen_file(execution_asset)
            return
        if self.production_source_snapshots is not None:
            source = self.production_source_snapshots.get(path.lstrip("/"))
            if source is None:
                self.send_error(HTTPStatus.NOT_FOUND)
            else:
                content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
                self.send_bytes(source, content_type)
            return
        source_path = self.safe_workspace_path(path)
        if source_path is None:
            self.send_error(HTTPStatus.NOT_FOUND)
        else:
            self.send_frozen_file(FrozenFile.open(source_path))

    def do_GET(self) -> None:  # noqa: N802
        self.serve()

    def do_HEAD(self) -> None:  # noqa: N802
        self.serve()


def required_manifest_games(corpus_path: Path) -> tuple[bytes, list[dict[str, object]]]:
    corpus_bytes = corpus_path.read_bytes()
    corpus = json.loads(corpus_bytes)
    if corpus.get("schema") != "lazuli-game-compatibility-corpus-v1":
        raise ValueError("unsupported game corpus schema")
    games = corpus.get("games")
    if not isinstance(games, list) or not games:
        raise ValueError("game corpus is empty")
    seen: set[str] = set()
    for game in games:
        if not isinstance(game, dict):
            raise ValueError("game corpus entry is not an object")
        key = game.get("key")
        file = game.get("file")
        expected_bytes = game.get("bytes")
        expected_sha = game.get("image", {}).get("sha256")
        if not isinstance(key, str) or not KEY_PATTERN.fullmatch(key) or key in seen:
            raise ValueError(f"invalid or duplicate game key {key!r}")
        if not isinstance(file, str) or Path(file).name != file or file.startswith("."):
            raise ValueError(f"unsafe corpus filename for {key}")
        if not isinstance(expected_bytes, int) or expected_bytes <= 0:
            raise ValueError(f"invalid byte length for {key}")
        if not isinstance(expected_sha, str) or not SHA256_PATTERN.fullmatch(expected_sha):
            raise ValueError(f"invalid SHA-256 for {key}")
        seen.add(key)
    return corpus_bytes, games


def production_execution_assets(
    authority_path: Path,
    adapter_path: Path,
    worker_path: Path,
    frontend_path: Path,
    workspace: Path,
    artifact_paths: dict[str, Path],
) -> tuple[bytes, dict[str, FrozenFile], dict[str, bytes]]:
    authority_bytes = authority_path.resolve(strict=True).read_bytes()
    authority = json.loads(authority_bytes)
    release = authority.get("release") if isinstance(authority, dict) else None
    descriptors = release.get("executionAssets") if isinstance(release, dict) else None
    if not isinstance(descriptors, dict):
        raise ValueError("execution authority lacks release.executionAssets")
    expected_roles = {
        "core",
        "dispatcher",
        "coordinator",
        "adapter",
        "worker",
        "frontend",
        "rendererJavascript",
        "rendererWasm",
    }
    if set(descriptors) != expected_roles:
        raise ValueError("execution authority has an invalid exact execution role set")
    schema = authority.get("schema") if isinstance(authority, dict) else None
    expected_sources = PRODUCTION_SOURCE_PATHS.get(schema)
    records = authority.get("sources") if isinstance(authority, dict) else None
    if expected_sources is None or not isinstance(records, dict) or set(records) != expected_sources:
        raise ValueError("execution authority has an invalid exact production source set")
    root = workspace.resolve(strict=True)
    snapshots: dict[str, bytes] = {}
    for relative in sorted(expected_sources):
        record = records[relative]
        if not isinstance(record, dict) or set(record) != {"bytes", "sha256"}:
            raise ValueError(f"execution authority has an invalid source record: {relative}")
        source_path = (root / relative).resolve(strict=True)
        try:
            source_path.relative_to(root)
        except ValueError as error:
            raise ValueError(f"production source escaped workspace: {relative}") from error
        body = source_path.read_bytes()
        if len(body) != record["bytes"] or hashlib.sha256(body).hexdigest() != record["sha256"]:
            raise ValueError(f"production source does not match execution authority: {relative}")
        snapshots[relative] = body
    paths = {
        "core": artifact_paths["browser_machine.wasm"],
        "dispatcher": artifact_paths["resident_dispatcher.wasm"],
        "coordinator": artifact_paths["core_run_coordinator.wasm"],
        "adapter": adapter_path,
        "worker": worker_path,
        "frontend": frontend_path,
        "rendererJavascript": artifact_paths["browser_renderer.js"],
        "rendererWasm": artifact_paths["browser_renderer_bg.wasm"],
    }
    served: dict[str, FrozenFile] = {}
    for role, source_path in paths.items():
        descriptor = descriptors.get(role)
        if not isinstance(descriptor, dict) or set(descriptor) != {"url", "bytes", "sha256"}:
            raise ValueError(f"execution authority has invalid {role} descriptor")
        url = descriptor["url"]
        parsed = urlsplit(url) if isinstance(url, str) else None
        if (
            parsed is None
            or parsed.scheme
            or parsed.netloc
            or parsed.query
            or parsed.fragment
            or not parsed.path.startswith("/")
            or parsed.path.startswith("//")
        ):
            raise ValueError(f"execution authority has unsafe {role} URL")
        source = FrozenFile.open(source_path)
        if source.size != descriptor["bytes"] or sha256_file(source.path) != descriptor["sha256"]:
            raise ValueError(f"packaged {role} bytes do not match execution authority")
        if parsed.path in served:
            raise ValueError(f"duplicate packaged execution URL {parsed.path}")
        served[parsed.path] = source
    return authority_bytes, served, snapshots


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--games", type=Path, required=True)
    parser.add_argument("--game", action="append", default=[])
    parser.add_argument("--core", type=Path, required=True)
    parser.add_argument("--dispatcher", type=Path, required=True)
    parser.add_argument("--coordinator", type=Path, required=True)
    parser.add_argument("--renderer-js", type=Path, required=True)
    parser.add_argument("--renderer-wasm", type=Path, required=True)
    parser.add_argument("--execution-authority", type=Path)
    parser.add_argument("--adapter", type=Path)
    parser.add_argument("--worker", type=Path)
    parser.add_argument("--frontend", type=Path)
    parser.add_argument("--max-range-bytes", type=int, default=64 * 1024 * 1024)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    arguments = parser.parse_args()
    if arguments.max_range_bytes <= 0:
        raise ValueError("--max-range-bytes must be positive")
    execution_arguments = [
        arguments.execution_authority,
        arguments.adapter,
        arguments.worker,
        arguments.frontend,
    ]
    if any(value is not None for value in execution_arguments) and not all(
        value is not None for value in execution_arguments
    ):
        raise ValueError(
            "--execution-authority, --adapter, --worker, and --frontend are all required together"
        )

    workspace = arguments.root.resolve(strict=True)
    games_root = arguments.games.resolve(strict=True)
    corpus_path = arguments.corpus.resolve(strict=True)
    corpus_bytes, manifest_games = required_manifest_games(corpus_path)
    requested = arguments.game
    if len(requested) != len(set(requested)):
        raise ValueError("duplicate --game selection")
    known = {str(game["key"]): game for game in manifest_games}
    unknown = [key for key in requested if key not in known]
    if unknown:
        raise ValueError(f"unknown --game keys: {unknown}")
    selected_entries = [
        game
        for game in sorted(manifest_games, key=lambda item: int(item["priority"]))
        if not requested or game["key"] in requested
    ]

    games: dict[str, OpaqueGame] = {}
    public_games: list[dict[str, object]] = []
    for entry in selected_entries:
        key = str(entry["key"])
        source = FrozenFile.open(games_root / str(entry["file"]))
        expected_bytes = int(entry["bytes"])
        expected_sha = str(entry["image"]["sha256"])
        if source.size != expected_bytes:
            raise ValueError(f"opaque container byte length mismatch for {key}")
        actual_sha = sha256_file(source.path)
        if actual_sha != expected_sha:
            raise ValueError(f"opaque container SHA-256 mismatch for {key}")
        etag = f'"raw-{source.device:x}-{source.inode:x}-{source.size:x}-{source.modified_ns:x}"'
        games[key] = OpaqueGame(
            key=key,
            priority=int(entry["priority"]),
            source=source,
            sha256=actual_sha,
            etag=etag,
        )
        public_games.append({
            "key": key,
            "priority": int(entry["priority"]),
            "bytes": source.size,
            "sha256": actual_sha,
            "rangeUrl": f"/resident-corpus/games/{quote(key)}/disc",
        })

    artifact_paths = {
        "browser_machine.wasm": arguments.core,
        "resident_dispatcher.wasm": arguments.dispatcher,
        "core_run_coordinator.wasm": arguments.coordinator,
        "browser_renderer.js": arguments.renderer_js,
        "browser_renderer_bg.wasm": arguments.renderer_wasm,
    }
    artifacts = {name: FrozenFile.open(path) for name, path in artifact_paths.items()}
    artifact_records = {
        name: {"bytes": source.size, "sha256": sha256_file(source.path)}
        for name, source in artifacts.items()
    }
    artifact_manifest = json.dumps(
        {
            "schema": "lazuli-resident-corpus-artifacts-v1",
            "artifacts": artifact_records,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8") + b"\n"
    authority_lock_bytes: bytes | None = None
    execution_assets: dict[str, FrozenFile] = {}
    production_source_snapshots: dict[str, bytes] | None = None
    if arguments.execution_authority is not None:
        authority_lock_bytes, execution_assets, production_source_snapshots = (
            production_execution_assets(
                arguments.execution_authority,
                arguments.adapter,
                arguments.worker,
                arguments.frontend,
                workspace,
                artifact_paths,
            )
        )
    corpus_manifest = json.dumps(
        {
            "schema": "lazuli-resident-corpus-host-v1",
            "sourceCorpusSha256": hashlib.sha256(corpus_bytes).hexdigest(),
            "games": public_games,
            "transport": {
                "kind": "immutable-http-range",
                "maxRangeBytes": arguments.max_range_bytes,
                "semanticArguments": 0,
            },
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8") + b"\n"

    ResidentCorpusHandler.workspace = workspace
    ResidentCorpusHandler.artifacts = artifacts
    ResidentCorpusHandler.artifact_manifest = artifact_manifest
    ResidentCorpusHandler.corpus_manifest = corpus_manifest
    ResidentCorpusHandler.games = games
    ResidentCorpusHandler.counters = TransportCounters(list(games))
    ResidentCorpusHandler.max_range_bytes = arguments.max_range_bytes
    ResidentCorpusHandler.execution_assets = execution_assets
    ResidentCorpusHandler.authority_lock_bytes = authority_lock_bytes
    ResidentCorpusHandler.production_source_snapshots = production_source_snapshots
    server = ThreadingHTTPServer((arguments.bind, arguments.port), ResidentCorpusHandler)
    server.daemon_threads = True
    observed_port = server.server_address[1]
    base_url = f"http://{arguments.bind}:{observed_port}/"
    print(json.dumps({
        "ok": True,
        "schema": "lazuli-resident-corpus-server-v1",
        "url": base_url,
        "selectedGames": [game["key"] for game in public_games],
        "artifacts": artifact_records,
        "corpusSha256": hashlib.sha256(corpus_bytes).hexdigest(),
        "discSemanticsInHost": False,
    }, sort_keys=True), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
