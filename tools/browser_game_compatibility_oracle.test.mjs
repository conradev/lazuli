#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  GAME_COMPATIBILITY_RUNTIME_SCHEMA,
  verifyGameCompatibilitySnapshot,
  verifyGameCompatibilityWindow,
} from "./browser_game_compatibility_oracle.mjs";

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
  const generation = 3 + offset;
  const pairEpoch = 8 + offset;
  const serial = 2 + offset;
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
    cycles: 100_000_000 + offset * 1_000_000_000,
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
      queueOverflows: 0,
    },
    serialInterface: {
      unknownOutputCommands: 0,
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

test("strict snapshot accepts private local WebGPU evidence", () => {
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
      diskReads: 30,
      dispatches: 500_000,
      gxCommands: 529,
      hostPresentations: 2,
      instructions: 14_000_000,
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
    [value => { value.report.rendering.metrics.webgpu.exactRequiredRejectedDraws = 1; }, /expected zero/],
    [value => { value.report.deviceEvents.diskDeviceError = 1; }, /diskDeviceError/],
    [value => { value.report.deviceEvents.dspUcodeBootRejected = 1; }, /dspUcodeBootRejected/],
    [value => { value.report.exceptions.counts["0x0300"] = 1; }, /0x0300/],
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

test("window requires 120 fields and every gameplay progress dimension", () => {
  const verified = verifyGameCompatibilityWindow({
    game: game(),
    snapshots: [sample(0), sample(1)],
  });
  assert.deepEqual(verified, {
    delta: {
      controllerAppliedSequence: 2,
      cycles: 1_000_000_000,
      diskReads: 1,
      dispatches: 1_000_000,
      gxCommands: 1_000,
      hostPresentations: 70,
      instructions: 20_000_000,
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
      value => { value[1].report.gxFifo.decoder.primitives = 2; },
      /expected primitives to advance/,
    ],
    [
      value => { value[1].report.deviceEvents.serialPoll = 20; },
      /siPolls regressed/,
    ],
    [
      value => { value[1].report.cycles = value[0].report.cycles; },
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
