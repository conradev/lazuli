// SPDX-License-Identifier: GPL-3.0-only

export const GAME_FIRST_PLAYABLE_TEST_URL =
  "http://127.0.0.1:8765/index.html?headlessRun=compatibility";

export const GAME_FIRST_PLAYABLE_TEST_BUTTONS = Object.freeze({
  a: 0x0100,
  left: 0x0001,
});

function exactRequiredRejectionReasons() {
  return {
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
  };
}

function exactRequiredPreparationRejectionReasons() {
  return {
    invalidVertexLayout: 0,
    missingExactClipInput: 0,
    positionCountMismatch: 0,
    nonFiniteSourceVertex: 0,
    cullModeStateMismatch: 0,
    unsupportedMultisampling: 0,
    unsupportedZFreeze: 0,
    nonCanonicalSourceRaster: 0,
    unsupportedPostClipW: 0,
    unsupportedPostClipPosition: 0,
    unsupportedPostClipDepth: 0,
    clipInvalidComponentCount: 0,
    unsupportedTopology5: 0,
    unsupportedTopology6: 0,
    unsupportedTopology7: 0,
    unsupportedTopologyOther: 0,
    clipNoSourceTriangles: 0,
    clipInvalidCullMode: 0,
    clipInvalidViewportHeight: 0,
    clipNonFiniteVertex: 0,
    clipArithmeticOverflow: 0,
    projectionInvalidComponentCount: 0,
    projectionInvalidBpState: 0,
    projectionInvalidClipDisable: 0,
    unsupportedClipDisable1: 0,
    unsupportedClipDisable2: 0,
    unsupportedClipDisable3: 0,
    unsupportedClipDisable4: 0,
    unsupportedClipDisable5: 0,
    unsupportedClipDisable6: 0,
    unsupportedClipDisable7: 0,
    unsupportedClipDisableOther: 0,
    projectionInvalidViewport: 0,
    projectionInvalidScissor: 0,
    projectionNoVisibleScissor: 0,
    projectionWrappedScissor: 0,
    projectionNonFiniteVertex: 0,
    projectionZeroClipW: 0,
    projectionArithmeticOverflow: 0,
    invalidPreparedScissor: 0,
    uncertifiedFaceCull: 0,
  };
}

export function makeGameFirstPlayableReport(game, offset) {
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
    scenario: null,
    pc: `0x${(0x8000_1000 + offset * 0x1000).toString(16)}`,
    disc: {
      identifier: game.disc.identifier,
      revision: game.disc.revision,
      source: {
        kind: "logical-range-endpoint",
        url: "http://127.0.0.1:8765/disc",
        reads: 10 + offset * 20,
        bytesRead: 1_000_000 + offset * 2_000_000,
        cache: {
          chunkBytes: 262_144,
          maximumBytes: 8_388_608,
          parallelChunks: 4,
          residentBytes: 2_097_152 + offset * 262_144,
          hits: 4 + offset * 20,
          misses: 8 + offset,
          evictions: offset,
        },
        format: "ciso",
        logicalSize: 1_459_978_240,
        blockSize: 2_097_152,
        presentBlocks: 697,
        logicalReads: 10 + offset * 20,
        logicalBytes: 1_000_000 + offset * 2_000_000,
        physicalRuns: 10 + offset * 20,
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
      pollIndex: 21 + offset * 140,
      queueOverflows: 0,
      lastActiveHostPublication: null,
    },
    serialInterface: {
      unknownOutputCommands: 0,
    },
    audioCompatibility: {
      dspFirstUnsupported: null,
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
      viInterruptModel: {
        hostPresentationCount: 2 + offset * 70,
        lastHostPresentationCycle: cycles - 1_000,
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
          exactRequiredRejectionReasons: exactRequiredRejectionReasons(),
          exactRequiredPreparationRejectionReasons:
            exactRequiredPreparationRejectionReasons(),
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
    guestGame: null,
    headlessCapture: {
      dataset: {
        renderer: "wgpu-webgpu",
        status: "running",
      },
      devtoolsExceptions: [],
      discImage: {
        algorithm: "sha256",
        format: game.image.format,
        sha256: game.image.sha256,
      },
      pageTitle: "Lazuli debug harness",
      timedOut: true,
      url: GAME_FIRST_PLAYABLE_TEST_URL,
    },
  };
}

export function makeGameFirstPlayableReportPair(game, button = "a") {
  const preReport = makeGameFirstPlayableReport(game, 0);
  const postReport = makeGameFirstPlayableReport(game, 1);
  const scheduledCycle = preReport.cycles + 10_000;
  postReport.controller.lastActiveHostPublication = {
    source: "periodic",
    pollIndex: preReport.controller.pollIndex + 1,
    scheduledCycle,
    observedCycle: scheduledCycle + 100,
    buttons: GAME_FIRST_PLAYABLE_TEST_BUTTONS[button],
    sequence: preReport.controller.appliedSequence + 1,
  };
  delete postReport.headlessCapture.discImage;
  postReport.headlessCapture.reuse = {
    action: {
      extendCycles: 1_000_000_000,
      pulseMs: 500,
      pulses: [{ delayMs: 0, name: button }],
      renderEvery: null,
    },
    previous: Object.fromEntries(
      ["cycles", "dispatches", "instructions", "pc", "stage", "status"]
        .map(field => [field, preReport[field]]),
    ),
    url: GAME_FIRST_PLAYABLE_TEST_URL,
  };
  return { postReport, preReport };
}
