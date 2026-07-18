#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Serve a browser JIT harness and lazy logical ranges from a GameCube disc."""

from __future__ import annotations

import argparse
import os
import struct
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Protocol
from urllib.parse import parse_qs, urlsplit


GAMECUBE_DISC_MAGIC = 0xC2339F3D
MAX_RANGE_LENGTH = 64 * 1024 * 1024


def _pread_exact(file_descriptor: int, length: int, offset: int) -> bytes:
    """Read an exact regular-file range without changing the shared file offset."""
    output = bytearray()
    while len(output) < length:
        chunk = os.pread(file_descriptor, length - len(output), offset + len(output))
        if not chunk:
            raise OSError("short disc image read")
        output.extend(chunk)
    return bytes(output)


class DiscReader(Protocol):
    def read(self, offset: int, length: int) -> bytes: ...


class RawIsoReader:
    def __init__(self, path: Path) -> None:
        self.file = path.open("rb")
        self.size = path.stat().st_size
        header = _pread_exact(self.file.fileno(), 0x20, 0)
        if struct.unpack_from(">I", header, 0x1C)[0] != GAMECUBE_DISC_MAGIC:
            self.file.close()
            raise ValueError(f"not a GameCube ISO: {path}")

    def read(self, offset: int, length: int) -> bytes:
        if offset < 0 or length < 0:
            raise ValueError("negative ISO range")
        if offset > self.size or length > self.size - offset:
            raise ValueError("ISO range exceeds image")
        return _pread_exact(self.file.fileno(), length, offset)


class CisoReader:
    HEADER_SIZE = 0x8000

    def __init__(self, path: Path) -> None:
        self.file = path.open("rb")
        header = self.file.read(self.HEADER_SIZE)
        if len(header) != self.HEADER_SIZE or header[:4] != b"CISO":
            self.file.close()
            raise ValueError(f"not a CISO: {path}")
        self.block_size = struct.unpack_from("<I", header, 4)[0]
        if self.block_size == 0 or self.block_size % 32 != 0:
            self.file.close()
            raise ValueError(f"invalid CISO block size: {self.block_size}")
        physical = self.HEADER_SIZE
        self.blocks: list[int | None] = []
        for present in header[8:]:
            self.blocks.append(physical if present else None)
            if present:
                physical += self.block_size
        if physical > path.stat().st_size:
            self.file.close()
            raise ValueError(f"truncated CISO: {path}")
        self.logical_size = len(self.blocks) * self.block_size

    def read(self, offset: int, length: int) -> bytes:
        if offset < 0 or length < 0:
            raise ValueError("negative CISO range")
        if offset > self.logical_size or length > self.logical_size - offset:
            raise ValueError("CISO range exceeds logical image")
        output = bytearray(length)
        position = offset
        written = 0
        while written < length:
            block = position // self.block_size
            within = position % self.block_size
            count = min(length - written, self.block_size - within)
            physical = self.blocks[block]
            if physical is None:
                position += count
                written += count
                continue

            # Adjacent present logical blocks are packed adjacently in a CISO.
            # Coalesce them into one pread instead of issuing one syscall per block.
            physical_start = physical + within
            run_length = count
            next_block = block + 1
            while run_length < length - written and next_block < len(self.blocks):
                next_physical = self.blocks[next_block]
                expected_physical = physical + (next_block - block) * self.block_size
                if next_physical != expected_physical:
                    break
                run_length += min(length - written - run_length, self.block_size)
                next_block += 1

            data = _pread_exact(self.file.fileno(), run_length, physical_start)
            output[written : written + run_length] = data
            count = run_length
            position += count
            written += count
        return bytes(output)


def open_disc(path: Path) -> DiscReader:
    with path.open("rb") as file:
        magic = file.read(4)
    if magic == b"CISO":
        return CisoReader(path)
    return RawIsoReader(path)


class BrowserBootHandler(SimpleHTTPRequestHandler):
    disc: DiscReader

    def do_GET(self) -> None:
        request = urlsplit(self.path)
        if request.path != "/disc":
            super().do_GET()
            return

        try:
            query = parse_qs(request.query, strict_parsing=True)
            offset = int(query["offset"][0], 0)
            length = int(query["length"][0], 0)
            if length > MAX_RANGE_LENGTH:
                raise ValueError("disc request exceeds 64 MiB")
            data = self.disc.read(offset, length)
        except (KeyError, OSError, ValueError) as error:
            self.send_error(400, str(error))
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, _format: str, *args: object) -> None:
        pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument(
        "--disc",
        "--ciso",
        dest="disc",
        type=Path,
        required=True,
        help="GameCube ISO or CISO (`--ciso` remains as a compatibility alias)",
    )
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    arguments = parser.parse_args()

    BrowserBootHandler.disc = open_disc(arguments.disc)
    handler = lambda *args, **kwargs: BrowserBootHandler(  # noqa: E731
        *args, directory=str(arguments.root), **kwargs
    )
    server = ThreadingHTTPServer((arguments.bind, arguments.port), handler)
    server.daemon_threads = True
    print(
        f"Serving browser boot for {arguments.disc.name} "
        f"on http://{arguments.bind}:{arguments.port}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
