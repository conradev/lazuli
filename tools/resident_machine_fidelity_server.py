#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Add a durable, semantics-free renderer checkpoint journal to the dev corpus host."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import sys
import threading
import time
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import resident_machine_corpus_server as corpus_server


CHECKPOINT_SCHEMA = "lazuli-resident-renderer-fidelity-checkpoint-v1"
DURABLE_RECORD_SCHEMA = "lazuli-resident-renderer-fidelity-durable-record-v1"
ACK_SCHEMA = "lazuli-resident-renderer-fidelity-checkpoint-ack-v1"
CHECKPOINT_PATH = "/resident-fidelity/checkpoints"
EVIDENCE_LOCK_SCHEMA = "lazuli-resident-renderer-fidelity-evidence-lock-v2"
PRODUCTION_EVIDENCE_LOCK_SCHEMA = "lazuli-resident-renderer-fidelity-evidence-lock-v3"
PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP = 1_250_000_000
PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP = 2_500_000_000
PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP = 0x000F_FFFF
EVIDENCE_LOCK_PATH = "/resident-fidelity/evidence-lock.json"
DEFAULT_BODY_CAP = 4_096
DEFAULT_RECORD_CAP = 65_535
DEFAULT_PROBE_EVENT_CAP = 32_768
PROBE_EVENT_PER_SUBMISSION_CAP = 402
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
UUID_PATTERN = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
    re.IGNORECASE,
)

COMMON_FIELDS = {
    "schema",
    "runId",
    "gameKey",
    "clientSequence",
    "kind",
}
RENDER_IDENTITY_FIELDS = {
    "relayRequestId",
    "renderCallOrdinal",
    "requestFlags",
    "sequenceLo",
    "sequenceHi",
}
OPAQUE_REQUEST_FIELDS = {
    "opaqueRequestBytes",
    "opaqueRequestSha256",
}
RECEIPT_FIELDS = {
    "receiptBytes",
    "receiptSha256",
    "presentedAfterResolution",
}
RECEIPT_ANNOTATION_FIELDS = (
    RENDER_IDENTITY_FIELDS
    | OPAQUE_REQUEST_FIELDS
    | {"presentedBefore", "receiptRecordSha256"}
    | RECEIPT_FIELDS
)
FIDELITY_ARTIFACT_FIELDS = {
    "gameFidelityEnvelopeBytes",
    "gameFidelityEnvelopeSha256",
    "gameFidelityOpaqueBytes",
    "gameFidelityOpaqueSha256",
    "machineEvidenceEnvelopeBytes",
    "machineEvidenceEnvelopeSha256",
    "machineEvidenceOpaqueBytes",
    "machineEvidenceOpaqueSha256",
}
CAPTURE_RUN_POLICY_FIELDS = {
    "instructionUpperCap",
    "executedCycleUpperCap",
    "sliceCycleUpperCap",
    "blockUpperCap",
    "totalHostCallCap",
    "totalColdInstallCap",
    "maxBootReads",
    "bootTimeoutMs",
    "sliceTimeoutMs",
    "runTimeoutMs",
    "externalWallTimeoutMs",
    "zeroProgressSliceCap",
    "workerUrl",
}
CAPTURE_RUN_SUMMARY_FIELDS = {
    "schema",
    "issuedRunCalls",
    "reportedExecutedCycles",
    "reportedExecutedInstructions",
    "reportedHostCalls",
    "reportedColdInstalls",
    "zeroProgressSlices",
    "consecutiveZeroProgressSlices",
    "maximumConsecutiveZeroProgressSlices",
    "operatorPublications",
    "witnessPublications",
    "elapsedWallMs",
    "wallTimeoutMs",
    "accepted",
}

EVIDENCE_LOCK_FIELDS = {
    "schema",
    "evidenceMode",
    "corpus",
    "selectedGame",
    "artifacts",
    "sources",
    "hostPolicy",
    "runPolicy",
    "checkpointPolicy",
    "rendererProbe",
    "machineEvidence",
}
PRODUCTION_EVIDENCE_LOCK_FIELDS = EVIDENCE_LOCK_FIELDS | {"release", "run", "capturePolicy"}
MACHINE_EVIDENCE_POLICY = {
    "abiVersion": 1,
    "byteLength": 816,
    "wordLength": 204,
    "tag": "LZME",
    "encoding": "base64",
    "browserWordInterpretations": 0,
}


class FidelityCheckpointError(ValueError):
    """A checkpoint is malformed or violates the append-only state machine."""


def production_capture_policy(game_key: str) -> dict[str, Any]:
    return {
        "mode": "continuous-single-worker-machine-v1",
        "pageQuery": {
            "allowedKeys": ["capture", "game"],
            "requiredValues": {"capture": "fidelity", "game": game_key},
            "duplicateValuesAllowed": False,
            "unknownKeysAllowed": False,
        },
        "oneWorkerInitialization": True,
        "workerGeneratedMachineSessionId": True,
        "captureMachineInitializedBeforeProgress": True,
        "cumulativeRunCapsAfterAuthenticatedReady": True,
        "cumulativeRunLedger": {
            "schema": "lazuli-resident-cumulative-run-summary-v1",
            "policySource": "locked-runPolicy",
            "startsAt": "resident-ready",
            "endsAt": "fidelity-accepted-owned",
            "terminalSummaryRequired": True,
            "operatorPublicationsBound": True,
            "witnessPublicationsRequired": 1,
        },
        "minimumViFieldDeltaFromFirstFrame": 120,
        "minimumPresentationDeltaFromFirstFrame": 64,
        "fidelityStatePollAfterEveryRun": True,
        "observationAckAfterDurableOwnership": True,
        "witnessCheckpointAckBeforeProgress": True,
        "acceptedIsHardMachineProgressBoundary": True,
        "terminalStateQueryOnlyAfterAccepted": True,
        "terminalOpaqueArtifactsEqualAccepted": True,
        "firstFrameReportUsesPreBindingJournalPrefix": True,
        "sameReceiptBaselineReusesFirstFrameReadback": True,
        "genericOperatorInputBeforeBaseline": True,
        "genericOperatorPolicy": {
            "algorithm": "alternating-neutral-a-v1",
            "runBoundaryOrigin": "post-first-frame-report-local-zero",
            "runBoundaryInterval": 8,
            "maximumPublications": 64,
            "startsWith": "neutral",
            "neutral": {
                "buttons": 0,
                "stickXyCxy": 0x80808080,
                "triggerLrab": 0,
            },
            "a": {
                "buttons": 0x0100,
                "stickXyCxy": 0x80808080,
                "triggerLrab": 0x00FF0000,
            },
        },
        "rustRequestedWitnessOnly": True,
        "artifactDigestPolicy": {
            "json": "recursive-key-canonical-utf8",
            "opaqueRecords": "decoded-canonical-padded-base64",
            "binary": "raw-owned-bytes",
        },
        "retainedLeafSchema": {
            "controllerSource": "tools/resident_machine_production_fidelity_capture.mjs",
            "report": "recursive-key-canonical-utf8",
            "envelopes": "recursive-key-canonical-utf8",
            "opaqueRecords": "decoded-canonical-padded-base64",
            "metadata": "recursive-key-canonical-utf8",
            "rgba": "raw-owned-bytes",
        },
        "requiredCheckpointCardinality": {
            "capture-machine-initialized": 1,
            "first-frame-renderer-owned": 1,
            "first-frame-report-bound": 1,
            "fidelity-baseline-owned": 1,
            "controller-witness-published": 1,
            "fidelity-accepted-owned": 1,
            "fidelity-terminal": 1,
        },
        "requiredCheckpointOrder": [
            ["capture-machine-initialized", "first-frame-renderer-owned"],
            ["capture-machine-initialized", "fidelity-baseline-owned"],
            ["capture-machine-initialized", "first-frame-report-bound"],
            ["first-frame-renderer-owned", "first-frame-report-bound"],
            ["first-frame-renderer-owned", "fidelity-baseline-owned"],
            ["first-frame-report-bound", "controller-witness-published"],
            ["fidelity-baseline-owned", "controller-witness-published"],
            ["controller-witness-published", "fidelity-accepted-owned"],
            ["fidelity-accepted-owned", "fidelity-terminal"],
        ],
    }


def validate_evidence_lock(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("--evidence-lock must be an object")
    production = value.get("schema") == PRODUCTION_EVIDENCE_LOCK_SCHEMA
    expected_fields = PRODUCTION_EVIDENCE_LOCK_FIELDS if production else EVIDENCE_LOCK_FIELDS
    if set(value) != expected_fields:
        raise ValueError(
            f"--evidence-lock fields must be exactly {sorted(expected_fields)}"
        )
    if value["schema"] not in {EVIDENCE_LOCK_SCHEMA, PRODUCTION_EVIDENCE_LOCK_SCHEMA}:
        raise ValueError("--evidence-lock has an unsupported schema")
    expected_mode = (
        "continuous-resident-game-fidelity-v1-with-durable-renderer-and-rust-ownership"
        if production
        else "first-renderer-owned-presented-xfb-with-durable-probe-checkpoints-"
        "and-machine-evidence-v1"
    )
    if value["evidenceMode"] != expected_mode:
        raise ValueError("--evidence-lock has an unexpected evidenceMode")
    if value["machineEvidence"] != MACHINE_EVIDENCE_POLICY:
        raise ValueError("--evidence-lock has an unexpected machineEvidence policy")
    if production:
        run = value.get("run")
        release = value.get("release")
        renderer_probe = value.get("rendererProbe")
        if (
            not isinstance(run, dict)
            or set(run) != {"runId", "gameKey"}
            or not isinstance(run["runId"], str)
            or UUID_PATTERN.fullmatch(run["runId"]) is None
            or not isinstance(run["gameKey"], str)
        ):
            raise ValueError("--evidence-lock has an invalid production run identity")
        if not isinstance(release, dict) or not isinstance(release.get("executionAssets"), dict):
            raise ValueError("--evidence-lock lacks production execution assets")
        if not isinstance(renderer_probe, dict) or renderer_probe.get("defaultHookImports") != 0:
            raise ValueError("--evidence-lock production renderer must be default-off")
        if renderer_probe.get("checkpointProbeEvents") != 0:
            raise ValueError("--evidence-lock production checkpoint probes must be forbidden")
        run_policy = value.get("runPolicy")
        if not isinstance(run_policy, dict) or (
            run_policy.get("instructionUpperCap")
            != str(PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP)
        ):
            raise ValueError("--evidence-lock has an invalid production instruction cap")
        if (
            run_policy.get("executedCycleUpperCap")
            != str(PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP)
        ):
            raise ValueError("--evidence-lock has an invalid production executed-cycle cap")
        if (
            run_policy.get("totalColdInstallCap")
            != PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP
        ):
            raise ValueError("--evidence-lock has an invalid production cold-install cap")
        capture_policy = value.get("capturePolicy")
        expected_capture_policy = production_capture_policy(run["gameKey"])
        if capture_policy != expected_capture_policy:
            raise ValueError("--evidence-lock has an invalid continuous capture policy")
    return value


def canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def exact_fields(value: dict[str, Any], expected: set[str], path: str) -> None:
    actual = set(value)
    if actual != expected:
        raise FidelityCheckpointError(
            f"{path} fields must be exactly {sorted(expected)}, got {sorted(actual)}"
        )


def positive_integer(value: object, path: str, maximum: int = 0xFFFF_FFFF) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0 or value > maximum:
        raise FidelityCheckpointError(f"{path} must be an integer from 1 through {maximum}")
    return value


def uint32(value: object, path: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 0xFFFF_FFFF:
        raise FidelityCheckpointError(f"{path} must be an unsigned 32-bit integer")
    return value


def nonnegative_integer(value: object, path: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise FidelityCheckpointError(f"{path} must be a nonnegative integer")
    return value


def unsigned_decimal(value: object, path: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"(?:0|[1-9][0-9]*)", value) is None:
        raise FidelityCheckpointError(f"{path} must be an unsigned decimal string")
    return value


def validate_capture_run_policy(value: object, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise FidelityCheckpointError(f"{path} must be an object")
    exact_fields(value, CAPTURE_RUN_POLICY_FIELDS, path)
    for field in ("instructionUpperCap", "executedCycleUpperCap", "sliceCycleUpperCap"):
        unsigned_decimal(value[field], f"{path}.{field}")
        if int(value[field]) == 0:
            raise FidelityCheckpointError(f"{path}.{field} must be positive")
    for field in CAPTURE_RUN_POLICY_FIELDS - {
        "instructionUpperCap", "executedCycleUpperCap", "sliceCycleUpperCap", "workerUrl"
    }:
        positive_integer(value[field], f"{path}.{field}", 0x1F_FFFF_FFFF_FFFF)
    if not isinstance(value["workerUrl"], str) or not value["workerUrl"].startswith("/"):
        raise FidelityCheckpointError(f"{path}.workerUrl must be a same-origin absolute path")
    if int(value["sliceCycleUpperCap"]) > int(value["executedCycleUpperCap"]):
        raise FidelityCheckpointError(f"{path}.sliceCycleUpperCap exceeds total cycle cap")
    return value


def validate_capture_run_summary(
    value: object,
    policy: dict[str, Any],
    path: str,
    accepted: bool,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise FidelityCheckpointError(f"{path} must be an object")
    exact_fields(value, CAPTURE_RUN_SUMMARY_FIELDS, path)
    if value["schema"] != "lazuli-resident-cumulative-run-summary-v1":
        raise FidelityCheckpointError(f"{path}.schema is unexpected")
    unsigned_decimal(value["reportedExecutedCycles"], f"{path}.reportedExecutedCycles")
    unsigned_decimal(
        value["reportedExecutedInstructions"],
        f"{path}.reportedExecutedInstructions",
    )
    for field in CAPTURE_RUN_SUMMARY_FIELDS - {
        "schema", "reportedExecutedCycles", "reportedExecutedInstructions", "accepted",
        "wallTimeoutMs",
    }:
        nonnegative_integer(value[field], f"{path}.{field}")
    positive_integer(value["wallTimeoutMs"], f"{path}.wallTimeoutMs", 0x1F_FFFF_FFFF_FFFF)
    if value["accepted"] is not accepted:
        raise FidelityCheckpointError(f"{path}.accepted must be {accepted}")
    wall_timeout = min(policy["runTimeoutMs"], policy["externalWallTimeoutMs"])
    if value["wallTimeoutMs"] != wall_timeout or value["elapsedWallMs"] >= wall_timeout:
        raise FidelityCheckpointError(f"{path} wall authority changed or exhausted")
    if (
        int(value["reportedExecutedCycles"]) > int(policy["executedCycleUpperCap"])
        or int(value["reportedExecutedInstructions"]) > int(policy["instructionUpperCap"])
        or value["reportedHostCalls"] > policy["totalHostCallCap"]
        or value["reportedColdInstalls"] > policy["totalColdInstallCap"]
        or value["consecutiveZeroProgressSlices"] >= policy["zeroProgressSliceCap"]
        or value["maximumConsecutiveZeroProgressSlices"] >= policy["zeroProgressSliceCap"]
        or value["operatorPublications"] > 64
        or value["witnessPublications"] > 1
    ):
        raise FidelityCheckpointError(f"{path} exceeded frozen cumulative authority")
    return value


def sha256(value: object, path: str) -> str:
    if not isinstance(value, str) or SHA256_PATTERN.fullmatch(value) is None:
        raise FidelityCheckpointError(f"{path} must be a lowercase SHA-256 digest")
    return value


def render_identity(payload: dict[str, Any]) -> dict[str, int]:
    return {
        field: positive_integer(payload[field], f"$.{field}")
        if field in {"relayRequestId", "renderCallOrdinal"}
        else uint32(payload[field], f"$.{field}")
        for field in sorted(RENDER_IDENTITY_FIELDS)
    }


def request_identity(payload: dict[str, Any]) -> dict[str, object]:
    identity: dict[str, object] = render_identity(payload)
    identity["opaqueRequestBytes"] = positive_integer(
        payload["opaqueRequestBytes"],
        "$.opaqueRequestBytes",
        64 * 1024 * 1024,
    )
    identity["opaqueRequestSha256"] = sha256(
        payload["opaqueRequestSha256"],
        "$.opaqueRequestSha256",
    )
    identity["presentedBefore"] = payload["presentedBefore"]
    if not isinstance(identity["presentedBefore"], bool):
        raise FidelityCheckpointError("$.presentedBefore must be boolean")
    return identity


def resolved_receipt_identity(payload: dict[str, Any]) -> dict[str, object]:
    identity = request_identity(payload)
    identity["receiptBytes"] = positive_integer(
        payload["receiptBytes"], "$.receiptBytes", 64 * 1024 * 1024
    )
    identity["receiptSha256"] = sha256(payload["receiptSha256"], "$.receiptSha256")
    if not isinstance(payload["presentedAfterResolution"], bool):
        raise FidelityCheckpointError("$.presentedAfterResolution must be boolean")
    identity["presentedAfterResolution"] = payload["presentedAfterResolution"]
    identity["receiptRecordSha256"] = sha256(
        payload["receiptRecordSha256"], "$.receiptRecordSha256"
    )
    return identity


def validate_byte_artifact(
    payload: dict[str, Any], bytes_field: str, sha_field: str, maximum: int
) -> None:
    positive_integer(payload[bytes_field], f"$.{bytes_field}", maximum)
    sha256(payload[sha_field], f"$.{sha_field}")


def validate_fidelity_artifacts(payload: dict[str, Any]) -> None:
    validate_byte_artifact(
        payload, "gameFidelityEnvelopeBytes", "gameFidelityEnvelopeSha256", 16 * 1024
    )
    validate_byte_artifact(
        payload, "gameFidelityOpaqueBytes", "gameFidelityOpaqueSha256", 384
    )
    validate_byte_artifact(
        payload, "machineEvidenceEnvelopeBytes", "machineEvidenceEnvelopeSha256", 16 * 1024
    )
    validate_byte_artifact(
        payload, "machineEvidenceOpaqueBytes", "machineEvidenceOpaqueSha256", 816
    )
    if payload["gameFidelityOpaqueBytes"] != 384:
        raise FidelityCheckpointError("$.gameFidelityOpaqueBytes must be exactly 384")
    if payload["machineEvidenceOpaqueBytes"] != 816:
        raise FidelityCheckpointError("$.machineEvidenceOpaqueBytes must be exactly 816")


def validate_checkpoint(payload: object) -> tuple[dict[str, Any], dict[str, object] | None]:
    if not isinstance(payload, dict):
        raise FidelityCheckpointError("$ must be an object")
    kind = payload.get("kind")
    if kind == "pre-submit":
        exact_fields(
            payload,
            COMMON_FIELDS
            | RENDER_IDENTITY_FIELDS
            | OPAQUE_REQUEST_FIELDS
            | {"presentedBefore"},
            "$",
        )
    elif kind == "renderer-probe-event":
        exact_fields(
            payload,
            COMMON_FIELDS | {"relayRequestId", "renderCallOrdinal", "words"},
            "$",
        )
    elif kind == "submit-returned":
        exact_fields(
            payload,
            COMMON_FIELDS
            | RENDER_IDENTITY_FIELDS
            | OPAQUE_REQUEST_FIELDS
            | {
                "presentedBefore",
                "presentedAfterReturn",
                "returnedPromise",
            },
            "$",
        )
    elif kind == "receipt-resolved":
        exact_fields(
            payload,
            COMMON_FIELDS
            | RENDER_IDENTITY_FIELDS
            | OPAQUE_REQUEST_FIELDS
            | {
                "presentedBefore",
                "presentedAfterResolution",
                "receiptBytes",
                "receiptSha256",
            },
            "$",
        )
    elif kind == "capture-machine-initialized":
        exact_fields(
            payload,
            COMMON_FIELDS
            | {
                "machineSessionId",
                "bootStatus",
                "bootReads",
                "machineEvidenceEnvelopeBytes",
                "machineEvidenceEnvelopeSha256",
                "machineEvidenceOpaqueBytes",
                "machineEvidenceOpaqueSha256",
                "runPolicy",
                "runSummary",
            },
            "$",
        )
    elif kind == "first-frame-renderer-owned":
        exact_fields(
            payload,
            COMMON_FIELDS
            | RECEIPT_ANNOTATION_FIELDS
            | {
                "machineSessionId",
                "readbackMetadataBytes",
                "readbackMetadataSha256",
                "rgbaBytes",
                "rgbaSha256",
            },
            "$",
        )
    elif kind == "fidelity-baseline-owned":
        exact_fields(
            payload,
            COMMON_FIELDS
            | RECEIPT_ANNOTATION_FIELDS
            | FIDELITY_ARTIFACT_FIELDS
            | {
                "machineSessionId",
                "phase",
                "readbackMetadataBytes",
                "readbackMetadataSha256",
                "rgbaBytes",
                "rgbaSha256",
                "requestedButtons",
                "requestedStickXyCxy",
                "requestedTriggerLrab",
            },
            "$",
        )
    elif kind == "first-frame-report-bound":
        exact_fields(
            payload,
            COMMON_FIELDS
            | {
                "machineSessionId",
                "reportBytes",
                "reportSha256",
                "machineEvidenceEnvelopeBytes",
                "machineEvidenceEnvelopeSha256",
                "machineEvidenceOpaqueBytes",
                "machineEvidenceOpaqueSha256",
                "firstFrameRendererRecordSha256",
                "baselineRecordSha256",
            },
            "$",
        )
    elif kind == "controller-witness-published":
        exact_fields(
            payload,
            COMMON_FIELDS
            | {
                "machineSessionId",
                "baselineRecordSha256",
                "firstFrameReportRecordSha256",
                "sequenceLo",
                "sequenceHi",
                "buttons",
                "stickXyCxy",
                "triggerLrab",
                "status",
                "machineEvidenceEnvelopeBytes",
                "machineEvidenceEnvelopeSha256",
                "machineEvidenceOpaqueBytes",
                "machineEvidenceOpaqueSha256",
            },
            "$",
        )
    elif kind == "fidelity-accepted-owned":
        exact_fields(
            payload,
            COMMON_FIELDS
            | RECEIPT_ANNOTATION_FIELDS
            | FIDELITY_ARTIFACT_FIELDS
            | {
                "machineSessionId",
                "phase",
                "readbackMetadataBytes",
                "readbackMetadataSha256",
                "rgbaBytes",
                "rgbaSha256",
                "witnessRecordSha256",
            },
            "$",
        )
    elif kind == "fidelity-terminal":
        exact_fields(
            payload,
            COMMON_FIELDS
            | FIDELITY_ARTIFACT_FIELDS
            | {
                "machineSessionId",
                "phase",
                "baselineRecordSha256",
                "acceptedRecordSha256",
                "runSummary",
            },
            "$",
        )
    else:
        raise FidelityCheckpointError("$.kind is not a supported checkpoint kind")

    if payload["schema"] != CHECKPOINT_SCHEMA:
        raise FidelityCheckpointError(f"$.schema must be {CHECKPOINT_SCHEMA}")
    if not isinstance(payload["runId"], str) or UUID_PATTERN.fullmatch(payload["runId"]) is None:
        raise FidelityCheckpointError("$.runId must be a UUID")
    if (
        not isinstance(payload["gameKey"], str)
        or corpus_server.KEY_PATTERN.fullmatch(payload["gameKey"]) is None
    ):
        raise FidelityCheckpointError("$.gameKey must be lowercase kebab-case")
    positive_integer(payload["clientSequence"], "$.clientSequence")

    if kind == "renderer-probe-event":
        positive_integer(payload["relayRequestId"], "$.relayRequestId")
        positive_integer(payload["renderCallOrdinal"], "$.renderCallOrdinal")
        words = payload["words"]
        if not isinstance(words, list) or len(words) != 6:
            raise FidelityCheckpointError("$.words must contain exactly six u32 values")
        for index, value in enumerate(words):
            uint32(value, f"$.words[{index}]")
        return payload, None

    if kind == "capture-machine-initialized":
        if not isinstance(payload["machineSessionId"], str) \
                or UUID_PATTERN.fullmatch(payload["machineSessionId"]) is None:
            raise FidelityCheckpointError("$.machineSessionId must be a UUID")
        if payload["bootStatus"] != 3:
            raise FidelityCheckpointError("$.bootStatus must be exact complete status 3")
        positive_integer(payload["bootReads"], "$.bootReads", 65_535)
        validate_byte_artifact(
            payload,
            "machineEvidenceEnvelopeBytes",
            "machineEvidenceEnvelopeSha256",
            16 * 1024,
        )
        validate_byte_artifact(
            payload,
            "machineEvidenceOpaqueBytes",
            "machineEvidenceOpaqueSha256",
            816,
        )
        if payload["machineEvidenceOpaqueBytes"] != 816:
            raise FidelityCheckpointError("$.machineEvidenceOpaqueBytes must be exactly 816")
        run_policy = validate_capture_run_policy(payload["runPolicy"], "$.runPolicy")
        if payload["bootReads"] > run_policy["maxBootReads"]:
            raise FidelityCheckpointError("$.bootReads exceeded the locked ready boot cap")
        run_summary = validate_capture_run_summary(
            payload["runSummary"], run_policy, "$.runSummary", False
        )
        if (
            run_summary["issuedRunCalls"] != 0
            or run_summary["reportedExecutedCycles"] != "0"
            or run_summary["reportedExecutedInstructions"] != "0"
            or run_summary["reportedHostCalls"] != 0
            or run_summary["reportedColdInstalls"] != 0
            or run_summary["zeroProgressSlices"] != 0
            or run_summary["consecutiveZeroProgressSlices"] != 0
            or run_summary["maximumConsecutiveZeroProgressSlices"] != 0
            or run_summary["operatorPublications"] != 0
            or run_summary["witnessPublications"] != 0
            or run_summary["elapsedWallMs"] != 0
        ):
            raise FidelityCheckpointError("$.runSummary must be pristine at ready")
        return payload, None

    if kind in {
        "first-frame-renderer-owned",
        "fidelity-baseline-owned",
        "fidelity-accepted-owned",
    }:
        identity = resolved_receipt_identity(payload)
        validate_byte_artifact(
            payload, "readbackMetadataBytes", "readbackMetadataSha256", 1024 * 1024
        )
        validate_byte_artifact(payload, "rgbaBytes", "rgbaSha256", 64 * 1024 * 1024)
        if kind != "first-frame-renderer-owned":
            validate_fidelity_artifacts(payload)
            expected_phase = 1 if kind == "fidelity-baseline-owned" else 5
            if payload["phase"] != expected_phase:
                raise FidelityCheckpointError(f"$.phase must be {expected_phase}")
            if kind == "fidelity-accepted-owned":
                sha256(payload["witnessRecordSha256"], "$.witnessRecordSha256")
        return payload, identity

    if kind == "first-frame-report-bound":
        validate_byte_artifact(payload, "reportBytes", "reportSha256", 16 * 1024 * 1024)
        validate_byte_artifact(
            payload,
            "machineEvidenceEnvelopeBytes",
            "machineEvidenceEnvelopeSha256",
            16 * 1024,
        )
        validate_byte_artifact(
            payload,
            "machineEvidenceOpaqueBytes",
            "machineEvidenceOpaqueSha256",
            816,
        )
        if payload["machineEvidenceOpaqueBytes"] != 816:
            raise FidelityCheckpointError("$.machineEvidenceOpaqueBytes must be exactly 816")
        sha256(payload["firstFrameRendererRecordSha256"], "$.firstFrameRendererRecordSha256")
        if payload["baselineRecordSha256"] is not None:
            sha256(payload["baselineRecordSha256"], "$.baselineRecordSha256")
        return payload, None

    if kind == "controller-witness-published":
        sha256(payload["baselineRecordSha256"], "$.baselineRecordSha256")
        sha256(payload["firstFrameReportRecordSha256"], "$.firstFrameReportRecordSha256")
        for field in ("sequenceLo", "sequenceHi", "buttons", "stickXyCxy", "triggerLrab"):
            uint32(payload[field], f"$.{field}")
        positive_integer(payload["status"], "$.status")
        validate_byte_artifact(
            payload,
            "machineEvidenceEnvelopeBytes",
            "machineEvidenceEnvelopeSha256",
            16 * 1024,
        )
        validate_byte_artifact(
            payload,
            "machineEvidenceOpaqueBytes",
            "machineEvidenceOpaqueSha256",
            816,
        )
        if payload["machineEvidenceOpaqueBytes"] != 816:
            raise FidelityCheckpointError(
                "$.machineEvidenceOpaqueBytes must be exactly 816"
            )
        return payload, None

    if kind == "fidelity-terminal":
        if payload["phase"] != 5:
            raise FidelityCheckpointError("$.phase must be 5")
        sha256(payload["baselineRecordSha256"], "$.baselineRecordSha256")
        sha256(payload["acceptedRecordSha256"], "$.acceptedRecordSha256")
        validate_fidelity_artifacts(payload)
        return payload, None

    identity = request_identity(payload)
    if kind == "submit-returned":
        if payload["returnedPromise"] is not True:
            raise FidelityCheckpointError("$.returnedPromise must be true")
        if not isinstance(payload["presentedAfterReturn"], bool):
            raise FidelityCheckpointError("$.presentedAfterReturn must be boolean")
    elif kind == "receipt-resolved":
        if not isinstance(payload["presentedAfterResolution"], bool):
            raise FidelityCheckpointError("$.presentedAfterResolution must be boolean")
        positive_integer(payload["receiptBytes"], "$.receiptBytes", 64 * 1024 * 1024)
        sha256(payload["receiptSha256"], "$.receiptSha256")
    return payload, identity


class FidelityCheckpointJournal:
    """An exclusively-created, fsync'd JSONL hash chain for one browser run."""

    def __init__(
        self,
        path: Path,
        record_cap: int,
        probe_event_cap: int | None = None,
        evidence_lock_sha256: str = "e" * 64,
        expected_run_id: str | None = None,
        expected_game_key: str | None = None,
        allow_probe_events: bool = True,
        allow_capture_annotations: bool = False,
    ) -> None:
        if record_cap <= 0:
            raise ValueError("checkpoint record cap must be positive")
        if probe_event_cap is None:
            probe_event_cap = min(record_cap, DEFAULT_PROBE_EVENT_CAP)
        if probe_event_cap <= 0 or probe_event_cap > DEFAULT_PROBE_EVENT_CAP:
            raise ValueError(
                f"renderer probe event cap must be 1 through {DEFAULT_PROBE_EVENT_CAP}"
            )
        if probe_event_cap > record_cap:
            raise ValueError("renderer probe event cap cannot exceed checkpoint record cap")
        resolved_parent = path.expanduser().parent.resolve(strict=True)
        self.path = resolved_parent / path.name
        self.file = self.path.open("xb", buffering=0)
        parent_descriptor = os.open(self.path.parent, os.O_RDONLY)
        try:
            os.fsync(parent_descriptor)
        finally:
            os.close(parent_descriptor)
        self.record_cap = record_cap
        self.probe_event_cap = probe_event_cap
        self.evidence_lock_sha256 = sha256(evidence_lock_sha256, "evidence lock")
        self.lock = threading.Lock()
        self.server_sequence = 0
        self.previous_record_sha256: str | None = None
        if (expected_run_id is None) != (expected_game_key is None):
            raise ValueError("expected run ID and game key must be provided together")
        if expected_run_id is not None and UUID_PATTERN.fullmatch(expected_run_id) is None:
            raise ValueError("expected run ID must be a UUID")
        self.run_id: str | None = expected_run_id
        self.game_key: str | None = expected_game_key
        self.allow_probe_events = allow_probe_events
        self.allow_capture_annotations = allow_capture_annotations
        self.client_sequence = 0
        self.open_submission: dict[str, object] | None = None
        self.submission_returned = False
        self.probe_events = 0
        self.probe_events_this_submission = 0
        self.last_resolved_receipt: dict[str, object] | None = None
        self.machine_session_id: str | None = None
        self.machine_initialization_record_sha256: str | None = None
        self.capture_run_policy: dict[str, Any] | None = None
        self.initial_run_summary: dict[str, Any] | None = None
        self.first_frame_renderer_record_sha256: str | None = None
        self.first_frame_receipt: dict[str, object] | None = None
        self.first_frame_readback: dict[str, object] | None = None
        self.baseline_record_sha256: str | None = None
        self.baseline_requested_controller: dict[str, int] | None = None
        self.first_frame_report_record_sha256: str | None = None
        self.witness_record_sha256: str | None = None
        self.accepted_record_sha256: str | None = None
        self.accepted_artifacts: dict[str, object] | None = None
        self.terminal_record_sha256: str | None = None
        self.terminal_run_summary: dict[str, Any] | None = None
        self.poisoned_error: str | None = None

    def close(self) -> None:
        with self.lock:
            if not self.file.closed:
                self.file.flush()
                os.fsync(self.file.fileno())
                self.file.close()

    def _validate_sequence(
        self,
        payload: dict[str, Any],
        identity: dict[str, object] | None,
        known_games: set[str],
    ) -> None:
        run_id = payload["runId"]
        game_key = payload["gameKey"]
        if game_key not in known_games:
            raise FidelityCheckpointError("$.gameKey is not selected by the frozen host")
        if self.run_id is None:
            self.run_id = run_id
            self.game_key = game_key
        elif run_id != self.run_id or game_key != self.game_key:
            raise FidelityCheckpointError("checkpoint run or game identity changed")
        expected_client_sequence = self.client_sequence + 1
        if payload["clientSequence"] != expected_client_sequence:
            raise FidelityCheckpointError(
                f"$.clientSequence must be {expected_client_sequence}"
            )

        kind = payload["kind"]
        if self.terminal_record_sha256 is not None:
            raise FidelityCheckpointError("checkpoint followed terminal fidelity boundary")
        if self.allow_capture_annotations \
                and self.machine_session_id is None \
                and kind != "capture-machine-initialized":
            raise FidelityCheckpointError("capture machine initialization must be first")
        capture_annotation_kinds = {
            "first-frame-renderer-owned",
            "fidelity-baseline-owned",
            "first-frame-report-bound",
            "controller-witness-published",
            "fidelity-accepted-owned",
            "fidelity-terminal",
        }
        if kind in capture_annotation_kinds \
                and payload["machineSessionId"] != self.machine_session_id:
            raise FidelityCheckpointError("capture machine session changed")
        if kind == "capture-machine-initialized":
            if self.client_sequence != 0 or self.machine_session_id is not None:
                raise FidelityCheckpointError("capture machine initialization must be first")
        elif kind == "pre-submit":
            if self.open_submission is not None:
                raise FidelityCheckpointError("pre-submit encountered an open renderer submission")
            self.open_submission = identity
            self.submission_returned = False
            self.probe_events_this_submission = 0
        elif kind == "renderer-probe-event":
            if not self.allow_probe_events:
                raise FidelityCheckpointError(
                    "renderer probe events are forbidden by the production default-off lock"
                )
            if self.open_submission is None:
                raise FidelityCheckpointError("renderer probe event has no open submission")
            for field in ("relayRequestId", "renderCallOrdinal"):
                if payload[field] != self.open_submission[field]:
                    raise FidelityCheckpointError(f"$.{field} changed within the submission")
            if self.probe_events >= self.probe_event_cap:
                raise FidelityCheckpointError("renderer probe event cap reached")
            if self.probe_events_this_submission >= PROBE_EVENT_PER_SUBMISSION_CAP:
                raise FidelityCheckpointError("renderer probe per-submission cap reached")
            self.probe_events += 1
            self.probe_events_this_submission += 1
        elif kind == "submit-returned":
            if self.open_submission is None:
                raise FidelityCheckpointError("submit-returned has no matching pre-submit")
            if self.submission_returned:
                raise FidelityCheckpointError("submission returned more than once")
            if identity != self.open_submission:
                raise FidelityCheckpointError("submit-returned request identity changed")
            self.submission_returned = True
        elif kind == "receipt-resolved":
            if self.open_submission is None or not self.submission_returned:
                raise FidelityCheckpointError("receipt-resolved has no returned submission")
            if identity != self.open_submission:
                raise FidelityCheckpointError("receipt-resolved request identity changed")
            self.open_submission = None
            self.submission_returned = False
        elif kind == "first-frame-renderer-owned":
            if not self.allow_capture_annotations:
                raise FidelityCheckpointError("capture annotations require a production v3 lock")
            if self.open_submission is not None or self.last_resolved_receipt is None:
                raise FidelityCheckpointError(
                    "first-frame ownership requires a resolved receipt and no open submission"
                )
            if identity != self.last_resolved_receipt:
                raise FidelityCheckpointError("first-frame resolved receipt identity changed")
            if self.first_frame_renderer_record_sha256 is not None:
                raise FidelityCheckpointError("first-frame ownership occurred more than once")
            if self.previous_record_sha256 != identity["receiptRecordSha256"]:
                raise FidelityCheckpointError(
                    "first-frame ownership did not immediately follow its receipt"
                )
        elif kind == "fidelity-baseline-owned":
            if not self.allow_capture_annotations:
                raise FidelityCheckpointError("capture annotations require a production v3 lock")
            if self.open_submission is not None or self.last_resolved_receipt is None:
                raise FidelityCheckpointError(
                    "Baseline ownership requires a resolved receipt and no open submission"
                )
            if identity != self.last_resolved_receipt:
                raise FidelityCheckpointError("Baseline resolved receipt identity changed")
            if self.first_frame_renderer_record_sha256 is None or self.baseline_record_sha256 is not None:
                raise FidelityCheckpointError("Baseline ownership cardinality/order changed")
            allowed_previous = {identity["receiptRecordSha256"]}
            if identity == self.first_frame_receipt:
                allowed_previous.add(self.first_frame_renderer_record_sha256)
                readback = {
                    "readbackMetadataBytes": payload["readbackMetadataBytes"],
                    "readbackMetadataSha256": payload["readbackMetadataSha256"],
                    "rgbaBytes": payload["rgbaBytes"],
                    "rgbaSha256": payload["rgbaSha256"],
                }
                if readback != self.first_frame_readback:
                    raise FidelityCheckpointError(
                        "same-receipt Baseline did not reuse first-frame renderer ownership"
                    )
            if self.previous_record_sha256 not in allowed_previous:
                raise FidelityCheckpointError("Baseline did not immediately annotate its receipt")
            uint32(payload["requestedButtons"], "$.requestedButtons")
            uint32(payload["requestedStickXyCxy"], "$.requestedStickXyCxy")
            uint32(payload["requestedTriggerLrab"], "$.requestedTriggerLrab")
        elif kind == "first-frame-report-bound":
            if not self.allow_capture_annotations or self.open_submission is not None:
                raise FidelityCheckpointError(
                    "first-frame report binding requires production capture with no open submission"
                )
            if self.first_frame_renderer_record_sha256 is None \
                    or self.first_frame_report_record_sha256 is not None:
                raise FidelityCheckpointError("first-frame report binding cardinality/order changed")
            if payload["firstFrameRendererRecordSha256"] != self.first_frame_renderer_record_sha256:
                raise FidelityCheckpointError("first-frame report did not join renderer ownership")
            if payload["baselineRecordSha256"] != self.baseline_record_sha256:
                raise FidelityCheckpointError("first-frame report Baseline prefix join changed")
        elif kind == "controller-witness-published":
            if not self.allow_capture_annotations or self.open_submission is not None:
                raise FidelityCheckpointError(
                    "controller witness requires production capture with no open submission"
                )
            if self.baseline_record_sha256 is None \
                    or self.first_frame_report_record_sha256 is None \
                    or self.witness_record_sha256 is not None:
                raise FidelityCheckpointError("controller witness cardinality/order changed")
            if payload["baselineRecordSha256"] != self.baseline_record_sha256 \
                    or payload["firstFrameReportRecordSha256"] != self.first_frame_report_record_sha256:
                raise FidelityCheckpointError("controller witness authority join changed")
            assert self.baseline_requested_controller is not None
            if payload["buttons"] != self.baseline_requested_controller["buttons"] \
                    or payload["stickXyCxy"] != self.baseline_requested_controller["stickXyCxy"] \
                    or payload["triggerLrab"] != self.baseline_requested_controller["triggerLrab"]:
                raise FidelityCheckpointError(
                    "controller witness differed from the durable Rust Baseline request"
                )
        elif kind == "fidelity-accepted-owned":
            if not self.allow_capture_annotations:
                raise FidelityCheckpointError("capture annotations require a production v3 lock")
            if self.open_submission is not None or self.last_resolved_receipt is None:
                raise FidelityCheckpointError(
                    "Accepted ownership requires a resolved receipt and no open submission"
                )
            if identity != self.last_resolved_receipt:
                raise FidelityCheckpointError("Accepted resolved receipt identity changed")
            if self.witness_record_sha256 is None or self.accepted_record_sha256 is not None:
                raise FidelityCheckpointError("Accepted ownership cardinality/order changed")
            if payload["witnessRecordSha256"] != self.witness_record_sha256:
                raise FidelityCheckpointError("Accepted did not join the controller witness")
            if self.previous_record_sha256 != identity["receiptRecordSha256"]:
                raise FidelityCheckpointError("Accepted did not immediately annotate its receipt")
        elif kind == "fidelity-terminal":
            if not self.allow_capture_annotations or self.open_submission is not None:
                raise FidelityCheckpointError(
                    "terminal checkpoint requires production capture with no open submission"
                )
            if self.accepted_record_sha256 is None or self.terminal_record_sha256 is not None:
                raise FidelityCheckpointError("terminal fidelity checkpoint is out of order")
            if self.previous_record_sha256 != self.accepted_record_sha256:
                raise FidelityCheckpointError("terminal checkpoint did not immediately follow Accepted")
            if payload["baselineRecordSha256"] != self.baseline_record_sha256 \
                    or payload["acceptedRecordSha256"] != self.accepted_record_sha256:
                raise FidelityCheckpointError("terminal fidelity authority join changed")
            assert self.accepted_artifacts is not None
            for field in FIDELITY_ARTIFACT_FIELDS:
                if payload[field] != self.accepted_artifacts[field]:
                    raise FidelityCheckpointError(
                        f"$.{field} differed from the hard Accepted boundary"
                    )
            assert self.capture_run_policy is not None
            terminal_run_summary = validate_capture_run_summary(
                payload["runSummary"],
                self.capture_run_policy,
                "$.runSummary",
                True,
            )
            if terminal_run_summary["issuedRunCalls"] <= 0 \
                    or terminal_run_summary["witnessPublications"] != 1:
                raise FidelityCheckpointError(
                    "$.runSummary omitted run/witness authority"
                )

    def _commit_capture_state(
        self,
        payload: dict[str, Any],
        identity: dict[str, object] | None,
        record_sha256: str,
    ) -> None:
        kind = payload["kind"]
        if kind == "capture-machine-initialized":
            self.machine_session_id = payload["machineSessionId"]
            self.machine_initialization_record_sha256 = record_sha256
            self.capture_run_policy = payload["runPolicy"]
            self.initial_run_summary = payload["runSummary"]
        elif kind == "receipt-resolved":
            assert identity is not None
            self.last_resolved_receipt = {
                **identity,
                "receiptBytes": payload["receiptBytes"],
                "receiptSha256": payload["receiptSha256"],
                "presentedAfterResolution": payload["presentedAfterResolution"],
                "receiptRecordSha256": record_sha256,
            }
        elif kind == "first-frame-renderer-owned":
            self.first_frame_renderer_record_sha256 = record_sha256
            self.first_frame_receipt = identity
            self.first_frame_readback = {
                "readbackMetadataBytes": payload["readbackMetadataBytes"],
                "readbackMetadataSha256": payload["readbackMetadataSha256"],
                "rgbaBytes": payload["rgbaBytes"],
                "rgbaSha256": payload["rgbaSha256"],
            }
        elif kind == "fidelity-baseline-owned":
            self.baseline_record_sha256 = record_sha256
            self.baseline_requested_controller = {
                "buttons": payload["requestedButtons"],
                "stickXyCxy": payload["requestedStickXyCxy"],
                "triggerLrab": payload["requestedTriggerLrab"],
            }
        elif kind == "first-frame-report-bound":
            self.first_frame_report_record_sha256 = record_sha256
        elif kind == "controller-witness-published":
            self.witness_record_sha256 = record_sha256
        elif kind == "fidelity-accepted-owned":
            self.accepted_record_sha256 = record_sha256
            self.accepted_artifacts = {
                field: payload[field] for field in FIDELITY_ARTIFACT_FIELDS
            }
        elif kind == "fidelity-terminal":
            self.terminal_record_sha256 = record_sha256
            self.terminal_run_summary = payload["runSummary"]

    def append(
        self,
        payload_value: object,
        host_identity_sha256: str,
        known_games: set[str],
    ) -> dict[str, object]:
        payload, identity = validate_checkpoint(payload_value)
        sha256(host_identity_sha256, "host identity")
        with self.lock:
            if self.poisoned_error is not None:
                raise FidelityCheckpointError(
                    f"checkpoint journal is permanently poisoned: {self.poisoned_error}"
                )
            if self.server_sequence >= self.record_cap:
                raise FidelityCheckpointError("checkpoint record cap reached")
            state_before = (
                self.run_id,
                self.game_key,
                self.client_sequence,
                self.open_submission,
                self.submission_returned,
                self.probe_events,
                self.probe_events_this_submission,
                self.last_resolved_receipt,
                self.machine_session_id,
                self.machine_initialization_record_sha256,
                self.capture_run_policy,
                self.initial_run_summary,
                self.first_frame_renderer_record_sha256,
                self.first_frame_receipt,
                self.first_frame_readback,
                self.baseline_record_sha256,
                self.baseline_requested_controller,
                self.first_frame_report_record_sha256,
                self.witness_record_sha256,
                self.accepted_record_sha256,
                self.accepted_artifacts,
                self.terminal_record_sha256,
                self.terminal_run_summary,
            )
            file_length_before = self.file.tell()
            try:
                self._validate_sequence(payload, identity, known_games)
                payload_sha256 = sha256_hex(canonical_json(payload))
                record_core: dict[str, object] = {
                    "schema": DURABLE_RECORD_SCHEMA,
                    "serverSequence": self.server_sequence + 1,
                    "receivedAtUnixMs": int(time.time() * 1_000),
                    "hostIdentitySha256": host_identity_sha256,
                    "evidenceLockSha256": self.evidence_lock_sha256,
                    "previousRecordSha256": self.previous_record_sha256,
                    "payloadSha256": payload_sha256,
                    "payload": payload,
                }
                record_sha256 = sha256_hex(canonical_json(record_core))
                record = {**record_core, "recordSha256": record_sha256}
                self.file.write(canonical_json(record) + b"\n")
                self.file.flush()
                os.fsync(self.file.fileno())
            except Exception as commit_error:
                (
                    self.run_id,
                    self.game_key,
                    self.client_sequence,
                    self.open_submission,
                    self.submission_returned,
                    self.probe_events,
                    self.probe_events_this_submission,
                    self.last_resolved_receipt,
                    self.machine_session_id,
                    self.machine_initialization_record_sha256,
                    self.capture_run_policy,
                    self.initial_run_summary,
                    self.first_frame_renderer_record_sha256,
                    self.first_frame_receipt,
                    self.first_frame_readback,
                    self.baseline_record_sha256,
                    self.baseline_requested_controller,
                    self.first_frame_report_record_sha256,
                    self.witness_record_sha256,
                    self.accepted_record_sha256,
                    self.accepted_artifacts,
                    self.terminal_record_sha256,
                    self.terminal_run_summary,
                ) = state_before
                try:
                    os.ftruncate(self.file.fileno(), file_length_before)
                    self.file.seek(file_length_before)
                    os.fsync(self.file.fileno())
                except OSError as rollback_error:
                    self.poisoned_error = (
                        f"commit failed ({commit_error}); rollback failed ({rollback_error})"
                    )
                    raise FidelityCheckpointError(
                        f"checkpoint journal rollback failed and is permanently poisoned: "
                        f"{rollback_error}"
                    ) from commit_error
                raise
            self.server_sequence += 1
            self.client_sequence = payload["clientSequence"]
            self.previous_record_sha256 = record_sha256
            self._commit_capture_state(payload, identity, record_sha256)
            return {
                "schema": ACK_SCHEMA,
                "runId": self.run_id,
                "gameKey": self.game_key,
                "clientSequence": self.client_sequence,
                "serverSequence": self.server_sequence,
                "payloadSha256": payload_sha256,
                "recordSha256": record_sha256,
                "previousRecordSha256": record_core["previousRecordSha256"],
                "evidenceLockSha256": self.evidence_lock_sha256,
                "durable": True,
            }


def extract_option(name: str, default: str | None = None) -> str:
    occurrences = [index for index, value in enumerate(sys.argv[1:], start=1) if value == name]
    if len(occurrences) > 1:
        raise ValueError(f"duplicate {name}")
    if not occurrences:
        if default is None:
            raise ValueError(f"{name} is required")
        return default
    index = occurrences[0]
    if index + 1 >= len(sys.argv):
        raise ValueError(f"missing value after {name}")
    value = sys.argv[index + 1]
    del sys.argv[index:index + 2]
    return value


def peek_option(name: str) -> str:
    occurrences = [index for index, value in enumerate(sys.argv[1:], start=1) if value == name]
    if len(occurrences) != 1:
        raise ValueError(f"exactly one {name} is required")
    index = occurrences[0]
    if index + 1 >= len(sys.argv):
        raise ValueError(f"missing value after {name}")
    return sys.argv[index + 1]


def locked_source_snapshots(
    workspace: Path,
    records: object,
) -> dict[str, bytes]:
    workspace = workspace.resolve(strict=True)
    if not isinstance(records, dict) or not records:
        raise ValueError("evidence lock sources must be a non-empty object")
    snapshots: dict[str, bytes] = {}
    for relative, record in records.items():
        if (
            not isinstance(relative, str)
            or not relative
            or Path(relative).is_absolute()
            or ".." in Path(relative).parts
            or not isinstance(record, dict)
            or set(record) != {"bytes", "sha256"}
        ):
            raise ValueError(f"invalid locked source record {relative!r}")
        source = (workspace / relative).resolve(strict=True)
        try:
            source.relative_to(workspace)
        except ValueError as error:
            raise ValueError(f"locked source escaped workspace: {relative}") from error
        body = source.read_bytes()
        if len(body) != record["bytes"] or sha256_hex(body) != record["sha256"]:
            raise ValueError(f"locked source does not match evidence lock: {relative}")
        snapshots[relative] = body
    return snapshots


def locked_source_for_request(
    snapshots: dict[str, bytes],
    request_target: str,
) -> tuple[str, bytes] | None:
    parsed = urlsplit(request_target)
    if (
        parsed.scheme
        or parsed.netloc
        or parsed.fragment
        or not parsed.path.startswith("/")
        or parsed.path.startswith("//")
    ):
        return None
    relative = parsed.path[1:]
    body = snapshots.get(relative)
    if body is None:
        return None
    return relative, body


def host_identity_sha256(handler: corpus_server.ResidentCorpusHandler) -> str:
    identity = {
        "artifactManifestSha256": sha256_hex(handler.artifact_manifest),
        "corpusManifestSha256": sha256_hex(handler.corpus_manifest),
        "evidenceLockSha256": handler.checkpoint_journal.evidence_lock_sha256,
    }
    return sha256_hex(canonical_json(identity))


def main() -> None:
    checkpoint_path = Path(extract_option("--checkpoint-log"))
    evidence_lock_path = Path(extract_option("--evidence-lock")).resolve(strict=True)
    frozen_evidence_lock_bytes = evidence_lock_path.read_bytes()
    evidence_lock = validate_evidence_lock(json.loads(frozen_evidence_lock_bytes))
    evidence_lock_sha256 = sha256_hex(frozen_evidence_lock_bytes)
    workspace = Path(peek_option("--root")).resolve(strict=True)
    source_snapshots = locked_source_snapshots(workspace, evidence_lock.get("sources"))
    record_cap = int(extract_option("--checkpoint-record-cap", str(DEFAULT_RECORD_CAP)))
    body_cap = int(extract_option("--checkpoint-body-cap", str(DEFAULT_BODY_CAP)))
    probe_event_cap = int(
        extract_option("--checkpoint-probe-event-cap", str(DEFAULT_PROBE_EVENT_CAP))
    )
    if body_cap <= 0 or body_cap > DEFAULT_BODY_CAP:
        raise ValueError(f"--checkpoint-body-cap must be 1 through {DEFAULT_BODY_CAP}")
    if record_cap <= 0 or record_cap > DEFAULT_RECORD_CAP:
        raise ValueError(f"--checkpoint-record-cap must be 1 through {DEFAULT_RECORD_CAP}")
    production = evidence_lock["schema"] == PRODUCTION_EVIDENCE_LOCK_SCHEMA
    production_run = evidence_lock.get("run") if production else None
    journal = FidelityCheckpointJournal(
        checkpoint_path,
        record_cap,
        probe_event_cap,
        evidence_lock_sha256,
        expected_run_id=production_run["runId"] if production else None,
        expected_game_key=production_run["gameKey"] if production else None,
        allow_probe_events=not production,
        allow_capture_annotations=production,
    )
    if production:
        sys.argv.extend(["--execution-authority", str(evidence_lock_path)])
    base_handler = corpus_server.ResidentCorpusHandler

    class ResidentFidelityHandler(base_handler):
        checkpoint_journal = journal
        checkpoint_body_cap = body_cap
        evidence_lock_bytes = frozen_evidence_lock_bytes
        locked_source_snapshots = source_snapshots

        def serve(self) -> None:
            parsed = urlsplit(self.path)
            if parsed.path == EVIDENCE_LOCK_PATH and not parsed.query and not parsed.fragment:
                self.send_bytes(self.evidence_lock_bytes, "application/json")
                return
            if parsed.path.startswith("/resident-corpus/") or parsed.path.startswith(
                "/resident-artifacts/"
            ):
                super().serve()
                return
            if parsed.path in self.execution_assets:
                super().serve()
                return
            locked_source = locked_source_for_request(
                self.locked_source_snapshots,
                self.path,
            )
            if locked_source is None:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            relative, body = locked_source
            content_type = mimetypes.guess_type(relative)[0] or "application/octet-stream"
            self.send_bytes(body, content_type)

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlsplit(self.path)
            if parsed.path != CHECKPOINT_PATH or parsed.query or parsed.fragment:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            if self.headers.get_content_type() != "application/json":
                self.send_error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "application/json required")
                return
            raw_length = self.headers.get("Content-Length")
            if raw_length is None or not raw_length.isdecimal():
                self.send_error(HTTPStatus.LENGTH_REQUIRED, "bounded Content-Length required")
                return
            length = int(raw_length)
            if length <= 0 or length > self.checkpoint_body_cap:
                self.send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "checkpoint body cap exceeded")
                return
            body = self.rfile.read(length)
            if len(body) != length:
                self.send_error(HTTPStatus.BAD_REQUEST, "short checkpoint body")
                return
            try:
                payload = json.loads(body)
                ack = self.checkpoint_journal.append(
                    payload,
                    host_identity_sha256(self),
                    set(self.games),
                )
            except (FidelityCheckpointError, UnicodeDecodeError, json.JSONDecodeError) as error:
                self.send_error(HTTPStatus.BAD_REQUEST, str(error))
                return
            response = canonical_json(ack) + b"\n"
            self.send_bytes(response, "application/json")

    corpus_server.ResidentCorpusHandler = ResidentFidelityHandler
    try:
        corpus_server.main()
    finally:
        journal.close()


if __name__ == "__main__":
    main()
