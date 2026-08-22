#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only

from __future__ import annotations

import json
import hashlib
import io
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from resident_machine_corpus_server import (
    CORPUS_PRODUCTION_EVIDENCE_LOCK_SCHEMA,
    FIDELITY_PRODUCTION_EVIDENCE_LOCK_SCHEMA,
    PRODUCTION_SOURCE_PATHS as PYTHON_PRODUCTION_SOURCE_PATHS,
    ResidentCorpusHandler,
    production_execution_assets,
)
from resident_machine_fidelity_server import (
    DURABLE_RECORD_SCHEMA,
    FidelityCheckpointError,
    FidelityCheckpointJournal,
    PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP,
    PRODUCTION_FIDELITY_EMPTY_NAVIGATION_SCRIPT_SHA256,
    PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
    PRODUCTION_FIDELITY_GAME_KEYS,
    PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
    PRODUCTION_FIDELITY_NAVIGATION_AUTHORITIES,
    PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
    PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
    canonical_json,
    locked_source_for_request,
    locked_source_snapshots,
    production_capture_policy,
    sha256_hex,
    validate_capture_run_policy,
    validate_capture_run_summary,
    validate_evidence_lock,
)


RUN_ID = "12345678-1234-4234-9234-123456789abc"
GAME_KEY = "warioware-usa"
HOST_SHA = "f" * 64
REQUEST_SHA = "a" * 64
RECEIPT_SHA = "b" * 64
MACHINE_SESSION_ID = "87654321-4321-4321-8321-cba987654321"


def navigation_policy(
    steps: list[dict[str, object]],
    game_key: str = GAME_KEY,
) -> dict[str, object]:
    return {
        "schema": "lazuli-resident-pre-baseline-navigation-v1",
        "gameKey": game_key,
        "algorithm": "locked-si-observed-not-before-publication-v1",
        "cycleOrigin": "durable-first-frame-canonical-scheduler-cycle",
        "controllerEncoding": "gamecube-packed-controller-v1",
        "targetAnchor": "prior-si-observed-cycle",
        "receiptSource": "periodic",
        "periodicSiCycles": "8108100",
        "maximumReceiptLatencyCycles": "16108100",
        "maximumPublications": PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
        "scriptSha256": sha256_hex(canonical_json(steps)),
        "steps": steps,
    }


def javascript_production_navigation_policies() -> dict[str, dict[str, object]]:
    project_root = Path(__file__).resolve().parent.parent
    javascript = subprocess.run(
        [
            "node",
            "--input-type=module",
            "--eval",
            (
                "import { PRODUCTION_FIDELITY_GAME_KEYS as keys, "
                "productionFidelityNavigationPolicy as policy } from "
                "'./tools/resident_machine_fidelity_navigation.mjs';"
                "process.stdout.write(JSON.stringify(Object.fromEntries("
                "keys.map(key => [key, policy(key)]))));"
            ),
        ],
        cwd=project_root,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(javascript.stdout)


EMPTY_NAVIGATION_POLICY = navigation_policy([])
TWO_STEP_NAVIGATION_POLICY = navigation_policy([
    {
        "minimumCanonicalDelay": "20",
        "buttons": 0x0100,
        "stickXyCxy": 0x8080_8080,
        "triggerLrab": 0x00FF_0000,
    },
    {
        "minimumCanonicalDelay": "20",
        "buttons": 0,
        "stickXyCxy": 0x8080_8080,
        "triggerLrab": 0,
    },
])
CAPTURE_RUN_POLICY = {
    "instructionUpperCap": "1000",
    "executedCycleUpperCap": "1000",
    "canonicalCycleUpperCap": "1000",
    "sliceCycleUpperCap": "10",
    "blockUpperCap": 16,
    "totalHostCallCap": 20,
    "totalColdInstallCap": 20,
    "maxBootReads": 8,
    "bootTimeoutMs": 1_000,
    "sliceTimeoutMs": 1_000,
    "runTimeoutMs": 7_200_000,
    "externalWallTimeoutMs": 7_200_000,
    "zeroProgressSliceCap": 4,
    "workerUrl": "/worker.mjs",
    "navigationPolicy": EMPTY_NAVIGATION_POLICY,
}


def capture_run_summary(
    accepted: bool = False,
    operator_publications: int = 0,
    **overrides: object,
) -> dict[str, object]:
    summary = {
        "schema": "lazuli-resident-cumulative-run-summary-v2",
        "issuedRunCalls": 2 if accepted else 0,
        "canonicalCycle": "100" if accepted else "0",
        "reportedCanonicalCycles": "100" if accepted else "0",
        "reportedExecutedCycles": "100" if accepted else "0",
        "reportedExecutedInstructions": "200" if accepted else "0",
        "reportedRetiredBlocks": "10" if accepted else "0",
        "reportedHostCalls": 2 if accepted else 0,
        "reportedColdInstalls": 0,
        "zeroProgressSlices": 0,
        "consecutiveZeroProgressSlices": 0,
        "maximumConsecutiveZeroProgressSlices": 0,
        "operatorPublications": operator_publications,
        "witnessPublications": 1 if accepted else 0,
        "elapsedWallMs": 20 if accepted else 0,
        "wallTimeoutMs": 7_200_000,
        "accepted": accepted,
    }
    summary.update(overrides)
    return summary


def progressed_run_summary(
    canonical_cycle: int,
    issued_run_calls: int,
    *,
    operator_publications: int = 0,
    witness_publications: int = 0,
    accepted: bool = False,
) -> dict[str, object]:
    return capture_run_summary(
        accepted,
        operator_publications,
        issuedRunCalls=issued_run_calls,
        canonicalCycle=str(canonical_cycle),
        reportedCanonicalCycles=str(canonical_cycle),
        reportedExecutedCycles=str(canonical_cycle),
        reportedExecutedInstructions=str(canonical_cycle * 2),
        reportedRetiredBlocks=str(issued_run_calls),
        reportedHostCalls=issued_run_calls,
        witnessPublications=witness_publications,
        elapsedWallMs=issued_run_calls * 10,
    )


def expected_si_packet(step: dict[str, object]) -> tuple[int, int]:
    buttons = int(step["buttons"])
    sticks = int(step["stickXyCxy"])
    triggers = int(step["triggerLrab"])
    word_0 = (
        ((buttons >> 8) & 0xFF) << 24
        | (((buttons & 0xFF) | 0x80) & 0xFF) << 16
        | (sticks & 0xFF) << 8
        | ((sticks >> 8) & 0xFF)
    )
    word_1 = (
        ((sticks >> 16) & 0xFF) << 24
        | ((sticks >> 24) & 0xFF) << 16
        | (triggers & 0xFF) << 8
        | ((triggers >> 8) & 0xFF)
    )
    return word_0, word_1


def common(sequence: int, kind: str) -> dict[str, object]:
    return {
        "schema": "lazuli-resident-renderer-fidelity-checkpoint-v1",
        "runId": RUN_ID,
        "gameKey": GAME_KEY,
        "clientSequence": sequence,
        "kind": kind,
    }


def identity() -> dict[str, object]:
    return {
        "relayRequestId": 7,
        "renderCallOrdinal": 3,
        "requestFlags": 4,
        "sequenceLo": 5,
        "sequenceHi": 6,
        "opaqueRequestBytes": 1024,
        "opaqueRequestSha256": REQUEST_SHA,
        "presentedBefore": False,
    }


def fidelity_artifacts(seed: str = "c") -> dict[str, object]:
    return {
        "gameFidelityEnvelopeBytes": 600,
        "gameFidelityEnvelopeSha256": seed * 64,
        "gameFidelityOpaqueBytes": 384,
        "gameFidelityOpaqueSha256": chr(ord(seed) + 1) * 64,
        "machineEvidenceEnvelopeBytes": 1200,
        "machineEvidenceEnvelopeSha256": chr(ord(seed) + 2) * 64,
        "machineEvidenceOpaqueBytes": 816,
        "machineEvidenceOpaqueSha256": chr(ord(seed) + 3) * 64,
    }


class FidelityCheckpointJournalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "checkpoints.jsonl"
        self.journal = FidelityCheckpointJournal(self.path, 16)

    def tearDown(self) -> None:
        self.journal.close()
        self.temporary.cleanup()

    def append(self, payload: object) -> dict[str, object]:
        return self.journal.append(payload, HOST_SHA, {GAME_KEY})

    def reset_capture_journal(self, name: str = "capture.jsonl") -> None:
        self.journal.close()
        self.path = Path(self.temporary.name) / name
        self.journal = FidelityCheckpointJournal(
            self.path,
            64,
            expected_run_id=RUN_ID,
            expected_game_key=GAME_KEY,
            allow_probe_events=False,
            allow_capture_annotations=True,
        )

    def append_capture_initialization(
        self,
        run_policy: dict[str, object] = CAPTURE_RUN_POLICY,
    ) -> int:
        self.append({
            **common(1, "capture-machine-initialized"),
            "machineSessionId": MACHINE_SESSION_ID,
            "bootStatus": 3,
            "bootReads": 1,
            "machineEvidenceEnvelopeBytes": 1200,
            "machineEvidenceEnvelopeSha256": "a" * 64,
            "machineEvidenceOpaqueBytes": 816,
            "machineEvidenceOpaqueSha256": "b" * 64,
            "runPolicy": run_policy,
            "runSummary": capture_run_summary(),
        })
        return 2

    def append_render(
        self,
        sequence: int,
        render_identity: dict[str, object],
    ) -> tuple[int, dict[str, object], dict[str, object]]:
        self.append({**common(sequence, "pre-submit"), **render_identity})
        self.append({
            **common(sequence + 1, "submit-returned"),
            **render_identity,
            "returnedPromise": True,
            "presentedAfterReturn": False,
        })
        ack = self.append({
            **common(sequence + 2, "receipt-resolved"),
            **render_identity,
            "receiptBytes": 64,
            "receiptSha256": RECEIPT_SHA,
            "presentedAfterResolution": True,
        })
        resolved = {
            **render_identity,
            "receiptBytes": 64,
            "receiptSha256": RECEIPT_SHA,
            "presentedAfterResolution": True,
            "receiptRecordSha256": ack["recordSha256"],
        }
        return sequence + 3, resolved, ack

    def append_capture_prefix(
        self,
        *,
        baseline_same_receipt: bool,
    ) -> tuple[
        int,
        dict[str, object],
        dict[str, object],
        dict[str, object],
        dict[str, object],
    ]:
        sequence, first_receipt, _ = self.append_render(
            self.append_capture_initialization(),
            identity(),
        )
        first_ack = self.append({
            **common(sequence, "first-frame-renderer-owned"),
            "machineSessionId": MACHINE_SESSION_ID,
            **first_receipt,
            "readbackMetadataBytes": 128,
            "readbackMetadataSha256": "1" * 64,
            "rgbaBytes": 640 * 480 * 4,
            "rgbaSha256": "2" * 64,
        })
        sequence += 1
        baseline_receipt = first_receipt
        if not baseline_same_receipt:
            later_identity = identity()
            later_identity.update(relayRequestId=8, renderCallOrdinal=4, sequenceLo=7)
            sequence, baseline_receipt, _ = self.append_render(sequence, later_identity)
        baseline_ack = self.append({
            **common(sequence, "fidelity-baseline-owned"),
            "machineSessionId": MACHINE_SESSION_ID,
            **baseline_receipt,
            "phase": 1,
            **fidelity_artifacts("3"),
            "readbackMetadataBytes": 128,
            "readbackMetadataSha256": ("7" if not baseline_same_receipt else "1") * 64,
            "rgbaBytes": 640 * 480 * 4,
            "rgbaSha256": ("8" if not baseline_same_receipt else "2") * 64,
            "requestedButtons": 0x0100,
            "requestedStickXyCxy": 0x80808080,
            "requestedTriggerLrab": 0x00FF0000,
        })
        sequence += 1
        report_ack = self.append({
            **common(sequence, "first-frame-report-bound"),
            "machineSessionId": MACHINE_SESSION_ID,
            "reportBytes": 4096,
            "reportSha256": "9" * 64,
            "machineEvidenceEnvelopeBytes": 1200,
            "machineEvidenceEnvelopeSha256": "a" * 64,
            "machineEvidenceOpaqueBytes": 816,
            "machineEvidenceOpaqueSha256": "b" * 64,
            "firstFrameRendererRecordSha256": first_ack["recordSha256"],
            "baselineRecordSha256": baseline_ack["recordSha256"],
        })
        arm_ack = self.append({
            **common(sequence + 1, "navigation-armed"),
            "machineSessionId": MACHINE_SESSION_ID,
            "firstFrameReportRecordSha256": report_ack["recordSha256"],
            "scriptSha256": EMPTY_NAVIGATION_POLICY["scriptSha256"],
            "runCallOrigin": 1,
            "canonicalCycleOrigin": "10",
            "siPollIndexOrigin": "0",
            "stepCount": 0,
            "runSummary": progressed_run_summary(10, 1),
        })
        return sequence + 2, first_receipt, baseline_ack, report_ack, arm_ack

    def append_nonempty_navigation_arm(
        self,
    ) -> tuple[int, dict[str, object], dict[str, object], dict[str, object]]:
        run_policy = {**CAPTURE_RUN_POLICY, "navigationPolicy": TWO_STEP_NAVIGATION_POLICY}
        sequence, first_receipt, _ = self.append_render(
            self.append_capture_initialization(run_policy),
            identity(),
        )
        first_ack = self.append({
            **common(sequence, "first-frame-renderer-owned"),
            "machineSessionId": MACHINE_SESSION_ID,
            **first_receipt,
            "readbackMetadataBytes": 128,
            "readbackMetadataSha256": "1" * 64,
            "rgbaBytes": 640 * 480 * 4,
            "rgbaSha256": "2" * 64,
        })
        report_ack = self.append({
            **common(sequence + 1, "first-frame-report-bound"),
            "machineSessionId": MACHINE_SESSION_ID,
            "reportBytes": 4096,
            "reportSha256": "9" * 64,
            "machineEvidenceEnvelopeBytes": 1200,
            "machineEvidenceEnvelopeSha256": "a" * 64,
            "machineEvidenceOpaqueBytes": 816,
            "machineEvidenceOpaqueSha256": "b" * 64,
            "firstFrameRendererRecordSha256": first_ack["recordSha256"],
            "baselineRecordSha256": None,
        })
        arm_ack = self.append({
            **common(sequence + 2, "navigation-armed"),
            "machineSessionId": MACHINE_SESSION_ID,
            "firstFrameReportRecordSha256": report_ack["recordSha256"],
            "scriptSha256": TWO_STEP_NAVIGATION_POLICY["scriptSha256"],
            "runCallOrigin": 1,
            "canonicalCycleOrigin": "10",
            "siPollIndexOrigin": "0",
            "stepCount": 2,
            "runSummary": progressed_run_summary(10, 1),
        })
        return sequence + 3, first_receipt, report_ack, arm_ack

    def append_navigation_step(
        self,
        sequence: int,
        report_ack: dict[str, object],
        arm_ack: dict[str, object],
        step_index: int,
        prior_observed_cycle: int,
        **overrides: object,
    ) -> tuple[int, dict[str, object], int]:
        step = TWO_STEP_NAVIGATION_POLICY["steps"][step_index]
        assert isinstance(step, dict)
        target = prior_observed_cycle + int(step["minimumCanonicalDelay"])
        publication = target + step_index + 1
        scheduled = publication + 1
        observed = scheduled + 1
        packet_word_0, packet_word_1 = expected_si_packet(step)
        payload = {
            **common(sequence, "navigation-step-received"),
            "machineSessionId": MACHINE_SESSION_ID,
            "firstFrameReportRecordSha256": report_ack["recordSha256"],
            "navigationArmRecordSha256": arm_ack["recordSha256"],
            "scriptSha256": TWO_STEP_NAVIGATION_POLICY["scriptSha256"],
            "runCallOrigin": 1,
            "canonicalCycleOrigin": "10",
            "stepIndex": step_index,
            "sequenceLo": step_index + 1,
            "sequenceHi": 0,
            "minimumCanonicalDelay": step["minimumCanonicalDelay"],
            "targetCanonicalCycle": str(target),
            "publicationCanonicalCycle": str(publication),
            "publicationOvershootCycles": str(step_index + 1),
            "buttons": step["buttons"],
            "stickXyCxy": step["stickXyCxy"],
            "triggerLrab": step["triggerLrab"],
            "status": 1,
            "siPollIndex": str(step_index + 1),
            "siScheduledCycle": str(scheduled),
            "siObservedCycle": str(observed),
            "siAppliedSequenceLo": step_index + 1,
            "siAppliedSequenceHi": 0,
            "siPacketWord0": packet_word_0,
            "siPacketWord1": packet_word_1,
            "siSource": 0,
            "priorSiPollIndex": str(step_index),
            "siControllerMode": 3,
            "siButtons": step["buttons"],
            "siStickXyCxy": step["stickXyCxy"],
            "siTriggerLrab": step["triggerLrab"],
            "runSummary": progressed_run_summary(
                observed,
                step_index + 2,
                operator_publications=step_index + 1,
            ),
            **overrides,
        }
        acknowledgement = self.append(payload)
        return sequence + 1, acknowledgement, observed

    def test_capture_initialization_requires_complete_boot_within_locked_cap(self) -> None:
        self.reset_capture_journal()
        initialization = {
            **common(1, "capture-machine-initialized"),
            "machineSessionId": MACHINE_SESSION_ID,
            "bootStatus": 3,
            "bootReads": 1,
            "machineEvidenceEnvelopeBytes": 1200,
            "machineEvidenceEnvelopeSha256": "a" * 64,
            "machineEvidenceOpaqueBytes": 816,
            "machineEvidenceOpaqueSha256": "b" * 64,
            "runPolicy": CAPTURE_RUN_POLICY,
            "runSummary": capture_run_summary(),
        }
        for changed_fields in (
            {"bootStatus": 1},
            {"bootReads": CAPTURE_RUN_POLICY["maxBootReads"] + 1},
        ):
            with self.assertRaisesRegex(FidelityCheckpointError, "bootStatus|bootReads|boot authority"):
                self.append({**initialization, **changed_fields})
            self.assertEqual(self.path.stat().st_size, 0)
            self.assertIsNone(self.journal.machine_session_id)
        self.append(initialization)
        self.assertEqual(self.journal.machine_session_id, MACHINE_SESSION_ID)

    def test_hash_chain_preserves_return_before_receipt(self) -> None:
        payloads = [
            {**common(1, "pre-submit"), **identity()},
            {
                **common(2, "renderer-probe-event"),
                "relayRequestId": 7,
                "renderCallOrdinal": 3,
                "words": [1, 2, 3, 4, 5, 6],
            },
            {
                **common(3, "submit-returned"),
                **identity(),
                "returnedPromise": True,
                "presentedAfterReturn": False,
            },
            {
                **common(4, "renderer-probe-event"),
                "relayRequestId": 7,
                "renderCallOrdinal": 3,
                "words": [7, 8, 9, 10, 11, 12],
            },
            {
                **common(5, "receipt-resolved"),
                **identity(),
                "receiptBytes": 64,
                "receiptSha256": RECEIPT_SHA,
                "presentedAfterResolution": True,
            },
        ]
        acknowledgements = [self.append(payload) for payload in payloads]
        self.journal.close()
        records = [json.loads(line) for line in self.path.read_text().splitlines()]
        self.assertEqual([record["payload"]["kind"] for record in records], [
            "pre-submit",
            "renderer-probe-event",
            "submit-returned",
            "renderer-probe-event",
            "receipt-resolved",
        ])
        previous = None
        for index, record in enumerate(records, start=1):
            self.assertEqual(record["schema"], DURABLE_RECORD_SCHEMA)
            self.assertEqual(record["serverSequence"], index)
            self.assertEqual(record["evidenceLockSha256"], "e" * 64)
            self.assertEqual(record["previousRecordSha256"], previous)
            self.assertEqual(
                record["payloadSha256"],
                sha256_hex(canonical_json(record["payload"])),
            )
            core = dict(record)
            record_sha = core.pop("recordSha256")
            self.assertEqual(record_sha, sha256_hex(canonical_json(core)))
            self.assertEqual(acknowledgements[index - 1]["recordSha256"], record_sha)
            previous = record_sha
        self.assertIsNone(self.journal.open_submission)

    def test_submit_returned_cannot_skip_pre_submit(self) -> None:
        with self.assertRaisesRegex(FidelityCheckpointError, "no matching pre-submit"):
            self.append({
                **common(1, "submit-returned"),
                **identity(),
                "returnedPromise": True,
                "presentedAfterReturn": False,
            })

    def test_receipt_requires_exact_returned_identity(self) -> None:
        self.append({**common(1, "pre-submit"), **identity()})
        self.append({
            **common(2, "submit-returned"),
            **identity(),
            "returnedPromise": True,
            "presentedAfterReturn": False,
        })
        changed = identity()
        changed["sequenceLo"] = 99
        with self.assertRaisesRegex(FidelityCheckpointError, "identity changed"):
            self.append({
                **common(3, "receipt-resolved"),
                **changed,
                "receiptBytes": 64,
                "receiptSha256": RECEIPT_SHA,
                "presentedAfterResolution": True,
            })

    def test_journal_is_exclusively_created(self) -> None:
        with self.assertRaises(FileExistsError):
            FidelityCheckpointJournal(self.path, 16)

    def test_probe_event_cap_is_independently_enforced(self) -> None:
        self.journal.close()
        capped_path = Path(self.temporary.name) / "probe-capped.jsonl"
        self.journal = FidelityCheckpointJournal(capped_path, 16, 1)
        self.append({**common(1, "pre-submit"), **identity()})
        self.append({
            **common(2, "renderer-probe-event"),
            "relayRequestId": 7,
            "renderCallOrdinal": 3,
            "words": [1, 2, 3, 4, 5, 6],
        })
        with self.assertRaisesRegex(FidelityCheckpointError, "probe event cap"):
            self.append({
                **common(3, "renderer-probe-event"),
                "relayRequestId": 7,
                "renderCallOrdinal": 3,
                "words": [7, 8, 9, 10, 11, 12],
            })

    def test_probe_event_per_submission_cap_is_independently_enforced(self) -> None:
        self.append({**common(1, "pre-submit"), **identity()})
        self.journal.probe_events_this_submission = 402
        with self.assertRaisesRegex(FidelityCheckpointError, "per-submission cap"):
            self.append({
                **common(2, "renderer-probe-event"),
                "relayRequestId": 7,
                "renderCallOrdinal": 3,
                "words": [1, 2, 3, 4, 5, 6],
            })

    def test_production_default_off_journal_forbids_injected_probe_events(self) -> None:
        self.journal.close()
        production_path = Path(self.temporary.name) / "production.jsonl"
        self.journal = FidelityCheckpointJournal(
            production_path,
            16,
            expected_run_id=RUN_ID,
            expected_game_key=GAME_KEY,
            allow_probe_events=False,
        )
        self.append({**common(1, "pre-submit"), **identity()})
        with self.assertRaisesRegex(FidelityCheckpointError, "forbidden"):
            self.append({
                **common(2, "renderer-probe-event"),
                "relayRequestId": 7,
                "renderCallOrdinal": 3,
                "words": [1, 2, 3, 4, 5, 6],
            })
        self.append({
            **common(2, "submit-returned"),
            **identity(),
            "returnedPromise": True,
            "presentedAfterReturn": False,
        })
        self.append({
            **common(3, "receipt-resolved"),
            **identity(),
            "receiptBytes": 64,
            "receiptSha256": RECEIPT_SHA,
            "presentedAfterResolution": True,
        })
        self.assertIsNone(self.journal.open_submission)
        self.assertEqual(self.journal.probe_events, 0)

    def test_continuous_capture_accepts_same_and_distinct_baseline_receipts(self) -> None:
        for same_receipt in (True, False):
            with self.subTest(same_receipt=same_receipt):
                self.reset_capture_journal(f"capture-{same_receipt}.jsonl")
                sequence, _, baseline_ack, report_ack, arm_ack = self.append_capture_prefix(
                    baseline_same_receipt=same_receipt
                )
                self.assertLess(
                    baseline_ack["serverSequence"],
                    arm_ack["serverSequence"],
                )
                witness_ack = self.append({
                    **common(sequence, "controller-witness-published"),
                    "machineSessionId": MACHINE_SESSION_ID,
                    "baselineRecordSha256": baseline_ack["recordSha256"],
                    "firstFrameReportRecordSha256": report_ack["recordSha256"],
                    "sequenceLo": 1,
                    "sequenceHi": 0,
                    "buttons": 0x0100,
                    "stickXyCxy": 0x80808080,
                    "triggerLrab": 0x00FF0000,
                    "status": 1,
                    "machineEvidenceEnvelopeBytes": 1200,
                    "machineEvidenceEnvelopeSha256": "c" * 64,
                    "machineEvidenceOpaqueBytes": 816,
                    "machineEvidenceOpaqueSha256": "d" * 64,
                    "navigationScriptSha256": EMPTY_NAVIGATION_POLICY["scriptSha256"],
                    "navigationStepCount": 0,
                    "navigationArmRecordSha256": arm_ack["recordSha256"],
                    "lastNavigationStepRecordSha256": None,
                    "runSummary": progressed_run_summary(
                        10, 2, witness_publications=1
                    ),
                })
                sequence += 1
                accepted_identity = identity()
                accepted_identity.update(relayRequestId=9, renderCallOrdinal=5, sequenceLo=8)
                sequence, accepted_receipt, _ = self.append_render(sequence, accepted_identity)
                artifacts = fidelity_artifacts("c")
                accepted_ack = self.append({
                    **common(sequence, "fidelity-accepted-owned"),
                    "machineSessionId": MACHINE_SESSION_ID,
                    **accepted_receipt,
                    "phase": 5,
                    **artifacts,
                    "readbackMetadataBytes": 128,
                    "readbackMetadataSha256": "7" * 64,
                    "rgbaBytes": 640 * 480 * 4,
                    "rgbaSha256": "8" * 64,
                    "witnessRecordSha256": witness_ack["recordSha256"],
                })
                terminal = self.append({
                    **common(sequence + 1, "fidelity-terminal"),
                    "machineSessionId": MACHINE_SESSION_ID,
                    "phase": 5,
                    "baselineRecordSha256": baseline_ack["recordSha256"],
                    "acceptedRecordSha256": accepted_ack["recordSha256"],
                    **artifacts,
                    "runSummary": progressed_run_summary(
                        100, 4, witness_publications=1, accepted=True
                    ),
                    "navigationScriptSha256": EMPTY_NAVIGATION_POLICY["scriptSha256"],
                    "navigationStepCount": 0,
                    "navigationArmRecordSha256": arm_ack["recordSha256"],
                    "lastNavigationStepRecordSha256": None,
                })
                self.assertEqual(self.journal.terminal_record_sha256, terminal["recordSha256"])
                with self.assertRaisesRegex(FidelityCheckpointError, "terminal"):
                    self.append({**common(sequence + 2, "pre-submit"), **identity()})

    def test_nonempty_navigation_requires_repeated_receipts_before_baseline(self) -> None:
        self.reset_capture_journal("navigation-valid.jsonl")
        sequence, _, report_ack, arm_ack = self.append_nonempty_navigation_arm()
        step_acks: list[dict[str, object]] = []
        observed = 10
        for step_index in range(2):
            sequence, step_ack, observed = self.append_navigation_step(
                sequence,
                report_ack,
                arm_ack,
                step_index,
                observed,
            )
            step_acks.append(step_ack)
        baseline_identity = identity()
        baseline_identity.update(relayRequestId=8, renderCallOrdinal=4, sequenceLo=7)
        sequence, baseline_receipt, _ = self.append_render(sequence, baseline_identity)
        baseline_ack = self.append({
            **common(sequence, "fidelity-baseline-owned"),
            "machineSessionId": MACHINE_SESSION_ID,
            **baseline_receipt,
            "phase": 1,
            **fidelity_artifacts("3"),
            "readbackMetadataBytes": 128,
            "readbackMetadataSha256": "7" * 64,
            "rgbaBytes": 640 * 480 * 4,
            "rgbaSha256": "8" * 64,
            "requestedButtons": 0x0100,
            "requestedStickXyCxy": 0x80808080,
            "requestedTriggerLrab": 0x00FF0000,
        })
        self.assertLess(arm_ack["serverSequence"], step_acks[0]["serverSequence"])
        self.assertLess(step_acks[1]["serverSequence"], baseline_ack["serverSequence"])
        self.assertEqual(len(self.journal.navigation_transcript), 2)

        with self.assertRaisesRegex(
            FidelityCheckpointError,
            "complete durable navigation transcript|navigation authority",
        ):
            self.append({
                **common(sequence + 1, "controller-witness-published"),
                "machineSessionId": MACHINE_SESSION_ID,
                "baselineRecordSha256": baseline_ack["recordSha256"],
                "firstFrameReportRecordSha256": report_ack["recordSha256"],
                "sequenceLo": 1,
                "sequenceHi": 0,
                "buttons": 0x0100,
                "stickXyCxy": 0x80808080,
                "triggerLrab": 0x00FF0000,
                "status": 1,
                "machineEvidenceEnvelopeBytes": 1200,
                "machineEvidenceEnvelopeSha256": "c" * 64,
                "machineEvidenceOpaqueBytes": 816,
                "machineEvidenceOpaqueSha256": "d" * 64,
                "navigationScriptSha256": TWO_STEP_NAVIGATION_POLICY["scriptSha256"],
                "navigationStepCount": 1,
                "navigationArmRecordSha256": arm_ack["recordSha256"],
                "lastNavigationStepRecordSha256": step_acks[-1]["recordSha256"],
                "runSummary": progressed_run_summary(
                    observed,
                    4,
                    operator_publications=2,
                    witness_publications=1,
                ),
            })

        self.reset_capture_journal("navigation-incomplete.jsonl")
        sequence, _, report_ack, arm_ack = self.append_nonempty_navigation_arm()
        sequence, _, _ = self.append_navigation_step(
            sequence, report_ack, arm_ack, 0, 10
        )
        baseline_identity = identity()
        baseline_identity.update(relayRequestId=8, renderCallOrdinal=4, sequenceLo=7)
        sequence, baseline_receipt, _ = self.append_render(sequence, baseline_identity)
        with self.assertRaisesRegex(FidelityCheckpointError, "complete locked navigation transcript"):
            self.append({
                **common(sequence, "fidelity-baseline-owned"),
                "machineSessionId": MACHINE_SESSION_ID,
                **baseline_receipt,
                "phase": 1,
                **fidelity_artifacts("3"),
                "readbackMetadataBytes": 128,
                "readbackMetadataSha256": "7" * 64,
                "rgbaBytes": 4,
                "rgbaSha256": "8" * 64,
                "requestedButtons": 0x0100,
                "requestedStickXyCxy": 0x80808080,
                "requestedTriggerLrab": 0x00FF0000,
            })

        self.reset_capture_journal("navigation-tamper.jsonl")
        sequence, _, report_ack, arm_ack = self.append_nonempty_navigation_arm()
        sequence, _, observed = self.append_navigation_step(
            sequence, report_ack, arm_ack, 0, 10
        )
        with self.assertRaisesRegex(FidelityCheckpointError, "chronology|controller state"):
            self.append_navigation_step(
                sequence,
                report_ack,
                arm_ack,
                1,
                observed,
                targetCanonicalCycle="54",
            )
        with self.assertRaisesRegex(FidelityCheckpointError, "script order"):
            self.append_navigation_step(
                sequence,
                report_ack,
                arm_ack,
                1,
                observed,
                stepIndex=0,
            )
        self.assertEqual(len(self.journal.navigation_transcript), 1)

    def test_capture_annotations_reject_splices_cardinality_and_bad_joins(self) -> None:
        self.reset_capture_journal()
        sequence, first_receipt, _ = self.append_render(
            self.append_capture_initialization(),
            identity(),
        )
        changed = dict(first_receipt)
        changed["receiptSha256"] = "0" * 64
        with self.assertRaisesRegex(FidelityCheckpointError, "identity changed"):
            self.append({
                **common(sequence, "first-frame-renderer-owned"),
                "machineSessionId": MACHINE_SESSION_ID,
                **changed,
                "readbackMetadataBytes": 128,
                "readbackMetadataSha256": "1" * 64,
                "rgbaBytes": 4,
                "rgbaSha256": "2" * 64,
            })
        first_ack = self.append({
            **common(sequence, "first-frame-renderer-owned"),
            "machineSessionId": MACHINE_SESSION_ID,
            **first_receipt,
            "readbackMetadataBytes": 128,
            "readbackMetadataSha256": "1" * 64,
            "rgbaBytes": 4,
            "rgbaSha256": "2" * 64,
        })
        with self.assertRaisesRegex(FidelityCheckpointError, "more than once"):
            self.append({
                **common(sequence + 1, "first-frame-renderer-owned"),
                "machineSessionId": MACHINE_SESSION_ID,
                **first_receipt,
                "readbackMetadataBytes": 128,
                "readbackMetadataSha256": "1" * 64,
                "rgbaBytes": 4,
                "rgbaSha256": "2" * 64,
            })
        with self.assertRaisesRegex(FidelityCheckpointError, "same-receipt Baseline"):
            self.append({
                **common(sequence + 1, "fidelity-baseline-owned"),
                "machineSessionId": MACHINE_SESSION_ID,
                **first_receipt,
                "phase": 1,
                **fidelity_artifacts("3"),
                "readbackMetadataBytes": 128,
                "readbackMetadataSha256": "1" * 64,
                "rgbaBytes": 4,
                "rgbaSha256": "0" * 64,
                "requestedButtons": 0x0100,
                "requestedStickXyCxy": 0x80808080,
                "requestedTriggerLrab": 0x00FF0000,
            })
        self.append({**common(sequence + 1, "pre-submit"), **identity()})
        with self.assertRaisesRegex(FidelityCheckpointError, "no open submission"):
            self.append({
                **common(sequence + 2, "first-frame-report-bound"),
                "machineSessionId": MACHINE_SESSION_ID,
                "reportBytes": 10,
                "reportSha256": "3" * 64,
                "machineEvidenceEnvelopeBytes": 20,
                "machineEvidenceEnvelopeSha256": "4" * 64,
                "machineEvidenceOpaqueBytes": 816,
                "machineEvidenceOpaqueSha256": "5" * 64,
                "firstFrameRendererRecordSha256": first_ack["recordSha256"],
                "baselineRecordSha256": None,
            })

    def test_capture_terminal_rejects_artifact_substitution(self) -> None:
        self.reset_capture_journal()
        sequence, _, baseline_ack, report_ack, arm_ack = self.append_capture_prefix(
            baseline_same_receipt=True
        )
        witness_ack = self.append({
            **common(sequence, "controller-witness-published"),
            "machineSessionId": MACHINE_SESSION_ID,
            "baselineRecordSha256": baseline_ack["recordSha256"],
            "firstFrameReportRecordSha256": report_ack["recordSha256"],
            "sequenceLo": 1,
            "sequenceHi": 0,
            "buttons": 0x0100,
            "stickXyCxy": 0x80808080,
            "triggerLrab": 0x00FF0000,
            "status": 1,
            "machineEvidenceEnvelopeBytes": 1200,
            "machineEvidenceEnvelopeSha256": "c" * 64,
            "machineEvidenceOpaqueBytes": 816,
            "machineEvidenceOpaqueSha256": "d" * 64,
            "navigationScriptSha256": EMPTY_NAVIGATION_POLICY["scriptSha256"],
            "navigationStepCount": 0,
            "navigationArmRecordSha256": arm_ack["recordSha256"],
            "lastNavigationStepRecordSha256": None,
            "runSummary": progressed_run_summary(10, 2, witness_publications=1),
        })
        sequence += 1
        accepted_identity = identity()
        accepted_identity.update(relayRequestId=10, renderCallOrdinal=6, sequenceLo=9)
        sequence, receipt, _ = self.append_render(sequence, accepted_identity)
        artifacts = fidelity_artifacts("c")
        accepted_ack = self.append({
            **common(sequence, "fidelity-accepted-owned"),
            "machineSessionId": MACHINE_SESSION_ID,
            **receipt,
            "phase": 5,
            **artifacts,
            "readbackMetadataBytes": 128,
            "readbackMetadataSha256": "7" * 64,
            "rgbaBytes": 4,
            "rgbaSha256": "8" * 64,
            "witnessRecordSha256": witness_ack["recordSha256"],
        })
        substituted = dict(artifacts)
        substituted["machineEvidenceOpaqueSha256"] = "0" * 64
        with self.assertRaisesRegex(FidelityCheckpointError, "hard Accepted"):
            self.append({
                **common(sequence + 1, "fidelity-terminal"),
                "machineSessionId": MACHINE_SESSION_ID,
                "phase": 5,
                "baselineRecordSha256": baseline_ack["recordSha256"],
                "acceptedRecordSha256": accepted_ack["recordSha256"],
                **substituted,
                "runSummary": progressed_run_summary(
                    100, 4, witness_publications=1, accepted=True
                ),
                "navigationScriptSha256": EMPTY_NAVIGATION_POLICY["scriptSha256"],
                "navigationStepCount": 0,
                "navigationArmRecordSha256": arm_ack["recordSha256"],
                "lastNavigationStepRecordSha256": None,
            })

    def test_locked_source_snapshot_survives_mutation_after_start(self) -> None:
        source = Path(self.temporary.name) / "tool.mjs"
        source.write_bytes(b"frozen source\n")
        records = {
            "tool.mjs": {
                "bytes": source.stat().st_size,
                "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            }
        }
        snapshots = locked_source_snapshots(Path(self.temporary.name), records)
        source.write_bytes(b"mutated bytes\n")
        self.assertEqual(snapshots["tool.mjs"], b"frozen source\n")

    def test_production_corpus_freezes_sources_and_exact_packaged_execution(self) -> None:
        workspace = Path(self.temporary.name) / "workspace"
        source_names = tuple(sorted(
            PYTHON_PRODUCTION_SOURCE_PATHS[CORPUS_PRODUCTION_EVIDENCE_LOCK_SCHEMA]
        ))
        source_records: dict[str, dict[str, object]] = {}
        source_bodies: dict[str, bytes] = {}
        for index, relative in enumerate(source_names):
            source = workspace / relative
            source.parent.mkdir(parents=True, exist_ok=True)
            body = f"locked source {index}\n".encode()
            source.write_bytes(body)
            source_bodies[relative] = body
            source_records[relative] = {
                "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
            }
        package_paths: dict[str, Path] = {}
        descriptors: dict[str, dict[str, object]] = {}
        for role in (
            "core",
            "dispatcher",
            "coordinator",
            "adapter",
            "worker",
            "frontend",
            "rendererJavascript",
            "rendererWasm",
        ):
            if role == "rendererJavascript":
                body = (
                    "const wasm = new URL('/assets/renderer-dependency.wasm', "
                    "import.meta.url);\n"
                ).encode()
            else:
                body = f"packaged {role}\n".encode()
            package_path = Path(self.temporary.name) / f"{role}.bin"
            package_path.write_bytes(body)
            package_paths[role] = package_path
            url = {
                "rendererJavascript": "/assets/renderer.js",
                "rendererWasm": "/assets/renderer-dependency.wasm",
            }.get(role, f"/assets/{role}.bin")
            descriptors[role] = {
                "url": url,
                "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
            }
        artifact_paths = {
            "browser_machine.wasm": package_paths["core"],
            "resident_dispatcher.wasm": package_paths["dispatcher"],
            "core_run_coordinator.wasm": package_paths["coordinator"],
            "browser_renderer.js": package_paths["rendererJavascript"],
            "browser_renderer_bg.wasm": package_paths["rendererWasm"],
        }
        authority = {
            "schema": "lazuli-resident-corpus-evidence-lock-v2",
            "sources": source_records,
            "release": {"executionAssets": descriptors},
        }
        authority_path = Path(self.temporary.name) / "corpus-lock.json"
        authority_path.write_text(json.dumps(authority))
        _, served, snapshots = production_execution_assets(
            authority_path,
            package_paths["adapter"],
            package_paths["worker"],
            package_paths["frontend"],
            workspace,
            artifact_paths,
        )
        self.assertEqual(set(served), {
            descriptor["url"] for descriptor in descriptors.values()
        })
        class RouteHandler(ResidentCorpusHandler):
            execution_assets = served
            authority_lock_bytes = b"{}\n"
            production_source_snapshots = snapshots

        def route(path: str) -> bytes:
            handler = object.__new__(RouteHandler)
            handler.path = path
            handler.command = "GET"
            handler.request_version = "HTTP/1.1"
            handler.requestline = f"GET {path} HTTP/1.1"
            handler.wfile = io.BytesIO()
            handler.serve()
            response = handler.wfile.getvalue()
            self.assertIn(b"200 OK", response)
            return response.split(b"\r\n\r\n", 1)[1]

        renderer_js = route(str(descriptors["rendererJavascript"]["url"]))
        self.assertIn(descriptors["rendererWasm"]["url"].encode(), renderer_js)
        self.assertEqual(
            route(str(descriptors["rendererWasm"]["url"])),
            package_paths["rendererWasm"].read_bytes(),
        )
        for relative, original in source_bodies.items():
            (workspace / relative).write_bytes(b"mutated after server start\n")
            self.assertEqual(snapshots[relative], original)
        for relative, original in source_bodies.items():
            (workspace / relative).write_bytes(original)

        for role in descriptors:
            original = package_paths[role].read_bytes()
            package_paths[role].write_bytes(f"substituted {role}\n".encode())
            self.assertFalse(served[str(descriptors[role]["url"])].unchanged())
            with self.assertRaisesRegex(ValueError, f"packaged {role} bytes"):
                production_execution_assets(
                    authority_path,
                    package_paths["adapter"],
                    package_paths["worker"],
                    package_paths["frontend"],
                    workspace,
                    artifact_paths,
                )
            package_paths[role].write_bytes(original)

    def test_v2_and_v3_production_source_membership_matches_javascript_golden(self) -> None:
        project_root = Path(__file__).resolve().parent.parent
        javascript = subprocess.run(
            [
                "node",
                "--input-type=module",
                "--eval",
                (
                    "import { PRODUCTION_SOURCE_PATHS } from "
                    "'./tools/resident_machine_fidelity_lock.mjs';"
                    "process.stdout.write(JSON.stringify(PRODUCTION_SOURCE_PATHS));"
                ),
            ],
            cwd=project_root,
            check=True,
            capture_output=True,
            text=True,
        )
        javascript_paths = json.loads(javascript.stdout)
        self.assertIsInstance(javascript_paths, list)
        self.assertEqual(len(javascript_paths), len(set(javascript_paths)))
        for schema in (
            CORPUS_PRODUCTION_EVIDENCE_LOCK_SCHEMA,
            FIDELITY_PRODUCTION_EVIDENCE_LOCK_SCHEMA,
        ):
            self.assertEqual(
                set(javascript_paths),
                PYTHON_PRODUCTION_SOURCE_PATHS[schema],
            )

        workspace = Path(self.temporary.name) / "v3-workspace"
        source_records: dict[str, dict[str, object]] = {}
        for index, relative in enumerate(javascript_paths):
            source = workspace / relative
            source.parent.mkdir(parents=True, exist_ok=True)
            body = f"v3 production source {index}: {relative}\n".encode()
            source.write_bytes(body)
            source_records[relative] = {
                "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
            }

        package_paths: dict[str, Path] = {}
        descriptors: dict[str, dict[str, object]] = {}
        for role in (
            "core",
            "dispatcher",
            "coordinator",
            "adapter",
            "worker",
            "frontend",
            "rendererJavascript",
            "rendererWasm",
        ):
            body = f"v3 packaged {role}\n".encode()
            package_path = Path(self.temporary.name) / f"v3-{role}.bin"
            package_path.write_bytes(body)
            package_paths[role] = package_path
            descriptors[role] = {
                "url": f"/assets/v3-{role}.bin",
                "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
            }
        artifact_paths = {
            "browser_machine.wasm": package_paths["core"],
            "resident_dispatcher.wasm": package_paths["dispatcher"],
            "core_run_coordinator.wasm": package_paths["coordinator"],
            "browser_renderer.js": package_paths["rendererJavascript"],
            "browser_renderer_bg.wasm": package_paths["rendererWasm"],
        }
        authority = {
            "schema": FIDELITY_PRODUCTION_EVIDENCE_LOCK_SCHEMA,
            "sources": source_records,
            "release": {"executionAssets": descriptors},
        }
        authority_path = Path(self.temporary.name) / "v3-production-lock.json"

        def write_authority() -> None:
            authority_path.write_text(json.dumps(authority))

        write_authority()
        _, served, snapshots = production_execution_assets(
            authority_path,
            package_paths["adapter"],
            package_paths["worker"],
            package_paths["frontend"],
            workspace,
            artifact_paths,
        )
        self.assertEqual(len(served), 8)
        self.assertEqual(set(snapshots), set(javascript_paths))

        authority["sources"]["tools/untrusted-extra.mjs"] = {
            "bytes": 1,
            "sha256": "f" * 64,
        }
        write_authority()
        with self.assertRaisesRegex(ValueError, "invalid exact production source set"):
            production_execution_assets(
                authority_path,
                package_paths["adapter"],
                package_paths["worker"],
                package_paths["frontend"],
                workspace,
                artifact_paths,
            )
        del authority["sources"]["tools/untrusted-extra.mjs"]

        missing = javascript_paths[-1]
        del authority["sources"][missing]
        write_authority()
        with self.assertRaisesRegex(ValueError, "invalid exact production source set"):
            production_execution_assets(
                authority_path,
                package_paths["adapter"],
                package_paths["worker"],
                package_paths["frontend"],
                workspace,
                artifact_paths,
            )

    def test_evidence_lock_requires_exact_v2_machine_evidence_policy(self) -> None:
        lock = {
            "schema": "lazuli-resident-renderer-fidelity-evidence-lock-v2",
            "evidenceMode": (
                "first-renderer-owned-presented-xfb-with-durable-probe-checkpoints-"
                "and-machine-evidence-v1"
            ),
            "corpus": {},
            "selectedGame": {},
            "artifacts": {},
            "sources": {},
            "hostPolicy": {},
            "runPolicy": {},
            "checkpointPolicy": {},
            "rendererProbe": {},
            "machineEvidence": {
                "abiVersion": 1,
                "byteLength": 816,
                "wordLength": 204,
                "tag": "LZME",
                "encoding": "base64",
                "browserWordInterpretations": 0,
            },
        }
        self.assertIs(validate_evidence_lock(lock), lock)
        for mutate in (
            lambda value: value.update(schema="lazuli-resident-renderer-fidelity-evidence-lock-v1"),
            lambda value: value["machineEvidence"].update(byteLength=812),
            lambda value: value.update(extra=True),
        ):
            changed = json.loads(json.dumps(lock))
            mutate(changed)
            with self.assertRaises(ValueError):
                validate_evidence_lock(changed)

    def test_production_run_authority_matches_javascript_and_summary_bounds(self) -> None:
        project_root = Path(__file__).resolve().parent.parent
        javascript = subprocess.run(
            [
                "node",
                "--input-type=module",
                "--eval",
                (
                    "import { PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP as cycle, "
                    "PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP as canonical, "
                    "PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP as instruction, "
                    "PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP as operator, "
                    "PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP as cold } from "
                    "'./tools/resident_machine_fidelity_checkpoints.mjs';"
                    "process.stdout.write(JSON.stringify({cycle, canonical, instruction, "
                    "operator, cold}));"
                ),
            ],
            cwd=project_root,
            check=True,
            capture_output=True,
            text=True,
        )
        javascript_authority = json.loads(javascript.stdout)
        self.assertEqual(
            int(javascript_authority["cycle"]),
            PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
        )
        self.assertEqual(
            int(javascript_authority["canonical"]),
            PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP,
        )
        self.assertEqual(
            int(javascript_authority["instruction"]),
            PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
        )
        self.assertEqual(
            javascript_authority["cold"],
            PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
        )
        self.assertEqual(
            javascript_authority["operator"],
            PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP,
        )
        javascript_navigation = javascript_production_navigation_policies()
        self.assertEqual(tuple(javascript_navigation), PRODUCTION_FIDELITY_GAME_KEYS)
        self.assertEqual(
            {
                game_key: (policy["scriptSha256"], len(policy["steps"]))
                for game_key, policy in javascript_navigation.items()
            },
            PRODUCTION_FIDELITY_NAVIGATION_AUTHORITIES,
        )
        self.assertEqual(
            {
                policy["scriptSha256"]
                for game_key, policy in javascript_navigation.items()
                if game_key != "warioware-usa"
            },
            {PRODUCTION_FIDELITY_EMPTY_NAVIGATION_SCRIPT_SHA256},
        )
        policy = {
            **CAPTURE_RUN_POLICY,
            "instructionUpperCap": str(PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP),
            "executedCycleUpperCap": str(PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP),
            "canonicalCycleUpperCap": str(PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP),
            "totalColdInstallCap": PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
        }
        self.assertIs(validate_capture_run_policy(policy, "$.runPolicy"), policy)
        self.assertEqual(policy["runTimeoutMs"], 120 * 60 * 1000)
        self.assertEqual(policy["externalWallTimeoutMs"], 120 * 60 * 1000)
        summary = capture_run_summary(True)
        summary["reportedColdInstalls"] = PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP
        self.assertIs(
            validate_capture_run_summary(summary, policy, "$.runSummary", True),
            summary,
        )
        summary["operatorPublications"] = PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP
        self.assertIs(
            validate_capture_run_summary(summary, policy, "$.runSummary", True),
            summary,
        )
        summary["operatorPublications"] += 1
        with self.assertRaisesRegex(FidelityCheckpointError, "cumulative authority"):
            validate_capture_run_summary(summary, policy, "$.runSummary", True)
        summary["operatorPublications"] = 0
        summary["reportedColdInstalls"] += 1
        with self.assertRaisesRegex(FidelityCheckpointError, "cumulative authority"):
            validate_capture_run_summary(summary, policy, "$.runSummary", True)

    def test_production_evidence_lock_requires_exact_continuous_capture_policy(self) -> None:
        javascript_navigation = javascript_production_navigation_policies()
        lock = {
            "schema": "lazuli-resident-renderer-fidelity-evidence-lock-v3",
            "evidenceMode": (
                "continuous-resident-game-fidelity-v1-with-durable-renderer-and-rust-ownership"
            ),
            "release": {"executionAssets": {}},
            "run": {"runId": RUN_ID, "gameKey": GAME_KEY},
            "corpus": {},
            "selectedGame": {},
            "artifacts": {},
            "sources": {},
            "hostPolicy": {},
            "runPolicy": {
                **CAPTURE_RUN_POLICY,
                "instructionUpperCap": str(
                    PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP
                ),
                "executedCycleUpperCap": str(
                    PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP
                ),
                "canonicalCycleUpperCap": str(
                    PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP
                ),
                "sliceCycleUpperCap": "8000000",
                "blockUpperCap": 131_072,
                "totalHostCallCap": 65_535,
                "totalColdInstallCap": PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
                "maxBootReads": 8_192,
                "bootTimeoutMs": 180_000,
                "sliceTimeoutMs": 180_000,
                "runTimeoutMs": 7_200_000,
                "externalWallTimeoutMs": 7_200_000,
                "zeroProgressSliceCap": 4_096,
                "navigationPolicy": javascript_navigation[GAME_KEY],
            },
            "checkpointPolicy": {},
            "capturePolicy": production_capture_policy(GAME_KEY),
            "rendererProbe": {"defaultHookImports": 0, "checkpointProbeEvents": 0},
            "machineEvidence": {
                "abiVersion": 1,
                "byteLength": 816,
                "wordLength": 204,
                "tag": "LZME",
                "encoding": "base64",
                "browserWordInterpretations": 0,
            },
        }
        self.assertIs(validate_evidence_lock(lock), lock)
        for game_key in PRODUCTION_FIDELITY_GAME_KEYS:
            title_lock = json.loads(json.dumps(lock))
            title_lock["run"]["gameKey"] = game_key
            title_lock["runPolicy"]["navigationPolicy"] = javascript_navigation[game_key]
            title_lock["capturePolicy"] = production_capture_policy(game_key)
            self.assertIs(validate_evidence_lock(title_lock), title_lock)

        empty_wario = json.loads(json.dumps(lock))
        empty_wario["runPolicy"]["navigationPolicy"] = navigation_policy([])
        with self.assertRaisesRegex(ValueError, "production navigation policy"):
            validate_evidence_lock(empty_wario)

        alternate_wario = json.loads(json.dumps(lock))
        alternate_steps = alternate_wario["runPolicy"]["navigationPolicy"]["steps"]
        alternate_steps[0]["minimumCanonicalDelay"] = "4000000001"
        alternate_wario["runPolicy"]["navigationPolicy"]["scriptSha256"] = sha256_hex(
            canonical_json(alternate_steps)
        )
        with self.assertRaisesRegex(ValueError, "production navigation policy"):
            validate_evidence_lock(alternate_wario)

        nonempty_empty_title = json.loads(json.dumps(lock))
        nonempty_empty_title["run"]["gameKey"] = "luigis-mansion-usa"
        nonempty_empty_title["runPolicy"]["navigationPolicy"] = navigation_policy(
            TWO_STEP_NAVIGATION_POLICY["steps"],
            "luigis-mansion-usa",
        )
        nonempty_empty_title["capturePolicy"] = production_capture_policy(
            "luigis-mansion-usa"
        )
        with self.assertRaisesRegex(ValueError, "production navigation policy"):
            validate_evidence_lock(nonempty_empty_title)

        unsupported_title = json.loads(json.dumps(lock))
        unsupported_title["run"]["gameKey"] = "unfrozen-title"
        unsupported_title["runPolicy"]["navigationPolicy"] = navigation_policy(
            [],
            "unfrozen-title",
        )
        with self.assertRaisesRegex(ValueError, "no frozen production navigation authority"):
            validate_evidence_lock(unsupported_title)

        changed_navigation_cardinality = json.loads(json.dumps(lock))
        changed_navigation_cardinality["capturePolicy"][
            "requiredCheckpointCardinality"
        ]["navigation-step-received"] = 33
        with self.assertRaisesRegex(ValueError, "capture navigation cardinality"):
            validate_evidence_lock(changed_navigation_cardinality)

        changed_instruction_cap = json.loads(json.dumps(lock))
        changed_instruction_cap["runPolicy"]["instructionUpperCap"] = "100000000"
        with self.assertRaisesRegex(ValueError, "production instruction cap"):
            validate_evidence_lock(changed_instruction_cap)
        changed_cycle_cap = json.loads(json.dumps(lock))
        changed_cycle_cap["runPolicy"]["executedCycleUpperCap"] = "250000000"
        with self.assertRaisesRegex(ValueError, "production executed-cycle cap"):
            validate_evidence_lock(changed_cycle_cap)
        changed_canonical_cap = json.loads(json.dumps(lock))
        changed_canonical_cap["runPolicy"]["canonicalCycleUpperCap"] = "250000000"
        with self.assertRaisesRegex(ValueError, "production canonical-cycle cap"):
            validate_evidence_lock(changed_canonical_cap)
        changed_wall_cap = json.loads(json.dumps(lock))
        changed_wall_cap["runPolicy"]["externalWallTimeoutMs"] = 3_600_000
        with self.assertRaisesRegex(ValueError, "production wall cap"):
            validate_evidence_lock(changed_wall_cap)
        changed_cap = json.loads(json.dumps(lock))
        changed_cap["runPolicy"]["totalColdInstallCap"] = 65_535
        with self.assertRaisesRegex(ValueError, "production cold-install cap"):
            validate_evidence_lock(changed_cap)
        for mutate in (
            lambda value: value["capturePolicy"].pop("lockedNavigationPolicy"),
            lambda value: value["capturePolicy"]["lockedNavigationPolicy"].update(
                maximumPublications=64
            ),
            lambda value: value["capturePolicy"]["lockedNavigationPolicy"].update(
                armPhase="phase-0-or-baseline"
            ),
            lambda value: value["capturePolicy"]["cumulativeRunLedger"].update(
                startsAt="resident-init"
            ),
        ):
            changed = json.loads(json.dumps(lock))
            mutate(changed)
            with self.assertRaisesRegex(ValueError, "continuous capture policy"):
                validate_evidence_lock(changed)

    def test_locked_source_query_preserves_exact_path_snapshot(self) -> None:
        snapshots = {
            "tools/page.html": b"frozen page bytes\n",
            "tools/other.html": b"different frozen bytes\n",
        }
        target = (
            "/tools/page.html?game=warioware-usa"
            "&instructionCap=100000000&source=/tools/other.html"
        )
        expected = ("tools/page.html", b"frozen page bytes\n")
        self.assertEqual(
            locked_source_for_request(snapshots, "/tools/page.html"),
            expected,
        )
        self.assertEqual(
            locked_source_for_request(snapshots, target),
            expected,
        )

    def test_locked_source_rejects_fragment_and_unknown_path_query_aliases(self) -> None:
        snapshots = {"tools/page.html": b"frozen page bytes\n"}
        for target in (
            "/tools/page.html#fragment",
            "/unknown.html?source=/tools/page.html",
            "/unknown.html?path=%2Ftools%2Fpage.html",
            "//tools/page.html?game=warioware-usa",
            "tools/page.html?game=warioware-usa",
            "http://127.0.0.1/tools/page.html?game=warioware-usa",
        ):
            with self.subTest(target=target):
                self.assertIsNone(locked_source_for_request(snapshots, target))

    def test_fsync_failure_restores_file_and_all_submission_state(self) -> None:
        payload = {**common(1, "pre-submit"), **identity()}
        with patch(
            "resident_machine_fidelity_server.os.fsync",
            side_effect=[OSError("commit fsync"), None],
        ):
            with self.assertRaisesRegex(OSError, "fsync"):
                self.append(payload)
        self.assertEqual(self.path.stat().st_size, 0)
        self.assertIsNone(self.journal.run_id)
        self.assertIsNone(self.journal.game_key)
        self.assertEqual(self.journal.client_sequence, 0)
        self.assertIsNone(self.journal.open_submission)
        self.assertFalse(self.journal.submission_returned)
        self.assertEqual(self.journal.probe_events, 0)
        self.assertEqual(self.journal.probe_events_this_submission, 0)
        self.assertIsNone(self.journal.poisoned_error)

    def test_capture_fsync_failure_restores_all_milestone_state(self) -> None:
        self.reset_capture_journal()
        sequence, _, baseline_ack, report_ack, arm_ack = self.append_capture_prefix(
            baseline_same_receipt=True
        )
        length_before = self.path.stat().st_size
        state_before = (
            self.journal.client_sequence,
            self.journal.previous_record_sha256,
            self.journal.machine_session_id,
            self.journal.machine_initialization_record_sha256,
            self.journal.capture_run_policy,
            self.journal.initial_run_summary,
            self.journal.first_frame_renderer_record_sha256,
            self.journal.first_frame_receipt,
            self.journal.first_frame_readback,
            self.journal.baseline_record_sha256,
            self.journal.baseline_requested_controller,
            self.journal.first_frame_report_record_sha256,
            self.journal.navigation_arm_record_sha256,
            self.journal.navigation_run_call_origin,
            self.journal.navigation_cycle_origin,
            self.journal.navigation_si_poll_index_origin,
            self.journal.navigation_transcript,
            self.journal.navigation_step_record_sha256s,
            self.journal.witness_record_sha256,
            self.journal.accepted_record_sha256,
            self.journal.accepted_artifacts,
            self.journal.terminal_record_sha256,
            self.journal.terminal_run_summary,
        )
        payload = {
            **common(sequence, "controller-witness-published"),
            "machineSessionId": MACHINE_SESSION_ID,
            "baselineRecordSha256": baseline_ack["recordSha256"],
            "firstFrameReportRecordSha256": report_ack["recordSha256"],
            "sequenceLo": 1,
            "sequenceHi": 0,
            "buttons": 0x0100,
            "stickXyCxy": 0x80808080,
            "triggerLrab": 0x00FF0000,
            "status": 1,
            "machineEvidenceEnvelopeBytes": 1200,
            "machineEvidenceEnvelopeSha256": "c" * 64,
            "machineEvidenceOpaqueBytes": 816,
            "machineEvidenceOpaqueSha256": "d" * 64,
            "navigationScriptSha256": EMPTY_NAVIGATION_POLICY["scriptSha256"],
            "navigationStepCount": 0,
            "navigationArmRecordSha256": arm_ack["recordSha256"],
            "lastNavigationStepRecordSha256": None,
            "runSummary": progressed_run_summary(10, 2, witness_publications=1),
        }
        with patch(
            "resident_machine_fidelity_server.os.fsync",
            side_effect=[OSError("capture commit fsync"), None],
        ):
            with self.assertRaisesRegex(OSError, "capture commit fsync"):
                self.append(payload)
        self.assertEqual(self.path.stat().st_size, length_before)
        self.assertEqual(
            (
                self.journal.client_sequence,
                self.journal.previous_record_sha256,
                self.journal.machine_session_id,
                self.journal.machine_initialization_record_sha256,
                self.journal.capture_run_policy,
                self.journal.initial_run_summary,
                self.journal.first_frame_renderer_record_sha256,
                self.journal.first_frame_receipt,
                self.journal.first_frame_readback,
                self.journal.baseline_record_sha256,
                self.journal.baseline_requested_controller,
                self.journal.first_frame_report_record_sha256,
                self.journal.navigation_arm_record_sha256,
                self.journal.navigation_run_call_origin,
                self.journal.navigation_cycle_origin,
                self.journal.navigation_si_poll_index_origin,
                self.journal.navigation_transcript,
                self.journal.navigation_step_record_sha256s,
                self.journal.witness_record_sha256,
                self.journal.accepted_record_sha256,
                self.journal.accepted_artifacts,
                self.journal.terminal_record_sha256,
                self.journal.terminal_run_summary,
            ),
            state_before,
        )

    def test_failed_rollback_permanently_poisons_journal(self) -> None:
        payload = {**common(1, "pre-submit"), **identity()}
        with patch(
            "resident_machine_fidelity_server.os.fsync",
            side_effect=[OSError("commit fsync"), OSError("rollback fsync")],
        ):
            with self.assertRaisesRegex(FidelityCheckpointError, "permanently poisoned"):
                self.append(payload)
        self.assertIsNotNone(self.journal.poisoned_error)
        with self.assertRaisesRegex(FidelityCheckpointError, "permanently poisoned"):
            self.append(payload)


if __name__ == "__main__":
    unittest.main()
