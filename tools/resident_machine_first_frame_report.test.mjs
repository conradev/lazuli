// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FIRST_FRAME_CAPTURE_ORDER,
  FIRST_FRAME_REPORT_SCHEMA,
  PRODUCTION_FIRST_FRAME_CAPTURE_ORDER,
  validateResidentFirstFrameReport,
} from "./resident_machine_first_frame_report.mjs";
import {
  PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
  PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
  PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
} from "./resident_machine_fidelity_checkpoints.mjs";
import {
  fidelityNavigationPolicyFromSteps,
  productionFidelityNavigationPolicy,
} from "./resident_machine_fidelity_navigation.mjs";

const SHA = "a".repeat(64);
const PRODUCTION_EVIDENCE_LOCK = Object.freeze({
  schema: "lazuli-resident-renderer-fidelity-evidence-lock-v3",
  sha256: "e".repeat(64),
});

function artifact(bytes, sha256) {
  return { bytes, sha256 };
}

function machineEvidence({ serial, final = false }) {
  const words = new Uint32Array(204);
  const u64 = (index, value) => {
    const exact = BigInt(value);
    words[index] = Number(exact & 0xffff_ffffn);
    words[index + 1] = Number(exact >> 32n);
  };
  words[0] = 1;
  words[1] = 816;
  words[2] = 0x4c5a_4d45;
  words[3] = 1 | 16 | (final ? 4 : 0);
  u64(4, 1);
  u64(6, serial);
  u64(8, 1);
  u64(10, 1_459_978_240);
  words[12] = 0x475a_5745;
  words[13] = 0x3031_0000;
  words[14] = 3;
  words[18] = 1;
  words[31] = 0x8000_3100;
  u64(34, final ? 6 : 5);
  if (final) {
    u64(19, 2_000);
    u64(21, 2_000);
    u64(23, 1_000);
    u64(25, 2);
    u64(27, 1_000);
    u64(29, 2);
    u64(36, 1);
    u64(38, 1);
    for (const [index, value] of [
      [64, 1024], [66, 1], [68, 4], [70, 1], [72, 1], [74, 1],
      [92, 1], [94, 1], [106, 1500], [108, 1600], [110, 1700], [112, 1], [114, 1],
      [156, 1], [158, 1], [172, 1], [174, 1], [178, 1], [186, 1], [190, 1], [196, 1],
    ]) u64(index, value);
    words[105] = 1;
    words[116] = 1;
    words[120] = 1;
    words[121] = 2;
    words[122] = 2;
    words[123] = 4;
    words[124] = 2;
    words[125] = 2;
    words[126] = 4;
    words[127] = 2;
    words[128] = 1;
    words[129] = 2;
    words[130] = 2;
    words[131] = 2;
    words[132] = 1;
  }
  const bytes = Buffer.alloc(816);
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4));
  return {
    available: true,
    bytes: 816,
    encoding: "base64",
    payload: bytes.toString("base64"),
  };
}

function adapterDiagnostics({ final = false } = {}) {
  return {
    booted: true,
    memoryPages: 720,
    totalBootReads: 5,
    totalDiReads: final ? 1 : 0,
    totalRenderCalls: final ? 1 : 0,
    totalColdInstalls: final ? 3 : 0,
    pendingControllerSample: false,
    totalControllerRetries: 0,
    tableSlots: 65_536,
    machineEvidence: machineEvidence({ serial: final ? 4 : 1, final }),
  };
}

function mutateEvidenceWords(envelope, changes) {
  const bytes = Buffer.from(envelope.payload, "base64");
  for (const [index, value] of changes) bytes.writeUInt32LE(value >>> 0, index * 4);
  envelope.payload = bytes.toString("base64");
}

export function residentFirstFrameReportFixture() {
  const diagnosticsBefore = { drainCalls: 0, checkHealthCalls: 0, wasmBridgeCalls: 10 };
  const diagnosticsAfter = { drainCalls: 1, checkHealthCalls: 2, wasmBridgeCalls: 13 };
  return {
    status: "complete",
    schema: FIRST_FRAME_REPORT_SCHEMA,
    proof: "First renderer-owned GPU-completed presented XFB only",
    environment: {
      userAgent: "fixture Chrome",
      crossOriginIsolated: true,
      hardwareConcurrency: 8,
    },
    policy: {
      transport: "frozen-resident-machine-worker",
      evidenceMode: "first-renderer-owned-presented-xfb",
      instructionUpperCap: "100000000",
      executedCycleUpperCap: "250000000",
      canonicalCycleUpperCap: "250000000",
      sliceCycleUpperCap: "1000000",
      blockUpperCap: 16384,
      totalHostCallCap: 65535,
      totalColdInstallCap: 65535,
      maxBootReads: 8192,
      bootTimeoutMs: 180000,
      sliceTimeoutMs: 180000,
      runTimeoutMs: 600000,
      externalWallTimeoutMs: 600000,
      zeroProgressSliceCap: 4096,
    },
    artifacts: {
      schema: "lazuli-resident-corpus-artifacts-v1",
      artifacts: {
        "browser_machine.wasm": artifact(
          14945876,
          "e7249e3ccf22d5321cc8f90d2f8f1b9a3f695eefe6e3d66cb29c15bfad7d7de0",
        ),
        "browser_renderer.js": artifact(
          81486,
          "83cb322bb7d02e8062a7bb8804d76c94adc45c193950837f342444d9c6fb327d",
        ),
        "browser_renderer_bg.wasm": artifact(
          866635,
          "94cdf5ecfc8665af81208bf96dce7f1b1d640526139eb9efa6b7d520e4104b9c",
        ),
        "core_run_coordinator.wasm": artifact(
          362,
          "e0e22adfecbeb4e07b9fdd7c55c35edb3d9512b9e78a87dec52304cf6463a183",
        ),
        "resident_dispatcher.wasm": artifact(
          361408,
          "a6c963bab8b9591315dbb94ea6ba6085bd57870fdde933894fba6fb4af43abbe",
        ),
      },
    },
    corpus: {
      sourceCorpusSha256: "43597e441ab8c38adb18beed8ac34895a8496cac8ac2112ef4cb27c7504f4fc6",
      selectedGameKey: "warioware-usa",
    },
    fidelityCheckpointPolicy: {
      schema: "lazuli-resident-renderer-fidelity-checkpoint-v1",
      hook: "globalThis.__lazuliResidentRenderProbe",
      opaqueProbeWords: 6,
      checkpointTimeoutMs: 10_000,
      checkpointRecordCap: 65_535,
      probeEventCap: 32_768,
      probeEventPerSubmissionCap: 402,
    },
    evidenceLock: {
      schema: "lazuli-resident-renderer-fidelity-evidence-lock-v2",
      sha256: "e".repeat(64),
    },
    game: {
      status: "complete",
      game: {
        key: "warioware-usa",
        priority: 1,
        bytes: 889225792,
        sha256: "b8c33924afed0fec165afc3fe0d6e8dddfcdef53842fcae180560b3b904b4a81",
      },
      boot: { status: 3, reads: 5, wallMs: 10 },
      run: {
        wallMs: 20,
        slices: 2,
        rustBoundaries: 1,
        adapterCapBoundaries: 0,
        rustStopBoundaries: 0,
        instructionCapBoundaries: 0,
        executedCycleCapBoundaries: 0,
        canonicalCycleCapBoundaries: 0,
        hostCallCapBoundaries: 0,
        coldInstallCapBoundaries: 0,
        workerTimeoutBoundaries: 0,
        zeroProgressCapBoundaries: 0,
        zeroProgressSlices: 0,
        consecutiveZeroProgressSlices: 0,
        maximumConsecutiveZeroProgressSlices: 0,
        servicedHostCalls: 2,
        coldInstalls: 3,
        executedCycles: "2000",
        canonicalCycles: "2000",
        executedInstructions: "1000",
        outcomeDetails: { "0": 1 },
        complete: true,
        goalReached: true,
        instructionUpperCap: "100000000",
        executedCycleUpperCap: "250000000",
        canonicalCycleUpperCap: "250000000",
        instructionsPerSecond: 50000,
        cyclesPerSecond: 100000,
      },
      firstPresentedXfb: {
        trigger: {
          relayRequestId: 1,
          renderCallOrdinal: 1,
          requestFlags: 0,
          sequenceLo: 1,
          sequenceHi: 0,
          opaqueRequestBytes: 128,
          opaqueRequestSha256: SHA,
        },
      transition: {
        definition: "false-before-call-to-true-by-resolution",
        beforeCall: false,
        afterReturn: false,
        byResolution: true,
      },
        captureOrder: [...FIRST_FRAME_CAPTURE_ORDER],
        captureStartedAtMs: 100,
        captureCompletedAtMs: 110,
        diagnosticsBefore,
        diagnosticsAfter,
        readback: {
          metadata: {
            format: "rgba8unorm",
            layout: "top-left-row-major-tight",
            width: 2,
            height: 2,
            displayWidth: 2,
            displayHeight: 2,
            presentationSerial: 1,
            pairEpoch: 0,
            presentationMode: "progressive",
            scanoutPolicy: "direct",
            fields: { top: { generation: 1 } },
          },
          rgbaBytes: 16,
          rgbaSha256: SHA,
        },
        receipt: { bytes: 80, sha256: SHA, postedToWorker: true },
        acceptedByRust: true,
        acceptance: {
          enclosingWorkerRequestId: 2,
          enclosingSliceOrdinal: 2,
          diagnosticsTotalRenderCalls: 1,
          responseType: "resident-run-result",
        },
      },
      firstTransitionCaptures: 1,
      adapterDiagnostics: {
        ready: adapterDiagnostics(),
        final: adapterDiagnostics({ final: true }),
      },
      residentTotals: {
        bootPhysicalReads: 5,
        diPhysicalReads: 1,
        coldInstalls: 3,
        renderCalls: 1,
      },
      transport: {
        before: {
          gameKey: "warioware-usa",
          invalidRangeRequests: 0,
          physicalReadBytes: 0,
          physicalReadRequests: 0,
          preconditionFailures: 0,
          schema: "lazuli-resident-opaque-transport-v1",
        },
        after: {
          gameKey: "warioware-usa",
          invalidRangeRequests: 0,
          physicalReadBytes: 100,
          physicalReadRequests: 7,
          preconditionFailures: 0,
          schema: "lazuli-resident-opaque-transport-v1",
        },
        snapshotUnavailable: false,
      },
      renderer: {
        resetBeforeGame: true,
        diagnosticsResetBeforeGame: true,
        calls: 1,
        failures: 0,
        before: {},
        after: {},
      },
      faults: {
        rustStops: 0,
        instructionCaps: 0,
        executedCycleCaps: 0,
        canonicalCycleCaps: 0,
        hostCallCaps: 0,
        coldInstallCaps: 0,
        workerTimeouts: 0,
        zeroProgressCaps: 0,
        invalidRangeRequests: 0,
        preconditionFailures: 0,
        rendererFailures: 0,
      },
      inputSamples: 0,
      fidelityCheckpoints: {
        schema: "lazuli-resident-renderer-fidelity-checkpoint-v1",
        runId: "12345678-1234-4234-9234-123456789abc",
        gameKey: "warioware-usa",
        evidenceLockSha256: "e".repeat(64),
        recordCap: 65_535,
        probeEventCap: 32_768,
        recordCount: 4,
        probeEventCount: 1,
        probeEventPerSubmissionCap: 402,
        maximumProbeEventsPerSubmission: 1,
        probeRelayFailures: 0,
        kindCounts: {},
        navigationStepRecords: 0,
        navigationArmRecordSha256: null,
        firstRecordSha256: SHA,
        lastRecordSha256: SHA,
        lastServerSequence: 4,
        openSubmission: false,
        submissionReturned: false,
        failure: null,
      },
    },
    capabilityBoundary: {
      rawPhysicalRangesOnly: true,
      canonicalRendererReceiptsOnly: true,
      rendererOwnedRgbaReadbacks: 1,
      rawGuestMemoryReadbacks: 0,
      pixelMeaningInferences: 0,
      inputSamples: 0,
      browserSemanticArguments: 0,
      javascriptDispatchTableSets: 0,
      javascriptContainerParsers: 0,
      rendererProbeWordsInterpreted: 0,
      rawSixU32RendererProbeRelayOnly: true,
      machineEvidenceWordsInterpretedInBrowser: 0,
      opaqueMachineEvidenceTransportOnly: true,
      memoryViewsReacquiredByFrozenAdapterAfterAwait: true,
    },
    captureOrderContract: [...FIRST_FRAME_CAPTURE_ORDER],
  };
}

function productionFirstFrameReportFixture() {
  const report = residentFirstFrameReportFixture();
  report.evidenceLock = structuredClone(PRODUCTION_EVIDENCE_LOCK);
  Object.assign(report.policy, {
    instructionUpperCap: PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
    executedCycleUpperCap: PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
    canonicalCycleUpperCap: PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP,
    sliceCycleUpperCap: "8000000",
    blockUpperCap: 131_072,
    totalHostCallCap: 65_535,
    totalColdInstallCap: PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP,
    maxBootReads: 8_192,
    bootTimeoutMs: 180_000,
    sliceTimeoutMs: 180_000,
    runTimeoutMs: 7_200_000,
    externalWallTimeoutMs: 7_200_000,
    zeroProgressSliceCap: 4_096,
    navigationPolicy: productionFidelityNavigationPolicy(report.corpus.selectedGameKey),
  });
  Object.assign(report.game.run, {
    instructionUpperCap: PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP,
    executedCycleUpperCap: PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP,
    canonicalCycleUpperCap: PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP,
  });
  report.game.firstPresentedXfb.captureOrder = [...PRODUCTION_FIRST_FRAME_CAPTURE_ORDER];
  report.captureOrderContract = [...PRODUCTION_FIRST_FRAME_CAPTURE_ORDER];
  report.capabilityBoundary.rendererProbeEventsExpected = 0;
  report.game.fidelityCheckpoints.probeEventCount = 0;
  report.game.fidelityCheckpoints.maximumProbeEventsPerSubmission = 0;
  return report;
}

function cloned(value) {
  return structuredClone(value);
}

function failedReportFixture({ preCore = false } = {}) {
  const report = residentFirstFrameReportFixture();
  const complete = report.game;
  report.status = "failed";
  report.capabilityBoundary.rendererOwnedRgbaReadbacks = 0;
  report.game = {
    status: "failed",
    game: complete.game,
    phase: preCore ? "worker-setup" : "first-presented-xfb",
    error: preCore ? "typed setup failure" : "instruction cap reached",
    boundaryEvidence: { boundary: preCore ? "worker-setup-failure" : "instruction-cap" },
    boot: preCore ? null : complete.boot,
    firstPresentedXfb: null,
    firstTransitionCaptures: 0,
    captureFailure: null,
    lastAdapterDiagnostics: preCore ? null : adapterDiagnostics(),
    transport: complete.transport,
    renderer: {
      ...complete.renderer,
      calls: 0,
    },
    faults: {
      ...complete.faults,
      instructionCaps: preCore ? 0 : 1,
    },
    inputSamples: 0,
    fidelityCheckpoints: complete.fidelityCheckpoints,
  };
  return report;
}

test("complete first-presented-XFB evidence satisfies the strict schema", () => {
  const report = residentFirstFrameReportFixture();
  assert.doesNotThrow(() => validateResidentFirstFrameReport(report, { requireComplete: true }));
  report.capabilityBoundary.rendererOwnedRgbaReadbacks = 2;
  assert.throws(
    () => validateResidentFirstFrameReport(report, { requireComplete: true }),
    /rendererOwnedRgbaReadbacks/,
  );
});

test("MachineEvidence outer slices admit only reported internal host and cold continuations", () => {
  const coveredContinuation = residentFirstFrameReportFixture();
  mutateEvidenceWords(
    coveredContinuation.game.adapterDiagnostics.final.machineEvidence,
    [[29, coveredContinuation.game.run.slices + 1]],
  );
  assert.doesNotThrow(() => validateResidentFirstFrameReport(
    coveredContinuation,
    { requireComplete: true },
  ));

  const belowIssuedSlices = residentFirstFrameReportFixture();
  mutateEvidenceWords(
    belowIssuedSlices.game.adapterDiagnostics.final.machineEvidence,
    [[29, belowIssuedSlices.game.run.slices - 1]],
  );
  assert.throws(
    () => validateResidentFirstFrameReport(belowIssuedSlices, { requireComplete: true }),
    /outer-slice delta.*expected 2 through 7/,
  );

  const aboveReportedServices = residentFirstFrameReportFixture();
  const maximumCovered = aboveReportedServices.game.run.slices
    + aboveReportedServices.game.run.servicedHostCalls
    + aboveReportedServices.game.run.coldInstalls;
  mutateEvidenceWords(
    aboveReportedServices.game.adapterDiagnostics.final.machineEvidence,
    [[29, maximumCovered + 1]],
  );
  assert.throws(
    () => validateResidentFirstFrameReport(aboveReportedServices, { requireComplete: true }),
    /outer-slice delta.*expected 2 through 7/,
  );
});

test("an explicit exact artifact set can qualify a different immutable package", () => {
  const report = residentFirstFrameReportFixture();
  report.artifacts.artifacts["browser_machine.wasm"] = artifact(1234, SHA);
  const expectedArtifacts = structuredClone(report.artifacts.artifacts);
  assert.doesNotThrow(() => validateResidentFirstFrameReport(report, {
    requireComplete: true,
    expectedArtifacts,
  }));
  for (const changed of [
    { ...expectedArtifacts, extra: artifact(1, SHA) },
    Object.fromEntries(Object.entries(expectedArtifacts).slice(1)),
    {
      ...expectedArtifacts,
      "browser_machine.wasm": { ...expectedArtifacts["browser_machine.wasm"], extra: true },
    },
  ]) {
    assert.throws(
      () => validateResidentFirstFrameReport(report, {
        requireComplete: true,
        expectedArtifacts: changed,
      }),
      /expected exact keys/,
    );
  }
  assert.throws(
    () => validateResidentFirstFrameReport(report, { requireComplete: "yes" }),
    /requireComplete.*expected boolean/,
  );
  assert.throws(
    () => validateResidentFirstFrameReport(report, { unknown: true }),
    /unknown validation option/,
  );
});

test("standalone v2 validation retains the u16 cold-install ceiling", () => {
  const report = residentFirstFrameReportFixture();
  report.policy.totalColdInstallCap = 65_536;
  assert.throws(
    () => validateResidentFirstFrameReport(report, { requireComplete: true }),
    /totalColdInstallCap/,
  );
});

test("production validation requires an exact v3 lock reference and zero client probes", () => {
  const report = productionFirstFrameReportFixture();
  const expectedEvidenceLock = structuredClone(PRODUCTION_EVIDENCE_LOCK);
  assert.doesNotThrow(() => validateResidentFirstFrameReport(report, {
    requireComplete: true,
    expectedEvidenceLock,
  }));
  assert.equal(report.policy.instructionUpperCap, "16000000000");
  assert.equal(report.policy.executedCycleUpperCap, "32000000000");
  assert.equal(report.policy.canonicalCycleUpperCap, "32000000000");
  assert.equal(report.policy.sliceCycleUpperCap, "8000000");
  assert.equal(report.policy.blockUpperCap, 131_072);
  assert.equal(report.policy.runTimeoutMs, 7_200_000);
  assert.equal(report.policy.externalWallTimeoutMs, 7_200_000);
  assert.equal(report.policy.navigationPolicy.steps.length, 34);
  assert.deepEqual(report.policy.navigationPolicy.steps.at(-1), {
    minimumCanonicalDelay: "24324300",
    buttons: 0,
    stickXyCxy: 0x8080_8080,
    triggerLrab: 0,
  });
  report.policy.instructionUpperCap = "100000000";
  report.game.run.instructionUpperCap = "100000000";
  assert.throws(() => validateResidentFirstFrameReport(report, {
    requireComplete: true,
    expectedEvidenceLock,
  }), /instructionUpperCap/);
  report.policy.instructionUpperCap = PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP;
  report.game.run.instructionUpperCap = PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP;

  report.policy.canonicalCycleUpperCap = "250000000";
  report.game.run.canonicalCycleUpperCap = "250000000";
  assert.throws(() => validateResidentFirstFrameReport(report, {
    requireComplete: true,
    expectedEvidenceLock,
  }), /canonicalCycleUpperCap/);
  report.policy.canonicalCycleUpperCap = PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP;
  report.game.run.canonicalCycleUpperCap = PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP;

  for (const [field, stale] of [
    ["sliceCycleUpperCap", "1000000"],
    ["runTimeoutMs", 600_000],
    ["externalWallTimeoutMs", 600_000],
  ]) {
    const downgraded = cloned(report);
    downgraded.policy[field] = stale;
    assert.throws(() => validateResidentFirstFrameReport(downgraded, {
      requireComplete: true,
      expectedEvidenceLock,
    }), new RegExp(field));
  }

  const wrongSameTitleNavigation = cloned(report);
  wrongSameTitleNavigation.policy.navigationPolicy = fidelityNavigationPolicyFromSteps(
    "warioware-usa",
    [],
  );
  assert.throws(() => validateResidentFirstFrameReport(wrongSameTitleNavigation, {
    requireComplete: true,
    expectedEvidenceLock,
  }), /navigationPolicy/);

  const wrongNavigationTitle = cloned(report);
  wrongNavigationTitle.policy.navigationPolicy = productionFidelityNavigationPolicy(
    "luigis-mansion-usa",
  );
  assert.throws(() => validateResidentFirstFrameReport(wrongNavigationTitle, {
    requireComplete: true,
    expectedEvidenceLock,
  }), /navigationPolicy\.gameKey/);

  report.policy.totalColdInstallCap = PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP + 1;
  assert.throws(() => validateResidentFirstFrameReport(report, {
    requireComplete: true,
    expectedEvidenceLock,
  }), /totalColdInstallCap/);
  report.policy.totalColdInstallCap = PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP;

  report.capabilityBoundary.rendererOwnedRgbaReadbacks = 2;
  assert.doesNotThrow(() => validateResidentFirstFrameReport(report, {
    requireComplete: true,
    expectedEvidenceLock,
  }));
  for (const invalid of [0, 1.5, 3]) {
    report.capabilityBoundary.rendererOwnedRgbaReadbacks = invalid;
    assert.throws(
      () => validateResidentFirstFrameReport(report, {
        requireComplete: true,
        expectedEvidenceLock,
      }),
      /rendererOwnedRgbaReadbacks/,
    );
  }
  delete report.capabilityBoundary.rendererOwnedRgbaReadbacks;
  assert.throws(
    () => validateResidentFirstFrameReport(report, {
      requireComplete: true,
      expectedEvidenceLock,
    }),
    /rendererOwnedRgbaReadbacks/,
  );
  report.capabilityBoundary.rendererOwnedRgbaReadbacks = 1;

  report.game.fidelityCheckpoints.probeEventCount = 1;
  assert.throws(
    () => validateResidentFirstFrameReport(report, {
      requireComplete: true,
      expectedEvidenceLock,
    }),
    /probeEventCount/,
  );
  report.game.fidelityCheckpoints.probeEventCount = 0;
  assert.throws(
    () => validateResidentFirstFrameReport(report, {
      expectedEvidenceLock: { ...expectedEvidenceLock, extra: true },
    }),
    /expected exact keys/,
  );
  assert.throws(
    () => validateResidentFirstFrameReport(report, {
      expectedEvidenceLock: { ...expectedEvidenceLock, sha256: "f".repeat(64) },
    }),
    /evidenceLock\.sha256/,
  );
});

test("production capture order inserts only durable first-frame ownership", () => {
  assert.equal(FIRST_FRAME_CAPTURE_ORDER.length, 16);
  assert.equal(PRODUCTION_FIRST_FRAME_CAPTURE_ORDER.length, 17);
  const insertion = PRODUCTION_FIRST_FRAME_CAPTURE_ORDER.indexOf(
    "first-frame-renderer-owned-durable",
  );
  assert.equal(
    PRODUCTION_FIRST_FRAME_CAPTURE_ORDER[insertion - 1],
    "opaque-receipt-and-rgba-hashed",
  );
  assert.equal(
    PRODUCTION_FIRST_FRAME_CAPTURE_ORDER[insertion + 1],
    "opaque-receipt-posted-to-worker",
  );
  assert.deepEqual(
    PRODUCTION_FIRST_FRAME_CAPTURE_ORDER.filter(
      stage => stage !== "first-frame-renderer-owned-durable",
    ),
    FIRST_FRAME_CAPTURE_ORDER,
  );

  const expectedEvidenceLock = structuredClone(PRODUCTION_EVIDENCE_LOCK);
  const production = productionFirstFrameReportFixture();
  assert.doesNotThrow(() => validateResidentFirstFrameReport(production, {
    requireComplete: true,
    expectedEvidenceLock,
  }));

  for (const mutate of [
    report => report.game.firstPresentedXfb.captureOrder.splice(insertion, 1),
    report => report.game.firstPresentedXfb.captureOrder.splice(
      insertion,
      0,
      "first-frame-renderer-owned-durable",
    ),
    report => report.game.firstPresentedXfb.captureOrder.splice(
      insertion - 1,
      2,
      report.game.firstPresentedXfb.captureOrder[insertion],
      report.game.firstPresentedXfb.captureOrder[insertion - 1],
    ),
  ]) {
    const invalid = structuredClone(production);
    mutate(invalid);
    assert.throws(
      () => validateResidentFirstFrameReport(invalid, {
        requireComplete: true,
        expectedEvidenceLock,
      }),
      /captureOrder/,
    );
  }
});

test("all corpus titles receive an exact committed boot-identity check", () => {
  const report = residentFirstFrameReportFixture();
  report.corpus.selectedGameKey = "luigis-mansion-usa";
  Object.assign(report.game.game, {
    key: "luigis-mansion-usa",
    priority: 2,
    bytes: 199262784,
    sha256: "a868fd4bcf4d304aae74fb32ddb067e605d64db35e035c248a630d05a7d8ac4f",
  });
  report.game.transport.before.gameKey = "luigis-mansion-usa";
  report.game.transport.after.gameKey = "luigis-mansion-usa";
  report.game.fidelityCheckpoints.gameKey = "luigis-mansion-usa";
  for (const envelope of [
    report.game.adapterDiagnostics.ready.machineEvidence,
    report.game.adapterDiagnostics.final.machineEvidence,
  ]) mutateEvidenceWords(envelope, [[12, 0x474c_4d45]]);
  assert.doesNotThrow(() => validateResidentFirstFrameReport(report, { requireComplete: true }));
  mutateEvidenceWords(report.game.adapterDiagnostics.final.machineEvidence, [[12, 0x475a_5745]]);
  assert.throws(
    () => validateResidentFirstFrameReport(report, { requireComplete: true }),
    /committed boot identifier did not match/,
  );
});

test("complete evidence rejects missing or unaccepted first-transition capture", () => {
  for (const mutate of [
    report => { report.game.firstTransitionCaptures = 0; },
    report => { report.game.firstPresentedXfb.acceptedByRust = false; },
    report => { report.game.firstPresentedXfb.receipt.postedToWorker = false; },
    report => { report.game.firstPresentedXfb.captureOrder.splice(3, 1); },
  ]) {
    const report = cloned(residentFirstFrameReportFixture());
    mutate(report);
    assert.throws(() => validateResidentFirstFrameReport(report, { requireComplete: true }));
  }
});

test("complete evidence rejects cap, timeout, fault, and impossible progress mutations", () => {
  for (const mutate of [
    report => { report.game.run.instructionCapBoundaries = 1; },
    report => { report.game.run.workerTimeoutBoundaries = 1; },
    report => { report.game.faults.rendererFailures = 1; },
    report => { report.game.run.executedCycles = "0"; },
    report => { report.game.run.executedInstructions = "100000001"; },
    report => { report.game.run.instructionsPerSecond = 1; },
  ]) {
    const report = cloned(residentFirstFrameReportFixture());
    mutate(report);
    assert.throws(() => validateResidentFirstFrameReport(report, { requireComplete: true }));
  }
});

async function observeRustRunHarness() {
  const source = await readFile(
    new URL("./resident_machine_first_frame.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function observeRustRun(");
  const end = source.indexOf("\n\nasync function runUntilFirstPresentedXfb", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const observeRustRun = new Function(
    "policy",
    "ResidentFirstFrameError",
    `${source.slice(start, end)}; return observeRustRun;`,
  )(
    { zeroProgressSliceCap: 4_096 },
    class ResidentFirstFrameError extends Error {},
  );
  const run = {
    slices: 0,
    servicedHostCalls: 0,
    coldInstalls: 0,
    rustBoundaries: 0,
    adapterCapBoundaries: 0,
    rustStopBoundaries: 0,
    executedCycles: 0n,
    canonicalCycles: 0n,
    executedInstructions: 0n,
    outcomeDetails: Object.create(null),
    zeroProgressSlices: 0,
    consecutiveZeroProgressSlices: 0,
    maximumConsecutiveZeroProgressSlices: 0,
    zeroProgressCapBoundaries: 0,
  };
  return { observeRustRun, run };
}

test("semantic idle cycle progress does not consume the zero-progress slice budget", async () => {
  const { observeRustRun, run } = await observeRustRunHarness();
  observeRustRun(run, {
    boundary: "rust",
    hostCalls: 0,
    coldInstalls: 0,
    scheduler: {
      delta: {
        canonicalCycles: "100",
        executedCycles: "100",
        executedInstructions: "0",
        retiredBlocks: "1",
      },
    },
    outcome: { reason: 0, detail: 0 },
  });
  assert.equal(run.canonicalCycles, 100n);
  assert.equal(run.executedCycles, 100n);
  assert.equal(run.executedInstructions, 0n);
  assert.equal(run.zeroProgressSlices, 0);
  assert.equal(run.consecutiveZeroProgressSlices, 0);
  assert.equal(run.maximumConsecutiveZeroProgressSlices, 0);
});

test("authenticated host and cold work reset consecutive zero progress", async () => {
  const { observeRustRun, run } = await observeRustRunHarness();
  const result = (hostCalls, coldInstalls) => ({
    boundary: "rust",
    hostCalls,
    coldInstalls,
    scheduler: {
      delta: {
        canonicalCycles: "0",
        executedCycles: "0",
        executedInstructions: "0",
        retiredBlocks: "0",
      },
    },
    outcome: { reason: 0, detail: 0 },
  });

  observeRustRun(run, result(0, 0));
  assert.equal(run.zeroProgressSlices, 1);
  assert.equal(run.consecutiveZeroProgressSlices, 1);
  assert.equal(run.maximumConsecutiveZeroProgressSlices, 1);

  observeRustRun(run, result(1, 0));
  assert.equal(run.servicedHostCalls, 1);
  assert.equal(run.zeroProgressSlices, 1);
  assert.equal(run.consecutiveZeroProgressSlices, 0);

  observeRustRun(run, result(0, 0));
  assert.equal(run.zeroProgressSlices, 2);
  assert.equal(run.consecutiveZeroProgressSlices, 1);

  observeRustRun(run, result(0, 1));
  assert.equal(run.coldInstalls, 1);
  assert.equal(run.zeroProgressSlices, 2);
  assert.equal(run.consecutiveZeroProgressSlices, 0);
  assert.equal(run.maximumConsecutiveZeroProgressSlices, 1);
});

test("complete evidence rejects coordinated corpus, artifact, renderer, and transport rewrites", () => {
  for (const mutate of [
    report => {
      report.corpus.selectedGameKey = "luigis-mansion-usa";
      report.game.game.key = "luigis-mansion-usa";
    },
    report => { report.artifacts.artifacts["browser_machine.wasm"].sha256 = SHA; },
    report => { report.game.renderer.calls = 2; },
    report => { report.game.boot.status = 2; },
    report => { report.game.transport.after.physicalReadRequests = 8; },
    report => { report.game.firstPresentedXfb.diagnosticsAfter.drainCalls = 2; },
  ]) {
    const report = cloned(residentFirstFrameReportFixture());
    mutate(report);
    assert.throws(() => validateResidentFirstFrameReport(report, { requireComplete: true }));
  }
});

test("terminal reports require canonical available MachineEvidence after boot", () => {
  assert.doesNotThrow(() => validateResidentFirstFrameReport(failedReportFixture()));
  assert.doesNotThrow(() => validateResidentFirstFrameReport(failedReportFixture({ preCore: true })));

  const missingComplete = residentFirstFrameReportFixture();
  delete missingComplete.game.adapterDiagnostics.final.machineEvidence;
  assert.throws(
    () => validateResidentFirstFrameReport(missingComplete),
    /machineEvidence|exact keys/,
  );

  const unavailable = failedReportFixture();
  unavailable.game.lastAdapterDiagnostics.machineEvidence = {
    available: false,
    bytes: 816,
    encoding: "base64",
    payload: null,
  };
  assert.throws(() => validateResidentFirstFrameReport(unavailable), /available/);

  const missingAfterBoot = failedReportFixture();
  missingAfterBoot.game.lastAdapterDiagnostics = null;
  assert.throws(
    () => validateResidentFirstFrameReport(missingAfterBoot),
    /successful boot requires/,
  );
});

test("complete evidence binds report run totals to the Rust evidence transition", () => {
  for (const mutate of [
    report => { report.game.run.executedCycles = "2001"; },
    report => { report.game.run.executedInstructions = "1001"; },
    report => { report.game.run.slices = 3; report.game.run.rustBoundaries = 3; report.game.run.outcomeDetails["0"] = 3; },
    report => { report.game.adapterDiagnostics.final.machineEvidence.bytes = 812; },
  ]) {
    const report = residentFirstFrameReportFixture();
    mutate(report);
    assert.throws(() => validateResidentFirstFrameReport(report, { requireComplete: true }));
  }
});

test("complete evidence rejects pre-run work and cross-compensating adapter regressions", () => {
  const canonicalDrift = residentFirstFrameReportFixture();
  mutateEvidenceWords(
    canonicalDrift.game.adapterDiagnostics.ready.machineEvidence,
    [[19, 1]],
  );
  assert.throws(
    () => validateResidentFirstFrameReport(canonicalDrift, { requireComplete: true }),
    /canonical-cycle delta/,
  );

  const preRunRender = residentFirstFrameReportFixture();
  mutateEvidenceWords(
    preRunRender.game.adapterDiagnostics.ready.machineEvidence,
    [[92, 1], [94, 1], [105, 1]],
  );
  assert.throws(
    () => validateResidentFirstFrameReport(preRunRender, { requireComplete: true }),
    /ready machine-evidence renderer\.renderRequestsIssued/,
  );

  const adapterRegression = residentFirstFrameReportFixture();
  adapterRegression.game.adapterDiagnostics.ready.totalDiReads = 2;
  assert.throws(
    () => validateResidentFirstFrameReport(adapterRegression, { requireComplete: true }),
    /regressed from ready diagnostics/,
  );

  const diReceiptMismatch = residentFirstFrameReportFixture();
  mutateEvidenceWords(
    diReceiptMismatch.game.adapterDiagnostics.final.machineEvidence,
    [[186, 0], [190, 0]],
  );
  assert.throws(
    () => validateResidentFirstFrameReport(diReceiptMismatch, { requireComplete: true }),
    /DI host receipts succeeded/,
  );
});

test("relay captures the first renderer-owned XFB before posting its opaque receipt", async () => {
  const source = await readFile(
    new URL("./resident_machine_first_frame.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async captureFirstPresentedXfb(");
  const end = source.indexOf("\n  async render(message)", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const capture = source.slice(start, end);
  const fragments = [
    "const diagnosticsBefore = rendererSnapshot(this.renderer)",
    "await this.renderer.drain()",
    "this.renderer.check_health()",
    "await this.renderer.read_presented_xfb_rgba()",
    "this.renderer.check_health()",
    "const diagnosticsAfter = rendererSnapshot(this.renderer)",
    "sha256(rgba)",
    "sha256(receipt)",
  ];
  let previous = -1;
  for (const fragment of fragments) {
    const index = capture.indexOf(fragment, previous + 1);
    assert.ok(index > previous, `missing or out-of-order capture fragment: ${fragment}`);
    previous = index;
  }
  const relay = source.slice(end, source.indexOf("\n  confirmEnclosingRunAccepted", end));
  const sourceCopy = relay.indexOf("const source = ownedBytes(message.source");
  const sourceHash = relay.indexOf("sha256: await sha256(source)", sourceCopy);
  const preSubmit = relay.indexOf("await this.checkpoints.preSubmit(checkpointIdentity)", sourceHash);
  const submission = relay.indexOf("const submission = this.renderer.submit_resident_render(", preSubmit);
  const submitReturned = relay.indexOf("await this.checkpoints.submitReturned(", submission);
  const receiptResolved = relay.indexOf("const receipt = ownedBytes(await submission", submitReturned);
  const durableReceipt = relay.indexOf("await this.checkpoints.receiptResolved(", receiptResolved);
  assert.ok(
    sourceCopy >= 0
      && sourceHash > sourceCopy
      && preSubmit > sourceHash
      && submission > preSubmit
      && submitReturned > submission
      && receiptResolved > submitReturned
      && durableReceipt > receiptResolved,
  );
  assert.match(relay.slice(submission), /submit_resident_render\(\s*authenticatedRequest\.source,/);
  assert.ok(durableReceipt < relay.indexOf("await this.captureFirstPresentedXfb("));
  const durableFirstFrame = capture.indexOf("await this.checkpoints.firstFrameRendererOwned(");
  assert.ok(durableFirstFrame > previous);
  assert.ok(capture.indexOf('captureOrder.push("first-frame-renderer-owned-durable")') > durableFirstFrame);
  assert.ok(relay.indexOf("await this.captureFirstPresentedXfb(") < relay.indexOf("this.worker.postMessage({"));
  assert.deepEqual(FIRST_FRAME_CAPTURE_ORDER.slice(0, 7), [
    "opaque-request-copied-and-hashed",
    "pre-submit-durable",
    "submit-resident-render-returned",
    "submit-returned-durable",
    "submit-resident-render-resolved",
    "receipt-resolved-durable",
    "first-presented-xfb-transition",
  ]);
  for (const stage of FIRST_FRAME_CAPTURE_ORDER.slice(0, 7)) {
    assert.match(source, new RegExp(`"${stage}"`));
  }
  assert.match(source, /globalThis\.__lazuliResidentRenderProbe = function \(\.\.\.words\) \{/);
  assert.match(source, /rendererProbeEvent\(\.\.\.words\);[\s\S]*?catch \(error\) \{/);
  assert.doesNotMatch(source, /\.table\.set\s*\(/);
  assert.doesNotMatch(source, /\.memory\b|core_cpu_ptr|DataView/);
  assert.match(source, /new Worker\(workerUrl, \{ type: "module" \}\)/);
  assert.match(
    source,
    /workerUrl: production\s*\? lock\.release\.executionAssets\.worker\.url\s*: "\/web\/resident-machine-worker\.mjs"/,
  );
});

test("production page keeps query, ownership ACK, reuse, and controller APIs fail-closed", async () => {
  const source = await readFile(
    new URL("./resident_machine_first_frame.mjs", import.meta.url),
    "utf8",
  );
  const queryStart = source.indexOf("function requireExactProductionQuery(gameKey)");
  const queryEnd = source.indexOf("\n}", queryStart);
  const query = source.slice(queryStart, queryEnd);
  for (const fragment of [
    "entries.length !== 2",
    'parameters.getAll("capture").length !== 1',
    'parameters.get("capture") !== "fidelity"',
    'parameters.getAll("game").length !== 1',
    'parameters.get("game") !== gameKey',
  ]) assert.match(query, new RegExp(fragment.replace(/[()]/g, "\\$&")));
  assert.match(
    source,
    /const productionCaptureRequested = captureFidelityRequested\(\);/,
  );
  assert.match(
    source,
    /productionCaptureRequested\s*\? PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP\s*:\s*65_535/,
  );
  assert.match(
    source,
    /productionCaptureRequested\s*\? PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP\s*:\s*"250000000"/,
  );
  assert.match(
    source,
    /productionCaptureRequested\s*\? PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP\s*:\s*"100000000"/,
  );
  assert.match(
    source,
    /productionCaptureRequested\s*\? PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP\s*:\s*executedCycleUpperCapDefault/,
  );
  assert.equal(PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP, "16000000000");
  assert.equal(PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP, "32000000000");
  assert.equal(PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP, "32000000000");

  const observationStart = source.indexOf("async captureFidelityObservation(message)");
  const observationEnd = source.indexOf("\n  async render(message)", observationStart);
  const observation = source.slice(observationStart, observationEnd);
  const sameReceipt = observation.indexOf("if (sameFirstReceipt)");
  const distinctReadback = observation.indexOf("await this.renderer.read_presented_xfb_rgba()", sameReceipt);
  const durableOwnership = observation.indexOf("await this.checkpoints.fidelityPhaseOwned(", distinctReadback);
  const observationAck = observation.indexOf('type: "resident-fidelity-observation-ack"', durableOwnership);
  assert.ok(sameReceipt >= 0 && distinctReadback > sameReceipt);
  assert.match(observation.slice(sameReceipt, distinctReadback), /this\.firstFrameOwned\.rgba\.slice\(\)/);
  assert.ok(durableOwnership > distinctReadback && observationAck > durableOwnership);
  assert.ok(
    observation.indexOf("if (state.phase === 6)")
      < observation.indexOf("const capture = (async () =>"),
  );

  const apiStart = source.indexOf("function installProductionCaptureApi(client, game)");
  const apiEnd = source.indexOf("\nasync function main()", apiStart);
  const api = source.slice(apiStart, apiEnd);
  assert.match(api, /navigation: \(\.\.\.arguments_\) =>/);
  assert.match(api, /arguments_\.length !== 0/);
  assert.match(api, /await client\.publishNavigationController\(\)/);
  assert.doesNotMatch(api, /publishNavigationController\(controller\)/);

  const witnessStart = source.indexOf("async captureControllerWitness(message)");
  const witnessEnd = source.indexOf("\n  async stepRun()", witnessStart);
  const witness = source.slice(witnessStart, witnessEnd);
  const durableWitness = witness.indexOf("await this.checkpoints.controllerWitnessPublished(");
  const retainedWitness = witness.indexOf("this.preWitnessMachineEvidence = state.machineEvidence");
  const witnessAck = witness.indexOf('type: "resident-controller-witness-checkpoint-ack"');
  assert.ok(durableWitness >= 0 && retainedWitness > durableWitness && witnessAck > retainedWitness);

  const bind = source.indexOf("await activeProductionCapture.client.bindFirstFrameReport(finalReport)");
  const expose = source.indexOf("installProductionCaptureApi(activeProductionCapture.client, game)");
  assert.ok(bind >= 0 && expose > bind);
});

test("setup and late boot completion remain inside typed fixed-bound evidence", async () => {
  const source = await readFile(
    new URL("./resident_machine_first_frame.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function runGame(game, renderer, checkpoints, workerUrl)");
  const end = source.indexOf("\nasync function main()", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const runGame = source.slice(start, end);
  const tryIndex = runGame.indexOf("try {");
  for (const fragment of [
    "transportBefore = await transportSnapshot(game.key)",
    "renderer.reset()",
    "new Worker(workerUrl",
  ]) {
    assert.ok(runGame.indexOf(fragment) > tryIndex, `${fragment} must be inside the title try`);
  }
  const bootWall = runGame.indexOf("const bootWallMs = performance.now() - bootStartedAtMs");
  const lateGate = runGame.indexOf("if (bootWallMs > policy.bootTimeoutMs)", bootWall);
  const runPhase = runGame.indexOf('phase = "first-presented-xfb"', lateGate);
  assert.ok(bootWall >= 0 && lateGate > bootWall && runPhase > lateGate);
  assert.match(runGame, /boundary: "boot-timeout"/);
  assert.match(runGame, /boundary: `\$\{phase\}-failure`/);
  assert.match(runGame, /boundaryEvidence: typedError\.evidence/);
  assert.match(
    runGame,
    /canonicalFidelityJson\(ready\.diagnostics\?\.machineEvidence\)[\s\S]*?canonicalFidelityJson\(readyState\.machineEvidence\)/,
  );
  assert.match(runGame, /capture ready diagnostics changed the retained MachineEvidenceV1 snapshot/);
});
