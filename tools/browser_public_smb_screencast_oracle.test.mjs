// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  PublicSmbScreencastValidationError,
  verifyPublicSmbScreencastReport,
} from "./browser_public_smb_screencast_oracle.mjs";
import { SUPER_MONKEY_BALL_READY_CHECKPOINT } from "./browser_boot_checkpoint_v3.mjs";
import { gameplayTranscript } from "./browser_boot_gameplay_transcript_fixture.mjs";

const WIDTH = 1024;
const HEIGHT = 768;
const PIXELS = WIDTH * HEIGHT;

function asset(name, extension, digit, bytes = 1000) {
  const sha256 = digit.repeat(64);
  return {
    url: `/assets/${name}-${sha256}.${extension}`,
    sha256,
    bytes,
  };
}

function release() {
  return {
    schema: 2,
    releaseId: "1".repeat(64),
    commit: "2".repeat(40),
    frontend: asset("frontend", "html", "3"),
    renderer: {
      javascript: asset("browser-renderer", "js", "4"),
      wasm: asset("browser-renderer-wasm", "wasm", "5"),
    },
    backend: {
      url: "/ppcwasmjit.wasm",
      sha256: "6".repeat(64),
      bytes: 10_000,
    },
  };
}

function geometry() {
  return {
    canvas: {
      bottom: HEIGHT,
      bufferHeight: 448,
      bufferWidth: 640,
      content: {
        bottom: 742.4,
        height: 716.8,
        left: 0,
        right: WIDTH,
        top: 25.6,
        width: WIDTH,
      },
      height: HEIGHT,
      left: 0,
      objectFit: "contain",
      objectPosition: "50% 50%",
      right: WIDTH,
      top: 0,
      width: WIDTH,
    },
    error: null,
    iframe: {
      bottom: HEIGHT,
      height: HEIGHT,
      left: 0,
      right: WIDTH,
      top: 0,
      width: WIDTH,
    },
    viewport: {
      devicePixelRatio: 1,
      frameDevicePixelRatio: 1,
      frameHeight: HEIGHT,
      frameWidth: WIDTH,
      height: HEIGHT,
      scrollX: 0,
      scrollY: 0,
      width: WIDTH,
    },
  };
}

function captureState(publicUrl, active, status) {
  const frameUrl = new URL(active.frontend.url, publicUrl);
  frameUrl.search = new URL(publicUrl).search;
  return {
    topUrl: publicUrl,
    topReadyState: "complete",
    frameUrl: frameUrl.href,
    frameReadyState: "complete",
    frameHidden: false,
    statusHidden: true,
    surface: "release",
    viewportCaptureMode: "enabled",
    compositorCaptureAvailable: false,
    renderer: "wgpu-webgpu",
    status,
    renderEvery: null,
    discStatus: "local: Super Monkey Ball (USA).ciso",
    runnerAvailable: true,
    geometry: geometry(),
  };
}

function terminalProof() {
  const transcript = gameplayTranscript();
  const cycles = transcript.scenario.completedCycle;
  return {
    reportBytes: 123_456,
    reportSha256: "f".repeat(64),
    status: "paused",
    stage: "scenario-complete",
    cycles,
    disc: {
      identifier: "GMBE8P",
      revision: 0,
      sourceKind: "local-file",
    },
    scenario: {
      id: "smb-ready-play",
      gameIdentifier: "GMBE8P",
      status: "complete",
      hardCycleLimit: 30_000_000_000,
      startCycle: 0,
      completedCycle: cycles,
      failure: null,
      currentStep: null,
      stepIndex: 13,
      stepCount: 13,
    },
    gameplayTranscript: transcript,
    rendering: { backend: "wgpu-webgpu", error: null },
    scheduler: { renderEvery: 1 },
  };
}

function summarizedFrame(index) {
  const digit = ((index % 4) + 7).toString(16);
  return {
    ordinal: index + 1,
    sessionId: index + 1,
    receivedAtMs: 1_700_000_000_000 + index * 16,
    metadata: {
      offsetTop: 0,
      pageScaleFactor: 1,
      deviceWidth: WIDTH,
      deviceHeight: HEIGHT,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
      timestamp: 1_700_000_000 + index * 0.016,
    },
    png: {
      width: WIDTH,
      height: HEIGHT,
      sourceColorType: "rgba8",
      format: "rgba8unorm",
      layout: "top-left-row-major-tight",
      pngByteLength: 50_000 + index,
      pngSha256: digit.repeat(64),
      rgbaByteLength: PIXELS * 4,
      rgbaSha256: ((index % 4) + 11).toString(16).repeat(64),
      rgbSha256: ((index % 4) + 3).toString(16).repeat(64),
      rgb: { black: 0, white: 0, other: PIXELS, unique: 256 },
    },
  };
}

function terminalTail(frames, terminalObservedAtMs = frames.at(-1).receivedAtMs + 100) {
  let maxMetadataGapMs = 0;
  let maxReceiptGapMs = 0;
  for (let index = 1; index < frames.length; index += 1) {
    maxMetadataGapMs = Math.max(
      maxMetadataGapMs,
      (frames[index].metadata.timestamp - frames[index - 1].metadata.timestamp) * 1_000,
    );
    maxReceiptGapMs = Math.max(
      maxReceiptGapMs,
      frames[index].receivedAtMs - frames[index - 1].receivedAtMs,
    );
  }
  return {
    terminalObservedAtMs,
    firstReceivedAtMs: frames[0].receivedAtMs,
    lastReceivedAtMs: frames.at(-1).receivedAtMs,
    metadataSpanMs: (
      frames.at(-1).metadata.timestamp - frames[0].metadata.timestamp
    ) * 1_000,
    receiptSpanMs: frames.at(-1).receivedAtMs - frames[0].receivedAtMs,
    maxMetadataGapMs,
    maxReceiptGapMs,
    terminalMetadataAgeMs: Math.abs(
      terminalObservedAtMs - frames.at(-1).metadata.timestamp * 1_000,
    ),
    terminalTailAgeMs: Math.abs(terminalObservedAtMs - frames.at(-1).receivedAtMs),
    limits: {
      maxFrameGapMs: 5_000,
      maxTailSpanMs: 180_000,
      maxTerminalTailAgeMs: 5_000,
    },
  };
}

function retimeTail(report, spanMs) {
  const frames = report.screencast.frames;
  const firstReceivedAtMs = frames[0].receivedAtMs;
  const firstMetadataTimestamp = frames[0].metadata.timestamp;
  for (let index = 0; index < frames.length; index += 1) {
    const offsetMs = Math.round((index * spanMs) / (frames.length - 1));
    frames[index].receivedAtMs = firstReceivedAtMs + offsetMs;
    frames[index].metadata.timestamp = firstMetadataTimestamp + offsetMs / 1_000;
  }
  report.screencast.terminalTail = terminalTail(frames);
  return report;
}

function validReport() {
  const publicUrl = "https://gekko.free/?scenario=smb-ready-play&viewportCapture=1&headlessRun=passive-run-1";
  const active = release();
  const frameUrl = new URL(active.frontend.url, publicUrl);
  frameUrl.search = new URL(publicUrl).search;
  const frames = Array.from({ length: 64 }, (_, index) => summarizedFrame(index));
  return {
    schema: "lazuli-public-smb-screencast-v1",
    mode: "passive-public-viewport",
    alignment: "non-serial-aligned",
    rendererControl: {
      compositorHandshake: false,
      rendererBackpressure: false,
      renderEveryOverride: null,
    },
    publicUrl,
    navigation: {
      expectedTopLoaderId: "loader-public-1",
      expectedFrameUrl: frameUrl.href,
      before: {
        top: {
          frameId: "frame-public-1",
          loaderId: "loader-public-1",
          url: publicUrl,
        },
        iframe: {
          frameId: "frame-app-1",
          loaderId: "loader-app-1",
          url: frameUrl.href,
        },
      },
      after: {
        top: {
          frameId: "frame-public-1",
          loaderId: "loader-public-1",
          url: publicUrl,
        },
        iframe: {
          frameId: "frame-app-1",
          loaderId: "loader-app-1",
          url: frameUrl.href,
        },
      },
    },
    release: active,
    terminalRelease: structuredClone(active),
    discImage: {
      ...SUPER_MONKEY_BALL_READY_CHECKPOINT.game.image,
    },
    before: captureState(publicUrl, active, "running"),
    after: captureState(publicUrl, active, "paused"),
    terminal: terminalProof(),
    devtoolsExceptions: [],
    screencast: {
      protocol: "cdp-page-screencast-v1",
      format: "png",
      everyNthFrame: 1,
      width: WIDTH,
      height: HEIGHT,
      selection: "rolling-tail",
      capacityFrames: 64,
      firstReceivedOrdinal: 17,
      lastReceivedOrdinal: 80,
      receivedFrames: 80,
      acknowledgedFrames: 80,
      frames,
      terminalTail: terminalTail(frames),
    },
    oracle: null,
    oraclePassed: false,
  };
}

test("strict passive oracle accepts diverse non-serial public viewport summaries", () => {
  const report = validReport();
  const oracle = verifyPublicSmbScreencastReport(report);
  assert.strictEqual(report.oracle, oracle);
  assert.equal(report.oraclePassed, true);
  assert.deepEqual(oracle, {
    frameCount: 64,
    distinctPngSha256: 4,
    distinctRgbaSha256: 4,
    distinctRgbSha256: 4,
    extremeThresholdPpm: 850_000,
    selectedReceivedOrdinals: { first: 17, last: 80 },
    nearBlackOrdinals: [],
    nearWhiteOrdinals: [],
    monochromeOrdinals: [],
    oppositeExtremeTransitions: [],
  });
});

test("passive oracle accepts a healthy 73-second tail and rejects a tail over 180 seconds", () => {
  const healthy = retimeTail(validReport(), 73_000);
  assert.doesNotThrow(() => verifyPublicSmbScreencastReport(healthy));
  assert.ok(healthy.screencast.terminalTail.maxReceiptGapMs < 5_000);

  const tooLong = retimeTail(validReport(), 180_001);
  assert.ok(tooLong.screencast.terminalTail.maxReceiptGapMs < 5_000);
  assert.throws(
    () => verifyPublicSmbScreencastReport(tooLong),
    /too sparse or stale/,
  );
});

test("persisted successful evidence is independently recomputed and re-verifiable", () => {
  const report = validReport();
  const firstOracle = verifyPublicSmbScreencastReport(report);
  const persisted = JSON.parse(JSON.stringify(report));
  assert.deepEqual(verifyPublicSmbScreencastReport(persisted), firstOracle);
  assert.equal(persisted.oraclePassed, true);

  persisted.oracle.distinctRgbSha256 += 1;
  assert.throws(
    () => verifyPublicSmbScreencastReport(persisted),
    /persisted oracle does not match recomputed evidence/,
  );
});

test("passive oracle derives and rejects adjacent black/white extreme transitions", () => {
  const report = validReport();
  report.screencast.frames[0].png.rgb = {
    black: PIXELS,
    white: 0,
    other: 0,
    unique: 1,
  };
  report.screencast.frames[1].png.rgb = {
    black: 0,
    white: PIXELS,
    other: 0,
    unique: 1,
  };
  assert.throws(
    () => verifyPublicSmbScreencastReport(report),
    error => error instanceof PublicSmbScreencastValidationError
      && error.path === "$.oracle.oppositeExtremeTransitions",
  );
  assert.equal(report.oraclePassed, false);
  assert.deepEqual(report.oracle.oppositeExtremeTransitions, [{
    from: "black",
    fromOrdinal: 1,
    to: "white",
    toOrdinal: 2,
  }]);

  const persistedFailure = JSON.parse(JSON.stringify(report));
  assert.throws(
    () => verifyPublicSmbScreencastReport(persistedFailure),
    error => error instanceof PublicSmbScreencastValidationError
      && error.path === "$.oracle.oppositeExtremeTransitions",
  );
});

test("passive oracle pins evidence to the exact production origin", () => {
  const invalidPublicUrls = [
    "http://gekko.free/?scenario=smb-ready-play&viewportCapture=1&headlessRun=run",
    "https://localhost/?scenario=smb-ready-play&viewportCapture=1&headlessRun=run",
    "https://user@gekko.free/?scenario=smb-ready-play&viewportCapture=1&headlessRun=run",
    "https://gekko.free:8443/?scenario=smb-ready-play&viewportCapture=1&headlessRun=run",
  ];
  for (const publicUrl of invalidPublicUrls) {
    const report = validReport();
    report.publicUrl = publicUrl;
    assert.throws(
      () => verifyPublicSmbScreencastReport(report),
      error => error instanceof PublicSmbScreencastValidationError
        && error.path === "$.publicUrl",
      publicUrl,
    );
  }
});

test("passive oracle rejects renderer coupling, raw pixels, and serial provenance", () => {
  const cases = [
    ["fallback", report => { report.before.renderer = "fallback"; }, /before\.renderer/],
    ["cadence", report => { report.before.renderEvery = "1"; }, /before\.renderEvery/],
    ["handshake", report => { report.rendererControl.compositorHandshake = true; }, /compositorHandshake/],
    ["backpressure", report => { report.rendererControl.rendererBackpressure = true; }, /rendererBackpressure/],
    ["raw pixels", report => { report.screencast.frames[0].png.rgba = []; }, /frames\[0\]\.png: keys/],
    ["serial", report => { report.screencast.frames[0].presentationSerial = 1; }, /frames\[0\]: keys/],
    ["exceptions", report => { report.devtoolsExceptions.push({ text: "boom" }); }, /devtoolsExceptions/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const report = validReport();
    mutate(report);
    assert.throws(() => verifyPublicSmbScreencastReport(report), pattern, label);
  }
});

test("passive oracle requires immutable public frame and active release stability", () => {
  const frameChanged = validReport();
  frameChanged.after.frameUrl = "https://gekko.free/app.html?scenario=smb-ready-play";
  assert.throws(
    () => verifyPublicSmbScreencastReport(frameChanged),
    /after\.frameUrl/,
  );

  const releaseChanged = validReport();
  releaseChanged.terminalRelease.releaseId = "f".repeat(64);
  assert.throws(
    () => verifyPublicSmbScreencastReport(releaseChanged),
    /active release changed/,
  );

  const geometryChanged = validReport();
  geometryChanged.after.geometry.canvas.bufferWidth = 608;
  assert.throws(
    () => verifyPublicSmbScreencastReport(geometryChanged),
    /canvas\.bufferWidth/,
  );

  const undersized = validReport();
  for (const state of [undersized.before, undersized.after]) {
    Object.assign(state.geometry.canvas, {
      left: 256,
      right: 768,
      top: 204.8,
      bottom: 563.2,
      width: 512,
      height: 358.4,
    });
  }
  assert.throws(
    () => verifyPublicSmbScreencastReport(undersized),
    /deterministic 1024x768 CSS canvas box/,
  );

  const uncovered = validReport();
  for (const state of [uncovered.before, uncovered.after]) {
    state.geometry.canvas.objectFit = "fill";
  }
  assert.throws(
    () => verifyPublicSmbScreencastReport(uncovered),
    /canvas\.objectFit/,
  );

  const misplacedContent = validReport();
  for (const state of [misplacedContent.before, misplacedContent.after]) {
    state.geometry.canvas.content.top = 0;
    state.geometry.canvas.content.bottom = 716.8;
  }
  assert.throws(
    () => verifyPublicSmbScreencastReport(misplacedContent),
    /centered 1024x716\.8 contained content/,
  );

  const loaderChanged = validReport();
  loaderChanged.navigation.after.iframe.loaderId = "loader-app-2";
  assert.throws(
    () => verifyPublicSmbScreencastReport(loaderChanged),
    /navigation\.after\.iframe\.loaderId/,
  );

  const navigated = validReport();
  navigated.navigation.after.top.url = "https://gekko.free/other";
  assert.throws(
    () => verifyPublicSmbScreencastReport(navigated),
    /navigation\.after\.top\.url/,
  );
});

test("passive oracle rejects low-diversity and malformed bounded frame sets", () => {
  const lowDiversity = validReport();
  for (const frame of lowDiversity.screencast.frames) {
    frame.png.rgbSha256 = "a".repeat(64);
  }
  assert.throws(
    () => verifyPublicSmbScreencastReport(lowDiversity),
    /distinctRgbSha256/,
  );
  assert.equal(lowDiversity.oracle.distinctRgbSha256, 1);
  const persistedLowDiversity = JSON.parse(JSON.stringify(lowDiversity));
  assert.throws(
    () => verifyPublicSmbScreencastReport(persistedLowDiversity),
    error => error instanceof PublicSmbScreencastValidationError
      && error.path === "$.oracle.distinctRgbSha256",
  );

  const missing = validReport();
  missing.screencast.frames.pop();
  assert.throws(
    () => verifyPublicSmbScreencastReport(missing),
    /expected exactly 64 summarized frames/,
  );

  const wrongTail = validReport();
  wrongTail.screencast.firstReceivedOrdinal = 1;
  assert.throws(
    () => verifyPublicSmbScreencastReport(wrongTail),
    /firstReceivedOrdinal/,
  );

  const early = validReport();
  early.terminal.status = "running";
  assert.throws(
    () => verifyPublicSmbScreencastReport(early),
    /terminal\.status/,
  );

  const wrongCiso = validReport();
  wrongCiso.discImage.sha256 = "0".repeat(64);
  assert.throws(
    () => verifyPublicSmbScreencastReport(wrongCiso),
    /discImage\.sha256/,
  );

  const fakeTwoStep = validReport();
  fakeTwoStep.terminal.gameplayTranscript.steps =
    fakeTwoStep.terminal.gameplayTranscript.steps.slice(0, 2);
  assert.throws(
    () => verifyPublicSmbScreencastReport(fakeTwoStep),
    /terminal\.gameplayTranscript/,
  );

  const sparse = validReport();
  sparse.screencast.frames.at(-1).metadata.timestamp += 10;
  sparse.screencast.terminalTail = terminalTail(sparse.screencast.frames);
  assert.throws(
    () => verifyPublicSmbScreencastReport(sparse),
    /too sparse or stale/,
  );

  const stale = validReport();
  stale.screencast.terminalTail = terminalTail(
    stale.screencast.frames,
    stale.screencast.frames.at(-1).receivedAtMs + 5_001,
  );
  assert.throws(
    () => verifyPublicSmbScreencastReport(stale),
    /too sparse or stale/,
  );

  const staleMetadata = validReport();
  for (const frame of staleMetadata.screencast.frames) frame.metadata.timestamp -= 10;
  staleMetadata.screencast.terminalTail = terminalTail(
    staleMetadata.screencast.frames,
    staleMetadata.screencast.terminalTail.terminalObservedAtMs,
  );
  assert.throws(
    () => verifyPublicSmbScreencastReport(staleMetadata),
    /too sparse or stale/,
  );
});
