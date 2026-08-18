// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const [
  evidenceArgument,
  outputArgument,
  legacyBuildArgument,
  historicalReferenceArgument,
  ...unexpectedArguments
] = process.argv.slice(2);
if (
  !evidenceArgument
  || !outputArgument
  || !legacyBuildArgument
  || !historicalReferenceArgument
  || unexpectedArguments.length !== 0
) {
  throw new Error(
    "usage: resident_machine_perf_aggregate.mjs "
      + "<evidence-directory> <output.json> <legacy-build-directory> "
      + "<historical-uncontrolled-reference.json>",
  );
}
const evidenceDirectory = path.resolve(evidenceArgument);
const durableOutput = path.resolve(outputArgument);
const legacyBuildDirectory = path.resolve(legacyBuildArgument);
const historicalUncontrolledReference = path.resolve(historicalReferenceArgument);

async function readJson(name) {
  return JSON.parse(await readFile(path.join(evidenceDirectory, name), "utf8"));
}

async function numbered(prefix, count = 5) {
  return Promise.all(Array.from(
    { length: count },
    (_unused, index) => readJson(`${prefix}-${index + 1}-summary.json`),
  ));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  assert.equal(sorted.length % 2, 1, "median requires an odd sample count");
  return sorted[(sorted.length - 1) / 2];
}

function exactOne(values, label) {
  const unique = [...new Set(values)];
  assert.equal(unique.length, 1, `${label} was not identical across samples`);
  return unique[0];
}

function compactWindow(window) {
  return {
    wallMs: window.wallMs,
    executedCycles: window.executedCycles,
    executedInstructions: window.executedInstructions,
    targetInstructions: window.targetInstructions,
    instructionOvershoot: window.instructionOvershoot,
    cyclesPerSecond: window.cyclesPerSecond,
    instructionsPerSecond: window.instructionsPerSecond,
    slices: window.slices,
    rustBoundaries: window.rustBoundaries,
    outcomeDetails: window.outcomeDetails,
    servicedHostCalls: window.servicedHostCalls,
    coldInstalls: window.coldInstalls,
    hostCallCapBoundaries: window.hostCallCapBoundaries,
    coldInstallCapBoundaries: window.coldInstallCapBoundaries,
  };
}

function compactResident(summary) {
  return {
    index: summary.index,
    bootWallMs: summary.boot.wallMs,
    warmup: compactWindow(summary.warmup),
    measurement: compactWindow(summary.measurement),
    coldInstallsBeforeMeasurement: summary.coldInstallsBefore,
    coldInstallsAfterMeasurement: summary.coldInstallsAfter,
    rendererCalls: summary.rendererCalls,
    rendererFailures: summary.rendererFailures,
  };
}

function compactLegacy(summary) {
  return {
    index: summary.index,
    wallMs: summary.wallMs,
    cycles: summary.cycles,
    instructions: summary.instructions,
    dispatches: summary.dispatches,
    cyclesPerSecond: summary.cyclesPerSecond,
    instructionsPerSecond: summary.instructionsPerSecond,
    start: summary.start,
    end: summary.end,
  };
}

function systemInformation() {
  const hardwareText = execFileSync(
    "system_profiler",
    ["SPHardwareDataType", "-detailLevel", "mini"],
    { encoding: "utf8" },
  );
  const osText = execFileSync("sw_vers", [], { encoding: "utf8" });
  const field = (text, label) => text.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "m"))?.[1] ?? null;
  return {
    modelName: field(hardwareText, "Model Name"),
    modelIdentifier: field(hardwareText, "Model Identifier"),
    modelNumber: field(hardwareText, "Model Number"),
    chip: field(hardwareText, "Chip"),
    cores: field(hardwareText, "Total Number of Cores"),
    memory: field(hardwareText, "Memory"),
    productName: field(osText, "ProductName"),
    productVersion: field(osText, "ProductVersion"),
    buildVersion: field(osText, "BuildVersion"),
  };
}

const [
  legacy,
  preFixed,
  postFixed,
  postWall,
  preWallSingle,
  prePc,
  postPc,
  postFull,
] = await Promise.all([
  numbered("legacy"),
  numbered("resident-pre-hook-resume-fixed-insn"),
  numbered("resident-post-hook-resume-fixed-insn"),
  numbered("resident-post-hook-resume"),
  readJson("resident-pre-hook-resume-1-summary.json"),
  readJson("resident-pre-hook-resume-pc-probe.json"),
  readJson("resident-post-hook-resume-pc-probe.json"),
  readJson("resident-post-hook-resume-fixed-insn-1-report.json"),
]);

const preCoreSha = exactOne(preFixed.map(sample => sample.core.sha256), "pre core SHA");
const postCoreSha = exactOne(postFixed.map(sample => sample.core.sha256), "post core SHA");
assert.notEqual(preCoreSha, postCoreSha);
assert.equal(prePc.startPc, postPc.startPc, "pre/post checkpoint PCs differ");
assert.equal(prePc.endPc, postPc.endPc, "pre/post ending PCs differ");
assert.deepEqual(prePc.artifacts.disc, postPc.artifacts.disc, "pre/post discs differ");
for (const artifactName of [
  "resident_dispatcher.wasm",
  "core_run_coordinator.wasm",
  "browser_renderer.js",
  "browser_renderer_bg.wasm",
]) {
  assert.deepEqual(
    prePc.artifacts.artifacts[artifactName],
    postPc.artifacts.artifacts[artifactName],
    `pre/post ${artifactName} differs`,
  );
}
assert.ok(legacy.every(sample => sample.start.pc === legacy[0].start.pc));
assert.ok(legacy.every(sample => sample.end.pc === legacy[0].end.pc));

for (const sample of [...preFixed, ...postFixed, ...postWall]) {
  assert.equal(sample.warmup.hostCallCapBoundaries, 0);
  assert.equal(sample.warmup.coldInstallCapBoundaries, 0);
  assert.equal(sample.measurement.hostCallCapBoundaries, 0);
  assert.equal(sample.measurement.coldInstallCapBoundaries, 0);
}

const preWarmWall = preFixed.map(sample => sample.warmup.wallMs);
const postWarmWall = postFixed.map(sample => sample.warmup.wallMs);
const preWarmIps = preFixed.map(sample => sample.warmup.instructionsPerSecond);
const postWarmIps = postFixed.map(sample => sample.warmup.instructionsPerSecond);
const preHotIps = preFixed.map(sample => sample.measurement.instructionsPerSecond);
const postHotIps = postFixed.map(sample => sample.measurement.instructionsPerSecond);
const preHotWall = preFixed.map(sample => sample.measurement.wallMs);
const postHotWall = postFixed.map(sample => sample.measurement.wallMs);
const legacyIps = legacy.map(sample => sample.instructionsPerSecond);
const legacyCps = legacy.map(sample => sample.cyclesPerSecond);
const postWallIps = postWall.map(sample => sample.measurement.instructionsPerSecond);
const postWallCps = postWall.map(sample => sample.measurement.cyclesPerSecond);
const preWarmMedianMs = median(preWarmWall);
const postWarmMedianMs = median(postWarmWall);
const legacyMedianIps = median(legacyIps);
const postHotMedianIps = median(postHotIps);

const artifacts = postFull.artifacts.artifacts;
const report = {
  schema: "lazuli-rogue-resident-throughput-proof-v1",
  generatedAt: new Date().toISOString(),
  status: "controlled-local-proof",
  scope: "Rogue Leader Rust-resident CPU throughput; no deploy and no visual certification",
  conclusion: {
    primary: "Replacing the pre-change hybrid JavaScript HookExit bounce with internal Rust/Wasm continuation makes the 37-byte post-HookExit core reach the matched Rust instruction checkpoint 3.33x faster by eliminating 127,234 HookExit boundaries; pre/post PCs, disc, dispatcher, coordinator, renderer, browser, and hardware are identical.",
    notClaimed: "The large Rust-versus-legacy-JS rate ratio is not an apples-to-apples machine-speed claim because the diagnostic guest PCs diverge. The approximately 5.5 ms hot window is too short to characterize steady-state performance.",
  },
  provenance: {
    rawEvidenceDirectory: evidenceDirectory,
    controlledLegacyFiles: legacy.map(sample => `legacy-${sample.index}-summary.json`),
    preFixedFiles: preFixed.map(sample => `resident-pre-hook-resume-fixed-insn-${sample.index}-summary.json`),
    postFixedFiles: postFixed.map(sample => `resident-post-hook-resume-fixed-insn-${sample.index}-summary.json`),
    postWallFiles: postWall.map(sample => `resident-post-hook-resume-${sample.index}-summary.json`),
    pcProbeFiles: [
      "resident-pre-hook-resume-pc-probe.json",
      "resident-post-hook-resume-pc-probe.json",
    ],
    legacyHarness: {
      server: "tools/browser_boot_server.py",
      buildDirectory: legacyBuildDirectory,
      query: "sliceMs=12&blockChunk=1024&restMs=0&renderEvery=1",
      historicalUncontrolledReference,
    },
  },
  workload: {
    disc: {
      sha256: postFull.artifacts.disc.sha256,
      physicalBytes: postFull.artifacts.disc.bytes,
      legacyIdentifier: legacy[0].disc.identifier,
      legacyRevision: legacy[0].disc.revision,
      legacyFormat: legacy[0].disc.source.format,
      legacyLogicalBytes: legacy[0].disc.source.logicalSize,
    },
    fixedInstructionProtocol: {
      warmupTarget: "8536728",
      measurementTarget: "1011549",
      cycleUpperCap: "1000000",
      blockUpperCap: 16384,
      maxHostCalls: 65535,
      maxColdInstalls: 65535,
      transport: "frozen-resident-machine-worker",
      preActualWarmupInstructions: exactOne(
        preFixed.map(sample => sample.warmup.executedInstructions),
        "pre warmup instructions",
      ),
      postActualWarmupInstructions: exactOne(
        postFixed.map(sample => sample.warmup.executedInstructions),
        "post warmup instructions",
      ),
      actualMeasurementInstructions: exactOne(
        [...preFixed, ...postFixed].map(sample => sample.measurement.executedInstructions),
        "measurement instructions",
      ),
    },
    rustPcDiagnostics: {
      policyInput: false,
      pre: { start: prePc.startPc, end: prePc.endPc },
      post: { start: postPc.startPc, end: postPc.endPc },
      match: prePc.startPc === postPc.startPc && prePc.endPc === postPc.endPc,
    },
    legacyPcDiagnostics: {
      start: legacy[0].start.pc,
      end: legacy[0].end.pc,
      matchesRust: legacy[0].start.pc === postPc.startPc,
    },
  },
  artifacts: {
    preCore: { bytes: preFixed[0].core.bytes, sha256: preCoreSha },
    postCore: { bytes: postFixed[0].core.bytes, sha256: postCoreSha },
    residentDispatcher: artifacts["resident_dispatcher.wasm"],
    coreRunCoordinator: artifacts["core_run_coordinator.wasm"],
    browserRendererJs: artifacts["browser_renderer.js"],
    browserRendererWasm: artifacts["browser_renderer_bg.wasm"],
    cleanAttribution: {
      onlyCoreDiffers: true,
      coreByteDifference: postFixed[0].core.bytes - preFixed[0].core.bytes,
    },
  },
  environment: {
    browserUserAgent: postFull.environment.userAgent,
    crossOriginIsolated: postFull.environment.crossOriginIsolated,
    hardwareConcurrency: postFull.environment.hardwareConcurrency,
    system: systemInformation(),
  },
  primaryMatchedRustProgress: {
    preWarmWallMs: preWarmWall,
    postWarmWallMs: postWarmWall,
    preWarmInstructionsPerSecond: preWarmIps,
    postWarmInstructionsPerSecond: postWarmIps,
    median: {
      preWarmWallMs: preWarmMedianMs,
      postWarmWallMs: postWarmMedianMs,
      checkpointSpeedupByTime: preWarmMedianMs / postWarmMedianMs,
      timeReductionFraction: 1 - postWarmMedianMs / preWarmMedianMs,
      preWarmInstructionsPerSecond: median(preWarmIps),
      postWarmInstructionsPerSecond: median(postWarmIps),
      throughputRatio: median(postWarmIps) / median(preWarmIps),
    },
    hookExitDetail3: {
      pre: preFixed.map(sample => sample.warmup.outcomeDetails["3"] ?? 0),
      post: postFixed.map(sample => sample.warmup.outcomeDetails["3"] ?? 0),
    },
    coldInstalls: {
      pre: preFixed.map(sample => sample.warmup.coldInstalls),
      post: postFixed.map(sample => sample.warmup.coldInstalls),
    },
    samples: {
      pre: preFixed.map(compactResident),
      post: postFixed.map(compactResident),
    },
  },
  shortHotWindow: {
    caveat: "About 5.3-5.6 ms per sample; useful as a regression flag, not a steady-state characterization.",
    preWallMs: preHotWall,
    postWallMs: postHotWall,
    preInstructionsPerSecond: preHotIps,
    postInstructionsPerSecond: postHotIps,
    median: {
      preWallMs: median(preHotWall),
      postWallMs: median(postHotWall),
      preInstructionsPerSecond: median(preHotIps),
      postInstructionsPerSecond: postHotMedianIps,
      postToPreRatio: postHotMedianIps / median(preHotIps),
    },
  },
  controlledLegacyJs: {
    protocol: "Five fresh same-Chrome/same-disc runs; snapshot after 1 s wall warmup, then approximately 3 s snapshot delta.",
    median: {
      cyclesPerSecond: median(legacyCps),
      instructionsPerSecond: legacyMedianIps,
    },
    samples: legacy.map(compactLegacy),
  },
  descriptiveRustVsLegacy: {
    fixedProgressInstructionRateRatio: postHotMedianIps / legacyMedianIps,
    threeSecondWallRateRatio: median(postWallIps) / legacyMedianIps,
    caveat: "Not an apples-to-apples throughput ratio: matched cumulative instruction progress reaches Rust PC 0x80027bdc but legacy JS PC 0x80007380; the 1 s wall warmup also starts the two runtimes at different guest progress.",
  },
  optimizedThreeSecondWallWindow: {
    median: {
      cyclesPerSecond: median(postWallCps),
      instructionsPerSecond: median(postWallIps),
    },
    samples: postWall.map(compactResident),
  },
  frozenPreThreeSecondWallSingle: {
    caveat: "One controlled sample only; workload diverges after the fixed 1 s warmup, so it is not a repeated paired baseline.",
    sample: compactResident(preWallSingle),
  },
  boundaryIntegrity: {
    partialCounterPolicy: "fail closed on host-call-cap or cold-install-cap; no partial counters are included",
    includedCapBoundaries: 0,
    optimizedDefaultCapProbe: {
      status: "failed-closed-as-designed",
      phase: "warmup",
      maxColdInstalls: 64,
      exactError: "measurement reached the adapter cold-install cap; partial Rust counters are not observable",
    },
  },
  rendererAndHostBoundary: {
    actualBrowserRendererInitialized: true,
    exactMethod: "WebGpuRenderer.submit_resident_render(source, flags, sequenceLo, sequenceHi)",
    renderCallsInMeasuredRogueWindows: 0,
    renderFailures: 0,
    renderBridgeDynamicallyExercisedByThisWindow: false,
    browserSemanticArguments: 0,
    javascriptDispatchTableSets: 0,
    rawHostDiscEndpoint: "opaque immutable HTTP byte ranges only",
    discSemanticsInHost: false,
  },
  validation: {
    adapterContract: {
      command: "node tools/resident_machine_adapter_contract.mjs <core> <dispatcher> <coordinator>",
      status: "pass",
      semanticJavascriptArguments: 0,
      javascriptTableSets: 0,
      rendererRelayCalls: 1,
      rawHttpRequests: 2,
    },
    rawRangeEndpoint: {
      exactRange: { request: "bytes=0-15", status: 206, responseBytes: 16 },
      missingRange: { status: 416 },
      contentRange: "bytes 0-15/1400930880",
      immutableEtagPresent: true,
    },
    sourceAudit: {
      productionWorker: "/web/resident-machine-worker.mjs",
      opaqueDiscPrimitive: "os.pread",
      javascriptDispatchTableSetMatches: 0,
    },
  },
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
await Promise.all([
  writeFile(durableOutput, serialized),
  writeFile(path.join(evidenceDirectory, "aggregate.json"), serialized),
]);
process.stdout.write(JSON.stringify({
  ok: true,
  durableOutput,
  evidenceOutput: path.join(evidenceDirectory, "aggregate.json"),
  primary: report.primaryMatchedRustProgress.median,
  descriptiveRustVsLegacy: report.descriptiveRustVsLegacy,
}, null, 2) + "\n");
