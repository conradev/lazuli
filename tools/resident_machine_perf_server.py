#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Serve the development-only Rust-resident browser throughput harness.

The disc endpoint is deliberately a raw immutable byte-range transport.  It does not inspect,
decompress, or translate ISO/CISO data; all disc-format and executable semantics remain in the
Rust browser-machine artifact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


RANGE_PATTERN = re.compile(r"bytes=(\d+)-(\d+)")
CHUNK_BYTES = 1024 * 1024


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
        stat = resolved.stat()
        if not resolved.is_file():
            raise ValueError(f"not a regular file: {path}")
        return cls(
            path=resolved,
            device=stat.st_dev,
            inode=stat.st_ino,
            size=stat.st_size,
            modified_ns=stat.st_mtime_ns,
        )

    def unchanged(self) -> bool:
        stat = self.path.stat()
        return (
            stat.st_dev,
            stat.st_ino,
            stat.st_size,
            stat.st_mtime_ns,
        ) == (self.device, self.inode, self.size, self.modified_ns)


class ResidentPerfHandler(BaseHTTPRequestHandler):
    workspace: Path
    disc: FrozenFile
    artifacts: dict[str, FrozenFile]
    manifest: bytes
    disc_etag: str

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

    def send_raw_disc_range(self) -> None:
        if not self.disc.unchanged():
            self.send_error(HTTPStatus.PRECONDITION_FAILED, "raw disc container changed")
            return
        if_match = self.headers.get("If-Match")
        if if_match is not None and if_match != self.disc_etag:
            self.send_error(HTTPStatus.PRECONDITION_FAILED, "raw disc ETag changed")
            return
        header = self.headers.get("Range")
        match = RANGE_PATTERN.fullmatch(header or "")
        if match is None:
            self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "exact byte range required")
            return
        start = int(match.group(1))
        end = int(match.group(2))
        if start > end or end >= self.disc.size:
            self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "range outside container")
            return
        length = end - start + 1
        descriptor = os.open(self.disc.path, os.O_RDONLY)
        try:
            body = os.pread(descriptor, length, start)
        finally:
            os.close(descriptor)
        if len(body) != length:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "short physical read")
            return
        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Range", f"bytes {start}-{end}/{self.disc.size}")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", self.disc_etag)
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

    def serve(self) -> None:
        path = urlsplit(self.path).path
        if path == "/":
            path = "/tools/resident_machine_perf.html"
        if path == "/disc":
            self.send_raw_disc_range()
            return
        if path == "/resident-artifacts/manifest.json":
            self.send_bytes(self.manifest, "application/json")
            return
        if path.startswith("/resident-artifacts/"):
            name = path.removeprefix("/resident-artifacts/")
            source = self.artifacts.get(name)
            if source is None:
                self.send_error(HTTPStatus.NOT_FOUND)
            else:
                self.send_frozen_file(source)
            return
        source_path = self.safe_workspace_path(path)
        if source_path is None:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_frozen_file(FrozenFile.open(source_path))

    def do_GET(self) -> None:  # noqa: N802
        self.serve()

    def do_HEAD(self) -> None:  # noqa: N802
        self.serve()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--disc", type=Path, required=True)
    parser.add_argument("--core", type=Path, required=True)
    parser.add_argument("--dispatcher", type=Path, required=True)
    parser.add_argument("--coordinator", type=Path, required=True)
    parser.add_argument("--renderer-js", type=Path, required=True)
    parser.add_argument("--renderer-wasm", type=Path, required=True)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8786)
    arguments = parser.parse_args()

    workspace = arguments.root.resolve(strict=True)
    disc = FrozenFile.open(arguments.disc)
    artifact_paths = {
        "browser_machine.wasm": arguments.core,
        "resident_dispatcher.wasm": arguments.dispatcher,
        "core_run_coordinator.wasm": arguments.coordinator,
        "browser_renderer.js": arguments.renderer_js,
        "browser_renderer_bg.wasm": arguments.renderer_wasm,
    }
    artifacts = {name: FrozenFile.open(path) for name, path in artifact_paths.items()}
    artifact_manifest = {
        name: {
            "bytes": source.size,
            "sha256": sha256_file(source.path),
        }
        for name, source in artifacts.items()
    }
    disc_sha256 = sha256_file(disc.path)
    manifest = json.dumps(
        {
            "schema": "lazuli-resident-perf-artifacts-v1",
            "artifacts": artifact_manifest,
            "disc": {"bytes": disc.size, "sha256": disc_sha256},
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    manifest += b"\n"
    disc_etag = f'"raw-{disc.device:x}-{disc.inode:x}-{disc.size:x}-{disc.modified_ns:x}"'

    ResidentPerfHandler.workspace = workspace
    ResidentPerfHandler.disc = disc
    ResidentPerfHandler.artifacts = artifacts
    ResidentPerfHandler.manifest = manifest
    ResidentPerfHandler.disc_etag = disc_etag
    server = ThreadingHTTPServer((arguments.bind, arguments.port), ResidentPerfHandler)
    server.daemon_threads = True
    observed_port = server.server_address[1]
    print(
        json.dumps(
            {
                "ok": True,
                "url": f"http://{arguments.bind}:{observed_port}/",
                "discBytes": disc.size,
                "discSha256": disc_sha256,
                "artifacts": artifact_manifest,
                "discSemanticsInHost": False,
            },
            sort_keys=True,
        ),
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
