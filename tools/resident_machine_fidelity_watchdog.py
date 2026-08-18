#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Independent hard deadline for one dedicated Chrome fidelity-evidence process."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import stat
import subprocess
import time
from pathlib import Path


SCHEMA = "lazuli-resident-renderer-fidelity-watchdog-v1"
COMPLETION_SCHEMA = "lazuli-resident-renderer-fidelity-watchdog-completion-v1"
FIXED_WALL_MS = 600_000


def process_identity(pid: int) -> str:
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "lstart=", "-o", "command="],
        check=True,
        capture_output=True,
        text=True,
    )
    identity = result.stdout.strip()
    if not identity:
        raise ValueError(f"process {pid} is not alive")
    return identity


def durable_state(path: Path, value: dict[str, object]) -> None:
    parent = path.parent.resolve(strict=True)
    temporary = parent / f".{path.name}.{os.getpid()}.tmp"
    body = json.dumps(value, sort_keys=True, separators=(",", ":")).encode() + b"\n"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        written = 0
        while written < len(body):
            count = os.write(descriptor, body[written:])
            if count <= 0:
                raise OSError("short watchdog state write")
            written += count
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)
    parent_descriptor = os.open(parent, os.O_RDONLY)
    try:
        os.fsync(parent_descriptor)
    finally:
        os.close(parent_descriptor)


def kill_exact_browser(pid: int, identity: str) -> str:
    try:
        current = process_identity(pid)
    except (OSError, subprocess.CalledProcessError, ValueError):
        return "already-exited"
    if current != identity:
        return "identity-changed-not-killed"
    os.kill(pid, signal.SIGKILL)
    confirmation_deadline = time.monotonic() + 5
    while time.monotonic() < confirmation_deadline:
        try:
            process_identity(pid)
        except (OSError, subprocess.CalledProcessError, ValueError):
            return "sigkill-confirmed-exited"
        time.sleep(0.05)
    return "sigkill-sent-exit-not-confirmed"


def read_completion(path: Path | None, expected_url: str) -> tuple[dict[str, object], str] | None:
    if path is None:
        return None
    try:
        path.lstat()
    except FileNotFoundError:
        return None
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("watchdog completion must be a non-symlink regular file")
        if before.st_mode & 0o077:
            raise ValueError("watchdog completion must be owner-only")
        if before.st_size <= 0 or before.st_size > 4096:
            raise ValueError("watchdog completion has an invalid byte length")
        body = os.read(descriptor, 4097)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    try:
        value = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("watchdog completion is not valid JSON") from error
    if not isinstance(value, dict) or set(value) != {"schema", "status", "expectedUrl"}:
        raise ValueError("watchdog completion has an invalid exact field set")
    if value != {
        "schema": COMPLETION_SCHEMA,
        "status": "terminal-journal-validated",
        "expectedUrl": expected_url,
    }:
        raise ValueError("watchdog completion does not match the armed capture")
    if (
        (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
        != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
        or before.st_size != len(body)
        or not body
    ):
        raise ValueError("watchdog completion changed while it was read")
    return value, hashlib.sha256(body).hexdigest()


def rejected_completion_state(
    arguments: argparse.Namespace,
    armed: dict[str, object],
    browser_identity: str,
    error: BaseException,
) -> dict[str, object]:
    browser_cleanup = kill_exact_browser(arguments.browser_pid, browser_identity)
    cleanup_confirmed = browser_cleanup in {
        "already-exited",
        "sigkill-confirmed-exited",
    }
    return {
        **armed,
        "status": (
            "completion-rejected-browser-terminated"
            if cleanup_confirmed
            else "completion-rejected-browser-termination-unconfirmed"
        ),
        "completionRejectedUnixMs": int(time.time() * 1_000),
        "completionError": f"{type(error).__name__}: {error}",
        "browserCleanup": browser_cleanup,
        "serverCleanup": "left-running-for-journal-recovery-and-graceful-capture",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--start-unix-ms", type=int, required=True)
    parser.add_argument("--deadline-unix-ms", type=int, required=True)
    parser.add_argument("--browser-pid", type=int, required=True)
    parser.add_argument("--server-pid", type=int, required=True)
    parser.add_argument("--expected-url", required=True)
    parser.add_argument("--browser-identity-fragment", required=True)
    parser.add_argument("--server-identity-fragment", required=True)
    parser.add_argument("--completion", type=Path)
    arguments = parser.parse_args()
    if arguments.state.exists():
        raise FileExistsError(f"watchdog state already exists: {arguments.state}")
    if arguments.completion is not None:
        arguments.completion.parent.resolve(strict=True)
        if arguments.completion.exists():
            raise FileExistsError(
                f"watchdog completion already exists: {arguments.completion}"
            )
    if arguments.deadline_unix_ms - arguments.start_unix_ms != FIXED_WALL_MS:
        raise ValueError("watchdog deadline must be exactly start + 600000 ms")
    now = int(time.time() * 1_000)
    if arguments.start_unix_ms > now or arguments.deadline_unix_ms <= now:
        raise ValueError("watchdog must be armed after start and before the fixed deadline")
    if not arguments.expected_url.startswith("http://127.0.0.1:"):
        raise ValueError("watchdog URL must be loopback HTTP")
    browser_identity = process_identity(arguments.browser_pid)
    server_identity = process_identity(arguments.server_pid)
    if arguments.browser_identity_fragment not in browser_identity:
        raise ValueError("browser PID is not the dedicated locked-profile Chrome process")
    if arguments.server_identity_fragment not in server_identity:
        raise ValueError("server PID is not the fidelity evidence server process")
    armed = {
        "schema": SCHEMA,
        "status": "armed-before-navigation",
        "startUnixMs": arguments.start_unix_ms,
        "deadlineUnixMs": arguments.deadline_unix_ms,
        "expectedUrl": arguments.expected_url,
        "browserPid": arguments.browser_pid,
        "browserIdentity": browser_identity,
        "serverPid": arguments.server_pid,
        "serverIdentity": server_identity,
        "cleanupIndependentOfPageMainThread": True,
    }
    termination_requested = False

    def request_termination(_signum: int, _frame: object) -> None:
        nonlocal termination_requested
        termination_requested = True

    previous_sigterm_handler = signal.signal(signal.SIGTERM, request_termination)
    try:
        durable_state(arguments.state, armed)
        while True:
            if termination_requested:
                durable_state(arguments.state, {
                    **armed,
                    "status": "controller-terminated-before-completion",
                    "cleanupUnixMs": int(time.time() * 1_000),
                    "browserCleanup": "left-running-for-controller-cleanup",
                    "serverCleanup": "left-running-for-controller-cleanup",
                })
                return
            current_unix_ms = int(time.time() * 1_000)
            if current_unix_ms >= arguments.deadline_unix_ms:
                break
            try:
                completion = read_completion(arguments.completion, arguments.expected_url)
                if completion is not None:
                    current_browser = process_identity(arguments.browser_pid)
                    current_server = process_identity(arguments.server_pid)
                    if current_browser != browser_identity or current_server != server_identity:
                        raise RuntimeError(
                            "capture process identity changed before watchdog completion"
                        )
            except (OSError, subprocess.CalledProcessError, ValueError, RuntimeError) as error:
                rejected = rejected_completion_state(
                    arguments,
                    armed,
                    browser_identity,
                    error,
                )
                durable_state(arguments.state, rejected)
                raise RuntimeError(
                    f"watchdog rejected completion: {error}"
                ) from error
            if completion is not None:
                completion_unix_ms = int(time.time() * 1_000)
                if completion_unix_ms >= arguments.deadline_unix_ms:
                    break
                _, completion_sha256 = completion
                durable_state(arguments.state, {
                    **armed,
                    "status": "completed-before-deadline",
                    "completionUnixMs": completion_unix_ms,
                    "completionSha256": completion_sha256,
                    "browserCleanup": "left-running-for-next-capture",
                    "serverCleanup": "left-running-for-graceful-capture",
                })
                return
            try:
                current_browser = process_identity(arguments.browser_pid)
            except (OSError, subprocess.CalledProcessError, ValueError) as error:
                durable_state(arguments.state, {
                    **armed,
                    "status": "browser-exited-before-completion",
                    "cleanupUnixMs": int(time.time() * 1_000),
                    "browserCleanup": "already-exited",
                    "browserError": f"{type(error).__name__}: {error}",
                    "serverCleanup": "left-running-for-journal-recovery-and-graceful-capture",
                })
                raise RuntimeError("dedicated browser exited before completion") from error
            if current_browser != browser_identity:
                error = RuntimeError("browser process identity changed before completion")
                rejected = rejected_completion_state(
                    arguments,
                    armed,
                    browser_identity,
                    error,
                )
                durable_state(arguments.state, rejected)
                raise error
            remaining_seconds = (
                arguments.deadline_unix_ms - int(time.time() * 1_000)
            ) / 1_000
            if remaining_seconds <= 0:
                break
            time.sleep(min(0.25, remaining_seconds))
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm_handler)
    browser_cleanup = kill_exact_browser(arguments.browser_pid, browser_identity)
    cleanup_confirmed = browser_cleanup in {"already-exited", "sigkill-confirmed-exited"}
    durable_state(arguments.state, {
        **armed,
        "status": "deadline-enforced" if cleanup_confirmed else "deadline-enforcement-unconfirmed",
        "cleanupUnixMs": int(time.time() * 1_000),
        "browserCleanup": browser_cleanup,
        "serverCleanup": "left-running-for-journal-recovery-and-graceful-capture",
    })
    if not cleanup_confirmed:
        raise RuntimeError(f"dedicated browser termination was not confirmed: {browser_cleanup}")


if __name__ == "__main__":
    main()
