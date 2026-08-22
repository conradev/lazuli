#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  GAME_COMPATIBILITY_RUNTIME_SCHEMA,
  verifyGameCompatibilitySnapshot,
  verifyGameCompatibilityWindow,
  verifyGameFirstVisibleFrameCompatibility,
} from "./browser_game_compatibility_oracle.mjs";

const EXACT_REQUIRED_PREPARATION_REJECTION_REASON_KEYS = [
  "invalidVertexLayout",
  "missingExactClipInput",
  "positionCountMismatch",
  "nonFiniteSourceVertex",
  "cullModeStateMismatch",
  "unsupportedMultisampling",
  "unsupportedZFreeze",
  "nonCanonicalSourceRaster",
  "unsupportedPostClipW",
  "unsupportedPostClipPosition",
  "unsupportedPostClipDepth",
  "clipInvalidComponentCount",
  "unsupportedTopology5",
  "unsupportedTopology6",
  "unsupportedTopology7",
  "unsupportedTopologyOther",
  "clipNoSourceTriangles",
  "clipInvalidCullMode",
  "clipInvalidViewportHeight",
  "clipNonFiniteVertex",
  "clipArithmeticOverflow",
  "projectionInvalidComponentCount",
  "projectionInvalidBpState",
  "projectionInvalidClipDisable",
  "unsupportedClipDisable1",
  "unsupportedClipDisable2",
  "unsupportedClipDisable3",
  "unsupportedClipDisable4",
  "unsupportedClipDisable5",
  "unsupportedClipDisable6",
  "unsupportedClipDisable7",
  "unsupportedClipDisableOther",
  "projectionInvalidViewport",
  "projectionInvalidScissor",
  "projectionNoVisibleScissor",
  "projectionWrappedScissor",
  "projectionNonFiniteVertex",
  "projectionZeroClipW",
  "projectionArithmeticOverflow",
  "invalidPreparedScissor",
  "uncertifiedFaceCull",
];

const zeroCountMap = keys =>
  Object.fromEntries(keys.map(key => [key, 0]));

function game() {
  return {
    key: "example-game",
    image: {
      format: "ciso",
      sha256: "a".repeat(64),
    },
    disc: {
      identifier: "GAME01",
      revision: 2,
    },
  };
}

function environment(surface = "local-debug") {
  return {
    surface,
    dataset: {
      renderer: "wgpu-webgpu",
      status: "running",
    },
    devtoolsExceptions: [],
    discImage: {
      algorithm: "sha256",
      format: "ciso",
      sha256: "a".repeat(64),
    },
  };
}

function report(offset = 0, overrides = {}) {
  const width = 640;
  const height = 448;
  const cycles = 100_000_000 + offset * 1_000_000_000;
  const generation = 3 + offset;
  const pairEpoch = 8 + offset;
  const serial = 2 + offset * 70;
  return {
    status: "running",
    stage: "snapshot",
    error: null,
    disc: {
      identifier: "GAME01",
      revision: 2,
      source: {
        kind: "logical-range-endpoint",
        url: "http://127.0.0.1:8765/disc",
      },
    },
    cycles,
    dispatches: 500_000 + offset * 1_000_000,
    instructions: 14_000_000 + offset * 20_000_000,
    execution: {
      scheduler: {
        rendererSync: {
          posted: 14 + offset * 200,
          acknowledged: 14 + offset * 200,
          failed: 0,
          inFlight: 0,
          highWater: 1,
          resultMisses: 0,
          textureCopyBarrier: {
            pendingSequence: null,
            pendingCycle: null,
            armed: 2 + offset,
            resumed: 2 + offset,
          },
        },
      },
    },
    deviceEvents: {
      diskRead: 30 + offset,
      dspAudioDmaStart: 1 + offset,
      dspAudioDmaBlock: 100 + offset * 1_000,
      serialPoll: 21 + offset * 140,
      viField: 11 + offset * 140,
    },
    exceptions: {
      counts: {
        "0x0500": 10 + offset,
        "0x0800": 20 + offset,
        "0x0900": 30 + offset,
        "0x0c00": 40 + offset,
      },
    },
    diskCommands: {
      lastError: "0x00000000",
    },
    controller: {
      appliedSequence: 2 + offset * 2,
      queueOverflows: 0,
    },
    serialInterface: {
      unknownOutputCommands: 0,
    },
    audioCompatibility: {
      dspLle: {
        backend: "lle-wasm",
        abi: 1,
        slices: 1_000 + offset * 10_000,
        budgetedInstructions: Math.floor(cycles / 12),
        executedInstructions: 60_000 + offset * 600_000,
        lastExecutionCycle: cycles,
        pendingCpuCycles: cycles % 12,
        lastServiceCycle: cycles,
        nextExecutionCycle: cycles + 768 - (cycles % 12),
        lastStopReason: {
          code: 3,
          name: "cpu-mailbox-empty",
        },
        stopReasonCounts: {
          "instruction-budget": 900 + offset * 9_000,
          "cpu-mailbox-empty": 100 + offset * 1_000,
        },
        pc: 0x0100,
        cpuMailboxWrites: 4 + offset * 10,
        cpuMailboxReads: 4 + offset * 10,
        cpuMailboxHighWrites: 1 + offset,
        mailboxReadAccesses: 5 + offset * 10,
        dspMailboxWrites: 4 + offset * 10,
        dspMailboxReads: 4 + offset * 10,
        dspInterruptAssertions: 2 + offset,
        fault: null,
      },
      dtkFirstUnsupported: null,
    },
    gxFifo: {
      bytes: 3_320 + offset * 10_000,
      staging: {
        drains: 282 + offset * 200,
        emergencyDrains: 0,
        pendingBytes: 0,
      },
      decoder: {
        commands: 529 + offset * 1_000,
        primitives: 2 + offset * 300,
        xfbCopyCount: generation,
        framesPresented: 11 + offset * 140,
        displayListErrors: 0,
        droppedVertices: 0,
        exactRequiredCaptureMisses: 0,
        legacyProjectionNullVertices: 0,
        lightingRejectedVertices: 0,
        texgenFallbacks: 0,
        unknownOpcodes: 0,
        vertexDecodeErrors: 0,
        deferredDisplayListSegments: 0,
        textureCopyBarrierStops: 2 + offset,
        textureCopyBarrierResumes: 2 + offset,
        unsupported: {
          schema: "lazuli-gx-unsupported-v1",
          totalEvents: 0,
          firstEvent: null,
          reasonCounts: [],
          addressCounts: [],
          reasonKeyLimit: 32,
          countLimit: 0xffff_ffff,
          untrackedReasonEvents: 0,
        },
        maximumBufferedBytes: 16 * 1024 * 1024,
        bufferedBytes: 0,
        capacityWatermarkBytes: 4096,
        preDecodeHighWaterBytes: 101,
        retryAtBufferedBytes: 1,
        textures: {
          decodeErrors: 0,
          tlutErrors: 0,
        },
      },
    },
    mmioState: {
      dspAudioDma: {
        enabled: true,
        configuredBlocks: 16,
        remainingBlocks: 8,
        blocksLeft: 7,
        cyclesPerBlock: 80_928,
        nextInterruptCycle: null,
        nextCycle: 100_000_000 + offset * 1_000_000_000 + 80_928,
      },
      viInterruptModel: {
        hostPresentationCount: 2 + offset * 70,
        lastHostPresentationAddress: `0x${(0x0041_ce80 + offset * 0x1000)
          .toString(16).padStart(8, "0")}`,
        lastHostPresentationCopyIndex: generation,
        lastHostPresentationCopyRow: offset % 2,
        lastHostPresentationPairEpoch: pairEpoch,
        lastHostPresentationSerial: serial,
      },
    },
    rendering: {
      backend: "wgpu-webgpu",
      error: null,
      metrics: {
        scope: "current-worker",
        operations: {
          pending: 0,
          highWater: 1,
        },
        webgpu: {
          checkHealthCalls: 14 + offset * 200,
          copyXfbCalls: generation,
          drainCalls: 14 + offset * 200,
          presentXfbCalls: 11 + offset * 140,
          exactRequiredRejectedDraws: 0,
          exactRequiredRejectionReasons: {
            exactPreparation: 0,
            scissor: 0,
            primitive: 0,
            earlyDepth: 0,
            rasterCenter: 0,
            depthEncoding: 0,
            tevState: 0,
            textureCoordinates: 0,
            sampler: 0,
            zTexture: 0,
            fog: 0,
            fullyCulled: 0,
            managedPayload: 0,
            unclassified: 0,
          },
          exactRequiredPreparationRejectionReasons: zeroCountMap(
            EXACT_REQUIRED_PREPARATION_REJECTION_REASON_KEYS,
          ),
        },
      },
      selectedXfb: {
        address: `0x${(0x0041_ce80 + offset * 0x1000)
          .toString(16).padStart(8, "0")}`,
        generation,
        row: offset % 2,
        pairEpoch,
        presentationSerial: serial,
        width,
        height,
        format: "rgba8unorm",
        layout: "top-left-row-major-tight",
        rgbaByteLength: width * height * 4,
        rgbaSha256: String(offset + 1).repeat(64),
        rgbSha256: String(offset + 2).repeat(64),
        rgb: {
          black: width * height - 10_000,
          white: 0,
          other: 10_000,
          unique: 32,
        },
      },
    },
    ...overrides,
  };
}

function sample(offset = 0, surface = "local-debug") {
  const value = report(offset);
  if (surface === "public-root") {
    value.disc.source = { kind: "local-file" };
  }
  return {
    environment: environment(surface),
    report: value,
  };
}

function addResolvedStorageFaults(value, {
  dataPage = 1_600,
  dataProtection = 147,
  instructionPage = 113,
  instructionProtection = 0,
} = {}) {
  const data = dataPage + dataProtection;
  const instruction = instructionPage + instructionProtection;
  const raised = data + instruction;
  value.report.exceptions.counts["0x0300"] = data;
  value.report.exceptions.counts["0x0400"] = instruction;
  const lastIsInstruction = instruction !== 0;
  const lastIsProtection = lastIsInstruction
    ? instructionProtection !== 0
    : dataProtection !== 0;
  const classification = lastIsInstruction
    ? lastIsProtection
      ? "instruction-protection-fault"
      : "instruction-page-fault"
    : lastIsProtection
      ? "data-protection-fault"
      : "data-page-fault";
  value.report.exceptions.criticalStorageFaults = {
    schema: "lazuli-critical-storage-fault-health-v1",
    raised,
    handlerReturns: raised,
    resolved: raised,
    recurrences: 0,
    nested: 0,
    classifications: {
      "data-page-fault": dataPage,
      "data-protection-fault": dataProtection,
      "instruction-page-fault": instructionPage,
      "instruction-protection-fault": instructionProtection,
      unsupported: 0,
    },
    maxHandlerDispatches: 37,
    maxHandlerCycles: 901,
    pending: null,
    lastResolved: {
      address: lastIsInstruction ? "0x7fc0f7a4" : "0x7f3f0000",
      attempts: 1,
      cause: lastIsProtection ? "0x08000000" : "0x40000000",
      classification,
      handlerCycles: 700,
      handlerDispatches: 31,
      pc: lastIsInstruction ? "0x7fc0f7a4" : "0x7fc23b98",
      reason: "retry-dispatch-complete",
      sequence: raised,
      vector: lastIsInstruction ? "0x0400" : "0x0300",
    },
  };
  return value;
}

function makeInvisible(value, { blackAndWhite = false } = {}) {
  const selected = value.report.rendering.selectedXfb;
  const pixels = selected.width * selected.height;
  selected.rgb = blackAndWhite
    ? { black: pixels - 1, white: 1, other: 0, unique: 2 }
    : { black: pixels, white: 0, other: 0, unique: 1 };
  return value;
}

test("strict snapshot accepts private local WebGPU evidence", () => {
  assert.equal(
    GAME_COMPATIBILITY_RUNTIME_SCHEMA,
    "lazuli-game-compatibility-runtime-v3",
  );
  const verified = verifyGameCompatibilitySnapshot({
    ...sample(),
    game: game(),
  });
  assert.deepEqual(verified, {
    game: "example-game",
    image: "a".repeat(64),
    progress: {
      controllerAppliedSequence: 2,
      cycles: 100_000_000,
      dataStorageFaults: 0,
      diskReads: 30,
      dispatches: 500_000,
      dspBudgetedInstructions: 8_333_333,
      dspServiceCycles: 100_000_000,
      dspSlices: 1_000,
      gxCommands: 529,
      hostPresentations: 2,
      instructions: 14_000_000,
      instructionStorageFaults: 0,
      presentationSerial: 2,
      primitives: 2,
      rendererPresents: 11,
      rgbSha256: "2".repeat(64),
      siPolls: 21,
      viFields: 11,
      xfbCopies: 3,
    },
    schema: GAME_COMPATIBILITY_RUNTIME_SCHEMA,
    surface: "local-debug",
  });
});

test("snapshot accepts only fully returned and retry-resolved VM storage faults", () => {
  const value = addResolvedStorageFaults(sample());
  const verified = verifyGameCompatibilitySnapshot({ ...value, game: game() });
  assert.equal(verified.progress.dataStorageFaults, 1_747);
  assert.equal(verified.progress.instructionStorageFaults, 113);

  const cases = [
    [
      candidate => { delete candidate.report.exceptions.criticalStorageFaults; },
      /criticalStorageFaults.*expected an object/,
    ],
    [
      candidate => { candidate.report.exceptions.criticalStorageFaults.handlerReturns -= 1; },
      /handlerReturns/,
    ],
    [
      candidate => { candidate.report.exceptions.criticalStorageFaults.resolved -= 1; },
      /resolved/,
    ],
    [
      candidate => { candidate.report.exceptions.criticalStorageFaults.recurrences = 1; },
      /recurrences/,
    ],
    [
      candidate => { candidate.report.exceptions.criticalStorageFaults.nested = 1; },
      /nested/,
    ],
    [
      candidate => {
        candidate.report.exceptions.criticalStorageFaults.pending = {
          phase: "handler",
        };
      },
      /pending/,
    ],
    [
      candidate => {
        const health = candidate.report.exceptions.criticalStorageFaults;
        health.classifications.unsupported = 1;
        health.classifications["data-page-fault"] -= 1;
      },
      /unsupported|data-sum/,
    ],
    [
      candidate => {
        candidate.report.exceptions.criticalStorageFaults
          .lastResolved.cause = "0x10000000";
      },
      /syndrome/,
    ],
    [
      candidate => {
        candidate.report.exceptions.criticalStorageFaults
          .lastResolved.sequence -= 1;
      },
      /sequence/,
    ],
  ];
  for (const [mutate, pattern] of cases) {
    const invalid = addResolvedStorageFaults(sample());
    mutate(invalid);
    assert.throws(
      () => verifyGameCompatibilitySnapshot({ ...invalid, game: game() }),
      pattern,
    );
  }
});

test("public-root evidence requires a local file upload", () => {
  assert.equal(
    verifyGameCompatibilitySnapshot({
      ...sample(0, "public-root"),
      game: game(),
    }).surface,
    "public-root",
  );
  const invalid = sample(0, "public-root");
  invalid.report.disc.source = {
    kind: "logical-range-endpoint",
    url: "http://127.0.0.1:8765/disc",
  };
  assert.throws(
    () => verifyGameCompatibilitySnapshot({ ...invalid, game: game() }),
    /public root must use a local file upload/,
  );
});

test("logical range evidence cannot escape the local debug harness", () => {
  for (const url of [
    "https://gekko.free/disc",
    "http://192.168.1.2/disc",
    "http://127.0.0.1:8765/game",
    "http://127.0.0.1:8765/disc?game=example",
  ]) {
    const invalid = sample();
    invalid.report.disc.source.url = url;
    assert.throws(
      () => verifyGameCompatibilitySnapshot({ ...invalid, game: game() }),
      /exact loopback \/disc endpoint/,
      url,
    );
  }
});

test("snapshot fails closed on renderer, device, queue, GX, and XFB faults", () => {
  const cases = [
    [value => { value.environment.dataset.renderer = "canvas-2d"; }, /wgpu-webgpu/],
    [value => { value.environment.devtoolsExceptions.push({ text: "boom" }); }, /DevTools/],
    [value => { value.environment.discImage.sha256 = "b".repeat(64); }, /discImage\.sha256/],
    [value => { value.report.rendering.error = "device lost"; }, /renderer error/],
    [value => { value.report.execution.scheduler.rendererSync.failed = 1; }, /expected zero/],
    [value => { value.report.execution.scheduler.rendererSync.acknowledged -= 1; }, /acknowledged/],
    [value => { value.report.rendering.metrics.operations.pending = 1; }, /expected zero/],
    [
      value => {
        value.report.rendering.metrics.webgpu.exactRequiredRejectedDraws = 1;
        value.report.rendering.metrics.webgpu
          .exactRequiredRejectionReasons.unclassified = 1;
      },
      /expected zero/,
    ],
    [value => { value.report.deviceEvents.diskDeviceError = 1; }, /diskDeviceError/],
    [value => { value.report.deviceEvents.dspAudioDmaStart = 0; }, /dspAudioDmaStart/],
    [value => { value.report.deviceEvents.dspAudioDmaBlock = 0; }, /dspAudioDmaBlock/],
    [
      value => { value.report.exceptions.counts["0x0300"] = 1; },
      /0x0300|criticalStorageFaults/,
    ],
    [value => { value.report.diskCommands.lastError = "0x00000001"; }, /lastError/],
    [value => { value.report.controller.queueOverflows = 1; }, /queueOverflows/],
    [value => { value.report.serialInterface.unknownOutputCommands = 1; }, /unknownOutputCommands/],
    [value => { value.report.gxFifo.staging.emergencyDrains = 1; }, /emergencyDrains/],
    [value => { value.report.gxFifo.decoder.unknownOpcodes = 1; }, /unknownOpcodes/],
    [value => { value.report.gxFifo.decoder.textures.decodeErrors = 1; }, /decodeErrors/],
    [value => { value.report.rendering.selectedXfb.generation += 1; }, /selectedXfb\.generation/],
    [value => { value.report.rendering.selectedXfb.rgb.other = 0; }, /rgb\.other/],
  ];
  for (const [mutate, pattern] of cases) {
    const invalid = sample();
    mutate(invalid);
    assert.throws(
      () => verifyGameCompatibilitySnapshot({ ...invalid, game: game() }),
      pattern,
    );
  }
});

test("runtime v3 fails closed on pending barriers and incompatible hardware", () => {
  const cases = [
    [
      value => { delete value.report.execution.scheduler.rendererSync.textureCopyBarrier; },
      /textureCopyBarrier.*expected an object/,
    ],
    [
      value => {
        value.report.execution.scheduler.rendererSync
          .textureCopyBarrier.pendingSequence = 9;
      },
      /pendingSequence.*expected null/,
    ],
    [
      value => {
        value.report.execution.scheduler.rendererSync
          .textureCopyBarrier.pendingCycle = 9;
      },
      /pendingCycle.*expected null/,
    ],
    [
      value => {
        value.report.execution.scheduler.rendererSync
          .textureCopyBarrier.armed = -1;
      },
      /textureCopyBarrier\.armed.*non-negative safe integer/,
    ],
    [
      value => {
        value.report.execution.scheduler.rendererSync
          .textureCopyBarrier.resumed -= 1;
      },
      /textureCopyBarrier\.resumed/,
    ],
    [
      value => { value.report.gxFifo.decoder.deferredDisplayListSegments = 1; },
      /deferredDisplayListSegments.*expected 0/,
    ],
    [
      value => { delete value.report.gxFifo.decoder.deferredDisplayListSegments; },
      /deferredDisplayListSegments.*expected 0/,
    ],
    [
      value => { value.report.gxFifo.decoder.textureCopyBarrierStops = -1; },
      /textureCopyBarrierStops.*non-negative safe integer/,
    ],
    [
      value => { value.report.gxFifo.decoder.textureCopyBarrierResumes -= 1; },
      /textureCopyBarrierResumes/,
    ],
    [
      value => {
        value.report.gxFifo.decoder.textureCopyBarrierStops += 1;
        value.report.gxFifo.decoder.textureCopyBarrierResumes += 1;
      },
      /textureCopyBarrierStops/,
    ],
    [
      value => { delete value.report.audioCompatibility; },
      /audioCompatibility.*expected an object/,
    ],
    [value => { delete value.report.audioCompatibility.dspLle; }, /dspLle.*expected an object/],
    [value => { value.report.audioCompatibility.dspLle.backend = "hle"; }, /dspLle\.backend/],
    [value => { value.report.audioCompatibility.dspLle.abi = 2; }, /dspLle\.abi/],
    [value => { value.report.audioCompatibility.dspLle.slices = 0; }, /dspLle\.slices/],
    [
      value => { value.report.audioCompatibility.dspLle.budgetedInstructions = 0; },
      /dspLle\.budgetedInstructions/,
    ],
    [
      value => { value.report.audioCompatibility.dspLle.executedInstructions = 0; },
      /dspLle\.executedInstructions/,
    ],
    [
      value => {
        const dsp = value.report.audioCompatibility.dspLle;
        dsp.slices = Math.floor(dsp.budgetedInstructions / 64) + 1;
      },
      /at least 64 budgeted instructions/,
    ],
    [
      value => {
        value.report.audioCompatibility.dspLle.executedInstructions =
          value.report.audioCompatibility.dspLle.budgetedInstructions + 1;
      },
      /no more executed instructions/,
    ],
    [value => { value.report.audioCompatibility.dspLle.pendingCpuCycles = -1; }, /pendingCpuCycles/],
    [value => { value.report.audioCompatibility.dspLle.pendingCpuCycles = 768; }, /0 through 767/],
    [
      value => { value.report.audioCompatibility.dspLle.lastServiceCycle -= 1; },
      /exact cumulative budget and pending-cycle accounting/,
    ],
    [
      value => { value.report.cycles += 1; },
      /lastExecutionCycle <= lastServiceCycle === report\.cycles/,
    ],
    [
      value => { value.report.audioCompatibility.dspLle.lastExecutionCycle += 1; },
      /lastExecutionCycle/,
    ],
    [
      value => { value.report.audioCompatibility.dspLle.lastExecutionCycle = 0; },
      /last execution cycle to match the cumulative instruction budget/,
    ],
    [
      value => { value.report.audioCompatibility.dspLle.nextExecutionCycle -= 1; },
      /next coherent 768-CPU-cycle DSP boundary/,
    ],
    [
      value => { value.report.audioCompatibility.dspLle.lastStopReason.code = 4; },
      /non-fault DSP stop reason from 0 through 3/,
    ],
    [
      value => { value.report.audioCompatibility.dspLle.lastStopReason.name = "halted"; },
      /lastStopReason\.name/,
    ],
    [value => { value.report.audioCompatibility.dspLle.fault = {}; }, /dspLle\.fault/],
    [value => { value.report.audioCompatibility.dspLle.pc = "0x0100"; }, /dspLle\.pc/],
    [value => { value.report.audioCompatibility.dspLle.pc = 0x1_0000; }, /unsigned 16-bit/],
    [value => { value.report.audioCompatibility.dspLle.cpuMailboxWrites = 0; }, /cpuMailboxWrites/],
    [value => { value.report.audioCompatibility.dspLle.cpuMailboxReads = 0; }, /cpuMailboxReads/],
    [
      value => {
        const dsp = value.report.audioCompatibility.dspLle;
        dsp.cpuMailboxReads = dsp.cpuMailboxWrites + 1;
      },
      /no more DSP consumes than CPU mailbox commits/,
    ],
    [value => { value.report.audioCompatibility.dspLle.dspMailboxWrites = 0; }, /dspMailboxWrites/],
    [value => { value.report.audioCompatibility.dspLle.dspMailboxReads = 0; }, /dspMailboxReads/],
    [
      value => {
        const dsp = value.report.audioCompatibility.dspLle;
        dsp.dspMailboxReads = dsp.dspMailboxWrites + 1;
      },
      /no more consuming reads than DSP mailbox writes/,
    ],
    [
      value => {
        const dsp = value.report.audioCompatibility.dspLle;
        dsp.dspMailboxWrites = dsp.dspMailboxReads + 2;
      },
      /at most one unread value in the single-slot DSP mailbox/,
    ],
    [value => { value.report.audioCompatibility.dspLle.cpuMailboxHighWrites = -1; }, /cpuMailboxHighWrites/],
    [value => { value.report.audioCompatibility.dspLle.mailboxReadAccesses = 3; }, /mailboxReadAccesses/],
    [value => { value.report.audioCompatibility.dspLle.dspInterruptAssertions = -1; }, /dspInterruptAssertions/],
    [
      value => { value.report.audioCompatibility.dspLle.stopReasonCounts.future = 1; },
      /stopReasonCounts\.future/,
    ],
    [
      value => { value.report.audioCompatibility.dspLle.stopReasonCounts["instruction-budget"] -= 1; },
      /stopReasonCounts.*expected 1000/,
    ],
    [value => { value.report.mmioState.dspAudioDma.enabled = false; }, /dspAudioDma\.enabled/],
    [value => { value.report.mmioState.dspAudioDma.configuredBlocks = 0; }, /configuredBlocks/],
    [value => { value.report.mmioState.dspAudioDma.remainingBlocks = 17; }, /remainingBlocks/],
    [value => { value.report.mmioState.dspAudioDma.blocksLeft = 8; }, /blocksLeft/],
    [value => { value.report.mmioState.dspAudioDma.cyclesPerBlock = 0; }, /cyclesPerBlock/],
    [value => { value.report.mmioState.dspAudioDma.nextCycle = value.report.cycles; }, /nextCycle/],
    [
      value => { value.report.audioCompatibility.dspFirstUnsupported = null; },
      /legacy HLE evidence to be absent/,
    ],
    [
      value => { value.report.mmioState.dspUcodeHash = "0xe2136399"; },
      /legacy HLE evidence to be absent/,
    ],
    [
      value => { value.report.mmioState.dspTrace = []; },
      /dspTrace.*legacy HLE evidence to be absent/,
    ],
    [
      value => { value.report.deviceEvents.dspAxVoiceFallback = 1; },
      /dspAxVoiceFallback.*legacy or unknown DSP event evidence to be absent/,
    ],
    [
      value => { value.report.deviceEvents.dspAxVoiceRender = 1; },
      /dspAxVoiceRender.*legacy or unknown DSP event evidence to be absent/,
    ],
    [
      value => {
        value.report.audioCompatibility.dtkFirstUnsupported = { reason: "opcode" };
      },
      /dtkFirstUnsupported.*expected null/,
    ],
  ];
  for (const [mutate, pattern] of cases) {
    const invalid = sample();
    mutate(invalid);
    assert.throws(
      () => verifyGameCompatibilitySnapshot({ ...invalid, game: game() }),
      pattern,
    );
  }
});

test("runtime v3 requires canonical clear GX unsupported telemetry", () => {
  const cases = [
    [value => { delete value.report.gxFifo.decoder.unsupported; }, /unsupported.*expected an object/],
    [value => { value.report.gxFifo.decoder.unsupported = null; }, /unsupported.*expected an object/],
    [value => { delete value.report.gxFifo.decoder.unsupported.schema; }, /unsupported\.\[keys\]/],
    [value => { value.report.gxFifo.decoder.unsupported.schema = "future"; }, /unsupported\.schema/],
    [value => { value.report.gxFifo.decoder.unsupported.totalEvents = 1; }, /totalEvents.*expected 0/],
    [value => { value.report.gxFifo.decoder.unsupported.firstEvent = {}; }, /firstEvent.*expected null/],
    [value => { value.report.gxFifo.decoder.unsupported.reasonCounts.push({ reason: "x", count: 1 }); }, /reasonCounts\.length/],
    [value => { value.report.gxFifo.decoder.unsupported.reasonCounts = {}; }, /reasonCounts.*expected an array/],
    [value => { value.report.gxFifo.decoder.unsupported.addressCounts.push({ address: "0x00", count: 1 }); }, /addressCounts\.length/],
    [value => { value.report.gxFifo.decoder.unsupported.addressCounts = {}; }, /addressCounts.*expected an array/],
    [value => { value.report.gxFifo.decoder.unsupported.reasonKeyLimit = 31; }, /reasonKeyLimit/],
    [value => { value.report.gxFifo.decoder.unsupported.countLimit -= 1; }, /countLimit/],
    [value => { value.report.gxFifo.decoder.unsupported.untrackedReasonEvents = 1; }, /untrackedReasonEvents/],
    [value => { value.report.gxFifo.decoder.unsupported.future = 0; }, /unsupported\.\[keys\]/],
  ];
  for (const [mutate, pattern] of cases) {
    const invalid = sample();
    mutate(invalid);
    assert.throws(
      () => verifyGameCompatibilitySnapshot({ ...invalid, game: game() }),
      pattern,
    );
  }
});

test("projection-null vertices recovered by exact capture remain compatible", () => {
  const value = sample();
  value.report.gxFifo.decoder.legacyProjectionNullVertices = 37;
  assert.equal(
    verifyGameCompatibilitySnapshot({ ...value, game: game() }).game,
    "example-game",
  );
});

test("projection-null telemetry remains typed and exact capture misses still fail", () => {
  const invalidLegacyCount = sample();
  invalidLegacyCount.report.gxFifo.decoder.legacyProjectionNullVertices = 0.5;
  assert.throws(
    () => verifyGameCompatibilitySnapshot({
      ...invalidLegacyCount,
      game: game(),
    }),
    /legacyProjectionNullVertices.*non-negative safe integer/,
  );

  const captureMiss = sample();
  captureMiss.report.gxFifo.decoder.exactRequiredCaptureMisses = 1;
  assert.throws(
    () => verifyGameCompatibilitySnapshot({ ...captureMiss, game: game() }),
    /exactRequiredCaptureMisses.*expected zero/,
  );
});

test("exact rejection telemetry requires the complete parent and preparation taxonomies", () => {
  const cases = [
    [
      value => {
        delete value.report.rendering.metrics.webgpu
          .exactRequiredRejectionReasons.unclassified;
      },
      /exactRequiredRejectionReasons\.\[keys\]/,
    ],
    [
      value => {
        value.report.rendering.metrics.webgpu
          .exactRequiredRejectionReasons.futureReason = 0;
      },
      /exactRequiredRejectionReasons\.\[keys\]/,
    ],
    [
      value => {
        delete value.report.rendering.metrics.webgpu
          .exactRequiredPreparationRejectionReasons.invalidPreparedScissor;
      },
      /exactRequiredPreparationRejectionReasons\.\[keys\]/,
    ],
    [
      value => {
        value.report.rendering.metrics.webgpu
          .exactRequiredPreparationRejectionReasons.futureReason = 0;
      },
      /exactRequiredPreparationRejectionReasons\.\[keys\]/,
    ],
  ];
  for (const [mutate, pattern] of cases) {
    const invalid = sample();
    mutate(invalid);
    assert.throws(
      () => verifyGameCompatibilitySnapshot({ ...invalid, game: game() }),
      pattern,
    );
  }
});

test("exact rejection telemetry rejects invalid counts and inconsistent sums", () => {
  const cases = [
    [
      value => {
        value.report.rendering.metrics.webgpu
          .exactRequiredRejectionReasons.scissor = -1;
      },
      /exactRequiredRejectionReasons\.scissor.*non-negative safe integer/,
    ],
    [
      value => {
        value.report.rendering.metrics.webgpu
          .exactRequiredPreparationRejectionReasons
          .unsupportedClipDisable7 = 0.5;
      },
      /exactRequiredPreparationRejectionReasons\.unsupportedClipDisable7.*non-negative safe integer/,
    ],
    [
      value => {
        value.report.rendering.metrics.webgpu
          .exactRequiredRejectionReasons.unclassified = 1;
      },
      /exactRequiredRejectionReasons\.\[sum\]/,
    ],
    [
      value => {
        const webgpu = value.report.rendering.metrics.webgpu;
        webgpu.exactRequiredRejectedDraws = 1;
        webgpu.exactRequiredRejectionReasons.exactPreparation = 1;
      },
      /exactRequiredPreparationRejectionReasons\.\[sum\]/,
    ],
  ];
  for (const [mutate, pattern] of cases) {
    const invalid = sample();
    mutate(invalid);
    assert.throws(
      () => verifyGameCompatibilitySnapshot({ ...invalid, game: game() }),
      pattern,
    );
  }
});

test("internally consistent exact required rejections still fail compatibility", () => {
  const invalid = sample();
  const webgpu = invalid.report.rendering.metrics.webgpu;
  webgpu.exactRequiredRejectedDraws = 1;
  webgpu.exactRequiredRejectionReasons.exactPreparation = 1;
  webgpu.exactRequiredPreparationRejectionReasons
    .unsupportedClipDisable7 = 1;
  assert.throws(
    () => verifyGameCompatibilitySnapshot({ ...invalid, game: game() }),
    /exactRequiredRejectedDraws.*expected zero/,
  );
});

test("bounded incomplete GX command tails remain valid", () => {
  const value = sample();
  const decoder = value.report.gxFifo.decoder;
  decoder.bufferedBytes = 24;
  decoder.preDecodeHighWaterBytes = 24;
  decoder.retryAtBufferedBytes = 32;
  assert.equal(
    verifyGameCompatibilitySnapshot({ ...value, game: game() }).game,
    "example-game",
  );
  decoder.retryAtBufferedBytes = 24;
  assert.throws(
    () => verifyGameCompatibilitySnapshot({ ...value, game: game() }),
    /bounded incomplete command tail/,
  );
});

test("window requires 120 fields, 64 completed viewport frames, and every gameplay progress dimension", () => {
  const verified = verifyGameCompatibilityWindow({
    game: game(),
    snapshots: [sample(0), sample(1)],
  });
  assert.deepEqual(verified, {
    delta: {
      controllerAppliedSequence: 2,
      cycles: 1_000_000_000,
      dataStorageFaults: 0,
      diskReads: 1,
      dispatches: 1_000_000,
      dspBudgetedInstructions: 83_333_333,
      dspServiceCycles: 1_000_000_000,
      dspSlices: 10_000,
      gxCommands: 1_000,
      hostPresentations: 70,
      instructions: 20_000_000,
      instructionStorageFaults: 0,
      presentationSerial: 70,
      primitives: 300,
      rendererPresents: 140,
      siPolls: 140,
      viFields: 140,
      xfbCopies: 1,
    },
    game: "example-game",
    image: "a".repeat(64),
    samples: 2,
    schema: GAME_COMPATIBILITY_RUNTIME_SCHEMA,
    surface: "local-debug",
  });
});

test("window rejects stalls, regressions, resets, and static selected XFBs", () => {
  const cases = [
    [
      value => { value[1].report.deviceEvents.viField = 130; },
      /expected at least 120 new VI fields/,
    ],
    [
      value => {
        value[1].report.mmioState.viInterruptModel.hostPresentationCount =
          value[0].report.mmioState.viInterruptModel.hostPresentationCount + 63;
      },
      /expected at least 64 completed host presentations/,
    ],
    [
      value => {
        const serial =
          value[0].report.mmioState.viInterruptModel.lastHostPresentationSerial
          + 63;
        value[1].report.mmioState.viInterruptModel.lastHostPresentationSerial =
          serial;
        value[1].report.rendering.selectedXfb.presentationSerial = serial;
      },
      /presentation serial to advance by at least 64/,
    ],
    [
      value => { value[1].report.gxFifo.decoder.primitives = 2; },
      /expected primitives to advance/,
    ],
    [
      value => {
        const firstDsp = value[0].report.audioCompatibility.dspLle;
        const lastDsp = value[1].report.audioCompatibility.dspLle;
        lastDsp.slices = firstDsp.slices;
        lastDsp.stopReasonCounts = { ...firstDsp.stopReasonCounts };
      },
      /expected dspSlices to advance/,
    ],
    [
      value => { value[1].report.deviceEvents.serialPoll = 20; },
      /siPolls regressed/,
    ],
    [
      value => {
        value[1].report.cycles = value[0].report.cycles;
        const dsp = value[1].report.audioCompatibility.dspLle;
        dsp.budgetedInstructions = Math.floor(value[1].report.cycles / 12);
        dsp.pendingCpuCycles = value[1].report.cycles % 12;
        dsp.lastExecutionCycle = value[1].report.cycles;
        dsp.lastServiceCycle = value[1].report.cycles;
        dsp.nextExecutionCycle =
          value[1].report.cycles + 768 - dsp.pendingCpuCycles;
      },
      /strict forward progress/,
    ],
    [
      value => {
        value[1].report.rendering.selectedXfb.rgbSha256 =
          value[0].report.rendering.selectedXfb.rgbSha256;
      },
      /two distinct selected-XFB RGB hashes/,
    ],
    [
      value => {
        value[1].environment.surface = "public-root";
        value[1].report.disc.source = { kind: "local-file" };
      },
      /surface changed/,
    ],
  ];
  for (const [mutate, pattern] of cases) {
    const snapshots = [sample(0), sample(1)];
    mutate(snapshots);
    assert.throws(
      () => verifyGameCompatibilityWindow({ game: game(), snapshots }),
      pattern,
    );
  }
});

test("first-visible gate tolerates boot frames then sustains direct WebGPU output", () => {
  const snapshots = [makeInvisible(sample(0)), sample(1), sample(2)];
  const verified = verifyGameFirstVisibleFrameCompatibility({
    game: game(),
    snapshots,
  });
  assert.deepEqual(verified, {
    delta: {
      controllerAppliedSequence: 2,
      cycles: 1_000_000_000,
      dataStorageFaults: 0,
      diskReads: 1,
      dispatches: 1_000_000,
      dspBudgetedInstructions: 83_333_334,
      dspServiceCycles: 1_000_000_000,
      dspSlices: 10_000,
      gxCommands: 1_000,
      hostPresentations: 70,
      instructions: 20_000_000,
      instructionStorageFaults: 0,
      presentationSerial: 70,
      primitives: 300,
      rendererPresents: 140,
      siPolls: 140,
      viFields: 140,
      xfbCopies: 1,
    },
    firstVisible: {
      cycles: 1_100_000_000,
      hostPresentations: 72,
      index: 1,
      presentationSerial: 72,
      rgbSha256: "3".repeat(64),
      viFields: 151,
    },
    game: "example-game",
    image: "a".repeat(64),
    observedSamples: 3,
    samples: 2,
    schema: GAME_COMPATIBILITY_RUNTIME_SCHEMA,
    surface: "local-debug",
  });
  assert.equal(Object.isFrozen(verified.firstVisible), true);
  assert.deepEqual(Object.keys(verified.firstVisible).sort(), [
    "cycles",
    "hostPresentations",
    "index",
    "presentationSerial",
    "rgbSha256",
    "viFields",
  ]);
  assert.throws(() => {
    verified.firstVisible.index = 0;
  }, TypeError);
});

test("first-visible gate uses other > 0 and unique >= 2 as one exact boundary", () => {
  const noOther = makeInvisible(sample(0), { blackAndWhite: true });
  const oneColor = sample(1);
  const pixels = oneColor.report.rendering.selectedXfb.width
    * oneColor.report.rendering.selectedXfb.height;
  oneColor.report.rendering.selectedXfb.rgb = {
    black: 0,
    white: 0,
    other: pixels,
    unique: 1,
  };
  assert.throws(
    () => verifyGameFirstVisibleFrameCompatibility({
      game: game(),
      snapshots: [noOther, oneColor],
    }),
    /expected a first visible frame with other > 0 and unique >= 2/,
  );
});

test("first-visible gate rejects renderer, GX, decoder, exact-path, and DSP faults", () => {
  const cases = [
    [
      value => { value[0].environment.dataset.renderer = "canvas-2d"; },
      /wgpu-webgpu/,
    ],
    [
      value => { value[0].report.rendering.backend = "canvas-2d"; },
      /wgpu-webgpu/,
    ],
    [
      value => { value[0].report.gxFifo.decoder.unsupported.totalEvents = 1; },
      /totalEvents.*expected 0/,
    ],
    [
      value => { value[0].report.gxFifo.decoder.unknownOpcodes = 1; },
      /unknownOpcodes.*expected zero/,
    ],
    [
      value => {
        const webgpu = value[0].report.rendering.metrics.webgpu;
        webgpu.exactRequiredRejectedDraws = 1;
        webgpu.exactRequiredRejectionReasons.unclassified = 1;
      },
      /exactRequiredRejectedDraws.*expected zero/,
    ],
    [
      value => {
        value[0].report.audioCompatibility.dspLle.fault = {
          operation: 1,
        };
      },
      /dspLle\.fault.*expected null/,
    ],
  ];
  for (const [mutate, pattern] of cases) {
    const snapshots = [makeInvisible(sample(0)), sample(1), sample(2)];
    mutate(snapshots);
    assert.throws(
      () => verifyGameFirstVisibleFrameCompatibility({
        game: game(),
        snapshots,
      }),
      pattern,
    );
  }
});

test("first-visible gate keeps pre-visible boot samples on one surface", () => {
  const snapshots = [makeInvisible(sample(0)), sample(1), sample(2)];
  for (const snapshot of snapshots.slice(1)) {
    snapshot.environment.surface = "public-root";
    snapshot.report.disc.source = { kind: "local-file" };
  }
  assert.throws(
    () => verifyGameFirstVisibleFrameCompatibility({
      game: game(),
      snapshots,
    }),
    /snapshots\[1\]\.environment\.surface.*surface changed/,
  );
});

test("first-visible gate rejects flicker and incomplete sustained windows", () => {
  const flicker = [makeInvisible(sample(0)), sample(1), makeInvisible(sample(2))];
  assert.throws(
    () => verifyGameFirstVisibleFrameCompatibility({
      game: game(),
      snapshots: flicker,
    }),
    /visible-frame evidence regressed/,
  );

  const shortFields = [makeInvisible(sample(0)), sample(1), sample(2)];
  shortFields[2].report.deviceEvents.viField =
    shortFields[1].report.deviceEvents.viField + 119;
  assert.throws(
    () => verifyGameFirstVisibleFrameCompatibility({
      game: game(),
      snapshots: shortFields,
    }),
    /expected at least 120 new VI fields/,
  );

  const shortPresentations = [makeInvisible(sample(0)), sample(1), sample(2)];
  shortPresentations[2].report.mmioState.viInterruptModel.hostPresentationCount =
    shortPresentations[1].report.mmioState.viInterruptModel.hostPresentationCount
    + 63;
  assert.throws(
    () => verifyGameFirstVisibleFrameCompatibility({
      game: game(),
      snapshots: shortPresentations,
    }),
    /expected at least 64 completed host presentations/,
  );
});
