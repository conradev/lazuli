#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only

import struct
import tempfile
import unittest
from pathlib import Path

from tools.browser_boot_server import CisoReader, RawIsoReader, open_disc


DISC_MAGIC = 0xC2339F3D


def gamecube_iso(size: int = 0x10000) -> bytes:
    image = bytearray((index * 17 + 3) & 0xFF for index in range(size))
    struct.pack_into(">I", image, 0x1C, DISC_MAGIC)
    return bytes(image)


def ciso_image(logical: bytes, block_size: int, present: list[bool]) -> bytes:
    if len(logical) != len(present) * block_size:
        raise ValueError("logical image and CISO map disagree")
    header = bytearray(0x8000)
    header[:4] = b"CISO"
    struct.pack_into("<I", header, 4, block_size)
    for index, is_present in enumerate(present):
        header[8 + index] = is_present
    blocks = [
        logical[index * block_size : (index + 1) * block_size]
        for index, is_present in enumerate(present)
        if is_present
    ]
    return bytes(header) + b"".join(blocks)


class BrowserBootServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_raw_iso_reads_only_the_requested_range(self) -> None:
        image = gamecube_iso()
        path = self.root / "game.iso"
        path.write_bytes(image)

        reader = open_disc(path)
        try:
            self.assertIsInstance(reader, RawIsoReader)
            self.assertEqual(reader.read(0x1234, 0x321), image[0x1234:0x1555])
            self.assertEqual(reader.read(len(image), 0), b"")
            with self.assertRaisesRegex(ValueError, "exceeds image"):
                reader.read(len(image) - 1, 2)
        finally:
            reader.file.close()

    def test_ciso_reconstructs_present_and_sparse_blocks(self) -> None:
        block_size = 0x100
        logical = gamecube_iso(block_size * 4)
        present = [True, False, True, True]
        expected = logical[:block_size] + bytes(block_size) + logical[2 * block_size :]
        path = self.root / "game.ciso"
        path.write_bytes(ciso_image(logical, block_size, present))

        reader = open_disc(path)
        try:
            self.assertIsInstance(reader, CisoReader)
            self.assertEqual(reader.read(0x80, 0x300), expected[0x80:0x380])
            self.assertEqual(reader.read(reader.logical_size, 0), b"")
            with self.assertRaisesRegex(ValueError, "exceeds logical image"):
                reader.read(reader.logical_size, 1)
        finally:
            reader.file.close()

    def test_rejects_non_gamecube_raw_image(self) -> None:
        path = self.root / "not-a-disc.iso"
        path.write_bytes(bytes(0x40))
        with self.assertRaisesRegex(ValueError, "not a GameCube ISO"):
            open_disc(path)

    def test_rejects_truncated_ciso(self) -> None:
        logical = gamecube_iso(0x100)
        path = self.root / "truncated.ciso"
        path.write_bytes(ciso_image(logical, 0x100, [True])[:-1])
        with self.assertRaisesRegex(ValueError, "truncated CISO"):
            open_disc(path)


if __name__ == "__main__":
    unittest.main()
