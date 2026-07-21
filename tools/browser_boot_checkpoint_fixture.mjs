// SPDX-License-Identifier: GPL-3.0-only

export function checkpointReport() {
  return {
    status: "paused",
    stage: "cycle-limit",
    title: "Super Monkey Ball (GMBE8P Rev.00)",
    disc: {
      identifier: "GMBE8P",
      revision: 0,
      source: {
        kind: "logical-range-endpoint",
        url: "http://127.0.0.1:8766/disc",
        cache: { hits: 63, misses: 45 },
      },
    },
    input: "/private/tmp/Super Monkey Ball.ciso",
    runtime: "Fixture Browser/1.0",
    compilerWasmBytes: 123456,
    limits: { cycles: 1_500_000_000, dispatches: null },
    instructions: 456_789,
    cycles: 1_500_000_000,
    dispatches: 123_456,
    pc: "0x800c90e0",
    cpuState: {
      pc: "0x800c90e0",
      msr: "0x00009032",
      lr: "0x800c90e0",
      ctr: "0x00000000",
      srr0: "0x800c90e0",
      srr1: "0x00009032",
      signature: "0xcc536b5b",
      gpr: {
        ...Object.fromEntries(Array.from({ length: 32 }, (_unused, index) => [
          `r${index}`,
          "0x00000000",
        ])),
        r1: "0x81234560",
      },
    },
    execution: {
      context: "web-worker",
      guestCore: "single Gekko",
      jit: "PPC-to-CLIF-to-Wasm",
      scheduler: {
        sliceMs: 12,
        restMs: 0,
        blockChunk: 1024,
        renderEvery: 1,
        rendererSync: {
          posted: 328,
          acknowledged: 328,
          failed: 0,
          inFlight: 0,
          highWater: 1,
          waits: 328,
          resultMisses: 0,
        },
      },
    },
    guestGame: {
      submode: 49,
      submodeTimer: 317,
      readyMain: true,
      playRequested: false,
    },
    gxFifo: {
      bytes: 13_579,
      hash: "0x63f324ac",
      decoder: {
        commands: 400,
        cpLoads: 20,
        xfLoads: 30,
        indexedXfLoads: 4,
        bpLoads: 100,
        displayLists: 7,
        displayListBytes: 2048,
        displayListErrors: 0,
        primitives: 91,
        vertices: 1024,
        vertexDecodeErrors: 0,
        unknownOpcodes: 0,
        xfbCopyCount: 143,
        textureCopyCount: 5,
        textures: { decodeErrors: 0, tlutErrors: 0 },
      },
    },
    diskReads: { hashedBytes: 12_058_624, hash: "0x691e18d1" },
    diskCommands: { lastError: "0x00000000" },
    deviceEvents: { diskHostWait: 49 },
    exceptions: { counts: { "0x0500": 3541, "0x0800": 764, "0x0c00": 1175 } },
    controller: {
      pendingButtons: 0,
      lastPolledButtons: 0,
      guestPad: { pressed: { buttons: 0 }, held: { buttons: 0 } },
      queueOverflows: 0,
    },
    serialInterface: { unknownOutputCommands: 0 },
    mmioState: {
      viInterruptModel: {
        presentationCount: 185,
        lastPresentationCycle: 1_496_000_000,
        lastPresentationField: "top",
        lastPresentationAddress: "0x00392c80",
        lastPresentationCopyIndex: 142,
        lastPresentationCopyRow: 0,
      },
    },
    rendering: {
      backend: "wgpu-webgpu",
      selectedXfb: {
        address: "0x00392c80",
        generation: 142,
        row: 0,
        format: "rgba8unorm",
        layout: "top-left-row-major-tight",
        sourceRow: 0,
        width: 640,
        height: 448,
        textureWidth: 640,
        textureHeight: 448,
        logicalWidth: 640,
        logicalHeight: 448,
        displayWidth: 640,
        displayHeight: 448,
        rgbaByteLength: 1_146_880,
        rgbaSha256: "5fd0f5382bec2c974f7b6559b3c648a6db307d92eb37440d1f23dfa4be9d974e",
        rgb: {
          black: 278_435,
          white: 2_786,
          other: 5_499,
          unique: 423,
        },
      },
    },
    accelerations: { workerRestYields: 123 },
    headlessCapture: {
      dataset: { renderer: "wgpu-webgpu", viFields: "185" },
      devtoolsExceptions: [],
      pageTitle: "Lazuli local harness",
      reuse: null,
      url: "http://127.0.0.1:8766/?cycles=1500000000",
    },
  };
}

export function reportsForConsensus() {
  return Array.from({ length: 3 }, (_unused, index) => {
    const report = checkpointReport();
    report.runtime = `Fixture Browser/${index + 1}.0`;
    report.input = `/different/host/${index}/Super Monkey Ball.ciso`;
    report.compilerWasmBytes += index;
    report.disc.source.url = `http://127.0.0.1:${8766 + index}/disc`;
    report.disc.source.cache.hits += index * 100;
    report.execution.scheduler.sliceMs += index;
    report.execution.scheduler.restMs += index * 5;
    report.execution.scheduler.blockChunk += index * 64;
    report.execution.scheduler.rendererSync.waits += index * 20;
    report.deviceEvents.diskHostWait += index * 3;
    report.accelerations.workerRestYields += index * 1000;
    report.headlessCapture.dataset.viFields = String(185 + index);
    report.headlessCapture.pageTitle = `Harness ${index}`;
    report.headlessCapture.url = `http://localhost:${9000 + index}/?cycles=1500000000`;
    return report;
  });
}
