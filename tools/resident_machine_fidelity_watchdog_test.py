#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import resident_machine_fidelity_watchdog as watchdog


class FidelityWatchdogCompletionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.url = (
            "http://127.0.0.1:8701/tools/resident_machine_first_frame.html"
            "?capture=fidelity&game=warioware-usa"
        )
        self.completion = self.root / "completion.json"

    def write_completion(self, **changes: object) -> None:
        value: dict[str, object] = {
            "schema": watchdog.COMPLETION_SCHEMA,
            "status": "terminal-journal-validated",
            "expectedUrl": self.url,
        }
        value.update(changes)
        self.completion.write_text(json.dumps(value, separators=(",", ":")))
        self.completion.chmod(0o600)

    def test_completion_is_exact_regular_and_capture_bound(self) -> None:
        self.assertIsNone(watchdog.read_completion(self.completion, self.url))
        self.write_completion()
        value, digest = watchdog.read_completion(self.completion, self.url) or ({}, "")
        self.assertEqual(value["expectedUrl"], self.url)
        self.assertRegex(digest, r"^[0-9a-f]{64}$")

        self.write_completion(expectedUrl=self.url + "&extra=1")
        with self.assertRaisesRegex(ValueError, "does not match"):
            watchdog.read_completion(self.completion, self.url)

        self.completion.write_bytes(b"{")
        self.completion.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "not valid JSON"):
            watchdog.read_completion(self.completion, self.url)

    def test_symlink_completion_is_rejected(self) -> None:
        target = self.root / "target.json"
        target.write_text("{}")
        self.completion.symlink_to(target)
        with self.assertRaises(OSError):
            watchdog.read_completion(self.completion, self.url)

    def test_main_disarms_after_completion_without_killing_browser(self) -> None:
        state = self.root / "state.json"
        now = 1_800_000_001_000
        start = now - 1_000
        browser_identity = f"Chrome --user-data-dir={self.root / 'profile'}"
        server_identity = "python resident_machine_fidelity_server.py"

        def identity(pid: int) -> str:
            return browser_identity if pid == 101 else server_identity

        arguments = [
            "resident_machine_fidelity_watchdog.py",
            "--state", str(state),
            "--start-unix-ms", str(start),
            "--deadline-unix-ms", str(start + watchdog.FIXED_WALL_MS),
            "--browser-pid", "101",
            "--server-pid", "202",
            "--expected-url", self.url,
            "--browser-identity-fragment", str(self.root / "profile"),
            "--server-identity-fragment", "resident_machine_fidelity_server.py",
            "--completion", str(self.completion),
        ]
        with (
            mock.patch.object(sys, "argv", arguments),
            mock.patch.object(watchdog.time, "time", return_value=now / 1_000),
            mock.patch.object(watchdog, "process_identity", side_effect=identity),
            mock.patch.object(
                watchdog,
                "read_completion",
                return_value=({"expectedUrl": self.url}, "a" * 64),
            ),
            mock.patch.object(watchdog, "kill_exact_browser") as kill_browser,
        ):
            watchdog.main()

        final = json.loads(state.read_text())
        self.assertEqual(final["status"], "completed-before-deadline")
        self.assertEqual(final["browserCleanup"], "left-running-for-next-capture")
        self.assertRegex(final["completionSha256"], r"^[0-9a-f]{64}$")
        kill_browser.assert_not_called()

    def test_main_rejects_tampered_completion_and_kills_exact_browser(self) -> None:
        browser_identity = f"Chrome --user-data-dir={self.root / 'profile'}"
        server_identity = "python resident_machine_fidelity_server.py"

        def identity(pid: int) -> str:
            return browser_identity if pid == 101 else server_identity

        for index, completion_error in enumerate((
            ValueError("watchdog completion is not valid JSON"),
            ValueError("watchdog completion does not match the armed capture"),
        )):
            with self.subTest(index=index):
                state = self.root / f"rejected-state-{index}.json"
                now = 1_800_000_001_000
                start = now - 1_000
                arguments = [
                    "resident_machine_fidelity_watchdog.py",
                    "--state", str(state),
                    "--start-unix-ms", str(start),
                    "--deadline-unix-ms", str(start + watchdog.FIXED_WALL_MS),
                    "--browser-pid", "101",
                    "--server-pid", "202",
                    "--expected-url", self.url,
                    "--browser-identity-fragment", str(self.root / "profile"),
                    "--server-identity-fragment", "resident_machine_fidelity_server.py",
                    "--completion", str(self.completion),
                ]
                with (
                    mock.patch.object(sys, "argv", arguments),
                    mock.patch.object(watchdog.time, "time", return_value=now / 1_000),
                    mock.patch.object(watchdog, "process_identity", side_effect=identity),
                    mock.patch.object(
                        watchdog,
                        "read_completion",
                        side_effect=completion_error,
                    ),
                    mock.patch.object(
                        watchdog,
                        "kill_exact_browser",
                        return_value="sigkill-confirmed-exited",
                    ) as kill_browser,
                ):
                    with self.assertRaisesRegex(RuntimeError, "rejected completion"):
                        watchdog.main()

                final = json.loads(state.read_text())
                self.assertEqual(
                    final["status"],
                    "completion-rejected-browser-terminated",
                )
                self.assertIn("completionError", final)
                kill_browser.assert_called_once_with(101, browser_identity)

    def test_late_completion_cannot_bypass_the_fixed_deadline(self) -> None:
        state = self.root / "late-state.json"
        start = 1_800_000_000_000
        initial_now = start + 1_000
        deadline = start + watchdog.FIXED_WALL_MS
        time_calls = 0

        def clock() -> float:
            nonlocal time_calls
            time_calls += 1
            return (initial_now if time_calls == 1 else deadline) / 1_000

        browser_identity = f"Chrome --user-data-dir={self.root / 'profile'}"
        server_identity = "python resident_machine_fidelity_server.py"
        arguments = [
            "resident_machine_fidelity_watchdog.py",
            "--state", str(state),
            "--start-unix-ms", str(start),
            "--deadline-unix-ms", str(deadline),
            "--browser-pid", "101",
            "--server-pid", "202",
            "--expected-url", self.url,
            "--browser-identity-fragment", str(self.root / "profile"),
            "--server-identity-fragment", "resident_machine_fidelity_server.py",
            "--completion", str(self.completion),
        ]
        with (
            mock.patch.object(sys, "argv", arguments),
            mock.patch.object(watchdog.time, "time", side_effect=clock),
            mock.patch.object(
                watchdog,
                "process_identity",
                side_effect=[browser_identity, server_identity],
            ),
            mock.patch.object(watchdog, "read_completion") as read_completion,
            mock.patch.object(
                watchdog,
                "kill_exact_browser",
                return_value="sigkill-confirmed-exited",
            ) as kill_browser,
        ):
            watchdog.main()

        final = json.loads(state.read_text())
        self.assertEqual(final["status"], "deadline-enforced")
        read_completion.assert_not_called()
        kill_browser.assert_called_once_with(101, browser_identity)

    def test_controller_termination_writes_durable_failed_state(self) -> None:
        state = self.root / "terminated-state.json"
        now = 1_800_000_001_000
        start = now - 1_000
        browser_identity = f"Chrome --user-data-dir={self.root / 'profile'}"
        server_identity = "python resident_machine_fidelity_server.py"
        arguments = [
            "resident_machine_fidelity_watchdog.py",
            "--state", str(state),
            "--start-unix-ms", str(start),
            "--deadline-unix-ms", str(start + watchdog.FIXED_WALL_MS),
            "--browser-pid", "101",
            "--server-pid", "202",
            "--expected-url", self.url,
            "--browser-identity-fragment", str(self.root / "profile"),
            "--server-identity-fragment", "resident_machine_fidelity_server.py",
            "--completion", str(self.completion),
        ]
        installed = False

        def install(_signal: int, handler: object) -> object:
            nonlocal installed
            if not installed:
                installed = True
                assert callable(handler)
                handler(watchdog.signal.SIGTERM, None)
            return watchdog.signal.SIG_DFL

        with (
            mock.patch.object(sys, "argv", arguments),
            mock.patch.object(watchdog.time, "time", return_value=now / 1_000),
            mock.patch.object(
                watchdog,
                "process_identity",
                side_effect=[browser_identity, server_identity],
            ),
            mock.patch.object(watchdog.signal, "signal", side_effect=install),
            mock.patch.object(watchdog, "kill_exact_browser") as kill_browser,
        ):
            watchdog.main()

        final = json.loads(state.read_text())
        self.assertEqual(final["status"], "controller-terminated-before-completion")
        kill_browser.assert_not_called()


if __name__ == "__main__":
    unittest.main()
