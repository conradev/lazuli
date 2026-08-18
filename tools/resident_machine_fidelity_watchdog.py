#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Independent hard deadline for one dedicated Chrome fidelity-evidence process."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import time
from pathlib import Path


SCHEMA = "lazuli-resident-renderer-fidelity-watchdog-v1"
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
    arguments = parser.parse_args()
    if arguments.state.exists():
        raise FileExistsError(f"watchdog state already exists: {arguments.state}")
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
    durable_state(arguments.state, armed)
    while True:
        remaining_seconds = (arguments.deadline_unix_ms - int(time.time() * 1_000)) / 1_000
        if remaining_seconds <= 0:
            break
        time.sleep(min(0.25, remaining_seconds))
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
