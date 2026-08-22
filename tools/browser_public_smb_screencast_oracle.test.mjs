// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PublicSmbScreencastValidationError,
  verifyPublicSmbScreencastReport,
} from "./browser_public_smb_screencast_oracle.mjs";
import {
  PUBLIC_SMB_SCREENCAST_SCHEMA,
  derivePublicSmbTerminalProof,
} from "./browser_public_smb_screencast.mjs";
import { SUPER_MONKEY_BALL_READY_CHECKPOINT } from "./browser_boot_checkpoint_v3.mjs";
import {
  SMB_SUSTAINED_PLAY_SCHEMA_V4,
  SMB_SUSTAINED_PLAY_SCHEMA_V5,
} from "./browser_boot_smb_sustained_play.mjs";
import {
  smbSustainedPlayReport,
} from "./browser_boot_smb_sustained_play_test_fixture.mjs";
import {
  compactSchema4ReleaseIdentityFixture,
} from "./browser_public_release_identity.test_fixture.mjs";

const WIDTH = 1024;
const HEIGHT = 768;
const PIXELS = WIDTH * HEIGHT;

function release() {
  return compactSchema4ReleaseIdentityFixture({
    assetHash: "3".repeat(64),
    commit: "2".repeat(40),
  });
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
  frameUrl.search = "";
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
  const report = smbSustainedPlayReport(SMB_SUSTAINED_PLAY_SCHEMA_V5);
  report.execution.scheduler.renderEvery = 1;
  return derivePublicSmbTerminalProof(report);
}

function rebindTerminalReport(terminal) {
  const serialized = JSON.stringify(terminal.report);
  terminal.reportBytes = Buffer.byteLength(serialized);
  terminal.reportSha256 = createHash("sha256").update(serialized).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function canonicalIdentity(value) {
  const serialized = JSON.stringify(canonicalJson(value));
  return {
    bytes: Buffer.byteLength(serialized),
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

function summarizedFrame(index) {
  const digit = ((index % 4) + 7).toString(16);
  return {
    selectedOrdinal: index + 1,
    receivedOrdinal: index + 17,
    sessionId: 1,
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
    terminalMetadataAgeMs:
      terminalObservedAtMs - frames.at(-1).metadata.timestamp * 1_000,
    terminalTailAgeMs: terminalObservedAtMs - frames.at(-1).receivedAtMs,
    terminalReceivedOrdinal: frames.at(-1).receivedOrdinal,
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
  const publicUrl = "https://gekko.free/";
  const active = release();
  const frameUrl = new URL(active.frontend.url, publicUrl);
  frameUrl.search = "";
  const frames = Array.from({ length: 64 }, (_, index) => summarizedFrame(index));
  const terminal = terminalProof();
  const receiptPrefix = terminal.report.sustainedPlay.receipts.slice(0, 16);
  const prefixIdentity = canonicalIdentity(receiptPrefix);
  return {
    schema: "lazuli-public-smb-screencast-v6",
    mode: "sustained-public-viewport",
    alignment: "sustained-window-bounded",
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
    terminal,
    devtoolsExceptions: [],
    screencast: {
      protocol: "cdp-page-screencast-v1",
      format: "png",
      everyNthFrame: 1,
      width: WIDTH,
      height: HEIGHT,
      selection: "sustained-window-tail",
      capacityFrames: 64,
      firstReceivedOrdinal: 17,
      lastReceivedOrdinal: 80,
      receivedFrames: 80,
      postTerminalFrames: 0,
      acknowledgedFrames: 80,
      frames,
      terminalTail: terminalTail(frames),
      window: {
        scenario: "smb-sustained-play",
        step: "sustained-play-presented",
        snapshotRequestedAtMs: frames[0].receivedAtMs - 2,
        observedAtMs: frames[0].receivedAtMs - 1,
        observedCycle: terminal.report.cycles - 1_000,
        receivedFramesBeforeWindow: 16,
        postedReceipts: 16,
        pendingReceipts: 0,
        acceptedReceipts: 16,
        lastPresentationSerial: 907,
        lastReceiptOrdinal: 16,
        lastRendererSequence: 1015,
        receiptPrefixBytes: prefixIdentity.bytes,
        receiptPrefixSha256: prefixIdentity.sha256,
      },
    },
    oracle: null,
    oraclePassed: false,
  };
}

test("strict passive oracle accepts diverse non-serial public viewport summaries", () => {
  const report = validReport();
  assert.equal(PUBLIC_SMB_SCREENCAST_SCHEMA, "lazuli-public-smb-screencast-v6");
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

test("strict passive oracle rejects the superseded v5 outer schema", () => {
  const report = validReport();
  report.schema = "lazuli-public-smb-screencast-v5";
  assert.throws(
    () => verifyPublicSmbScreencastReport(report),
    error => (
      error instanceof PublicSmbScreencastValidationError
      && error.path === "$.schema"
      && /lazuli-public-smb-screencast-v6/.test(error.message)
    ),
  );
});

test("strict passive oracle rejects superseded sustained-play v4 evidence", () => {
  const report = validReport();
  report.terminal.report.sustainedPlay.schema = SMB_SUSTAINED_PLAY_SCHEMA_V4;
  rebindTerminalReport(report.terminal);
  assert.throws(
    () => verifyPublicSmbScreencastReport(report),
    error => (
      error instanceof PublicSmbScreencastValidationError
      && error.path === "$.terminal.report.sustainedPlay.schema"
      && /lazuli-smb-sustained-play-v5/.test(error.message)
    ),
  );
});

test("sustained window fences all 64 selected frames after a live receipt prefix", () => {
  const report = validReport();
  assert.doesNotThrow(() => verifyPublicSmbScreencastReport(report));

  const earlyFrame = validReport();
  earlyFrame.screencast.window.observedAtMs =
    earlyFrame.screencast.frames[0].receivedAtMs + 1;
  assert.throws(
    () => verifyPublicSmbScreencastReport(earlyFrame),
    /selected tail begins before window observation/,
  );

  const preObservationCapture = validReport();
  preObservationCapture.screencast.window.observedAtMs =
    preObservationCapture.screencast.frames[0].metadata.timestamp * 1_000 + 1;
  preObservationCapture.screencast.frames[0].receivedAtMs =
    preObservationCapture.screencast.window.observedAtMs + 1;
  preObservationCapture.screencast.terminalTail =
    terminalTail(preObservationCapture.screencast.frames);
  assert.throws(
    () => verifyPublicSmbScreencastReport(preObservationCapture),
    /captured before window observation/,
  );

  const reversedSnapshotFence = validReport();
  reversedSnapshotFence.screencast.window.snapshotRequestedAtMs =
    reversedSnapshotFence.screencast.window.observedAtMs + 1;
  assert.throws(
    () => verifyPublicSmbScreencastReport(reversedSnapshotFence),
    /snapshot request cannot postdate window observation/,
  );

  const preWindowOrdinal = validReport();
  preWindowOrdinal.screencast.window.receivedFramesBeforeWindow =
    preWindowOrdinal.screencast.firstReceivedOrdinal;
  assert.throws(
    () => verifyPublicSmbScreencastReport(preWindowOrdinal),
    /selected frames after window entry/,
  );

  const serialDrift = validReport();
  serialDrift.screencast.window.lastPresentationSerial += 1;
  assert.throws(
    () => verifyPublicSmbScreencastReport(serialDrift),
    /lastPresentationSerial/,
  );

  const prefixDrift = validReport();
  prefixDrift.screencast.window.receiptPrefixSha256 = "f".repeat(64);
  assert.throws(
    () => verifyPublicSmbScreencastReport(prefixDrift),
    /receiptPrefixSha256/,
  );

  const completedBeforeWindow = validReport();
  completedBeforeWindow.screencast.window.postedReceipts = 57;
  completedBeforeWindow.screencast.window.acceptedReceipts = 57;
  assert.throws(
    () => verifyPublicSmbScreencastReport(completedBeforeWindow),
    /leave at least 64 sustained VI receipts/,
  );
});

test("terminal pin excludes later deliveries and rejects later selected captures", () => {
  const excluded = validReport();
  excluded.screencast.receivedFrames = 82;
  excluded.screencast.acknowledgedFrames = 82;
  excluded.screencast.postTerminalFrames = 2;
  assert.doesNotThrow(() => verifyPublicSmbScreencastReport(excluded));

  const selectedAfterTerminal = validReport();
  const terminalObservedAtMs =
    selectedAfterTerminal.screencast.terminalTail.terminalObservedAtMs;
  selectedAfterTerminal.screencast.frames.at(-1).receivedAtMs =
    terminalObservedAtMs + 1;
  selectedAfterTerminal.screencast.terminalTail = terminalTail(
    selectedAfterTerminal.screencast.frames,
    terminalObservedAtMs,
  );
  assert.throws(
    () => verifyPublicSmbScreencastReport(selectedAfterTerminal),
    /too sparse or stale/,
  );

  const ordinalDrift = validReport();
  ordinalDrift.screencast.frames[0].receivedOrdinal += 1;
  assert.throws(
    () => verifyPublicSmbScreencastReport(ordinalDrift),
    /receivedOrdinal/,
  );
});

test("screencast acknowledgement tokens may be reused while frame clocks stay ordered", () => {
  const report = validReport();
  assert.deepEqual(new Set(report.screencast.frames.map(frame => frame.sessionId)), new Set([1]));
  assert.doesNotThrow(() => verifyPublicSmbScreencastReport(report));

  const invalid = validReport();
  invalid.screencast.frames[7].sessionId = 0;
  assert.throws(
    () => verifyPublicSmbScreencastReport(invalid),
    error => error instanceof PublicSmbScreencastValidationError
      && error.path === "$.screencast.frames[7].sessionId",
  );
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

test("passive oracle rejects separated black/white viewport extremes", () => {
  const report = validReport();
  report.screencast.frames[0].png.rgb = {
    black: PIXELS,
    white: 0,
    other: 0,
    unique: 1,
  };
  report.screencast.frames[2].png.rgb = {
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
    toOrdinal: 3,
  }]);

  const persistedFailure = JSON.parse(JSON.stringify(report));
  assert.throws(
    () => verifyPublicSmbScreencastReport(persistedFailure),
    error => error instanceof PublicSmbScreencastValidationError
      && error.path === "$.oracle.oppositeExtremeTransitions",
  );
});

test("passive oracle rejects every isolated extreme or monochrome flash", () => {
  const nearBlack = validReport();
  const nearBlackPixels = Math.ceil(PIXELS * 0.9);
  nearBlack.screencast.frames[7].png.rgb = {
    black: nearBlackPixels,
    white: 0,
    other: PIXELS - nearBlackPixels,
    unique: 2,
  };
  assert.throws(
    () => verifyPublicSmbScreencastReport(nearBlack),
    error => error instanceof PublicSmbScreencastValidationError
      && error.path === "$.oracle.nearBlackOrdinals",
  );
  assert.deepEqual(nearBlack.oracle.nearBlackOrdinals, [8]);

  const nearWhite = validReport();
  const nearWhitePixels = Math.ceil(PIXELS * 0.9);
  nearWhite.screencast.frames[11].png.rgb = {
    black: 0,
    white: nearWhitePixels,
    other: PIXELS - nearWhitePixels,
    unique: 2,
  };
  assert.throws(
    () => verifyPublicSmbScreencastReport(nearWhite),
    error => error instanceof PublicSmbScreencastValidationError
      && error.path === "$.oracle.nearWhiteOrdinals",
  );
  assert.deepEqual(nearWhite.oracle.nearWhiteOrdinals, [12]);

  const monochrome = validReport();
  monochrome.screencast.frames[15].png.rgb = {
    black: 0,
    white: 0,
    other: PIXELS,
    unique: 1,
  };
  assert.throws(
    () => verifyPublicSmbScreencastReport(monochrome),
    error => error instanceof PublicSmbScreencastValidationError
      && error.path === "$.oracle.monochromeOrdinals",
  );
  assert.deepEqual(monochrome.oracle.monochromeOrdinals, [16]);
});

test("passive oracle pins evidence to the exact production origin", () => {
  const invalidPublicUrls = [
    "http://gekko.free/",
    "https://localhost/",
    "https://user@gekko.free/",
    "https://gekko.free:8443/",
    "https://gekko.free/?scenario=smb-ready-play",
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
  frameChanged.after.frameUrl = "https://gekko.free/frontend.html";
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

  const identityCases = [
    [
      "runtime",
      value => { delete value.runtime.dispatcher; },
      /\$\.release\.runtime.*dispatcher/,
    ],
    [
      "runtime ABI",
      value => { value.runtime.abi.gameFidelityBytes += 1; },
      /\$\.release\.runtime\.abi\.gameFidelityBytes/,
    ],
    [
      "bootstrap",
      value => { value.bootstrap.releaseModule.url = "/assets/release.mjs"; },
      /\$\.release\.bootstrap\.releaseModule\.url/,
    ],
    [
      "nested rollback",
      value => { value.rollback.release.schema = 4; },
      /\$\.release\.rollback\.release\.schema/,
    ],
  ];
  for (const [label, mutate, pattern] of identityCases) {
    const report = validReport();
    mutate(report.release);
    report.terminalRelease = structuredClone(report.release);
    assert.throws(
      () => verifyPublicSmbScreencastReport(report),
      pattern,
      label,
    );
  }

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
  fakeTwoStep.terminal.gameplayTranscript =
    structuredClone(fakeTwoStep.terminal.gameplayTranscript);
  fakeTwoStep.terminal.gameplayTranscript.steps =
    fakeTwoStep.terminal.gameplayTranscript.steps.slice(0, 2);
  assert.throws(
    () => verifyPublicSmbScreencastReport(fakeTwoStep),
    /terminal\.gameplayTranscript/,
  );

  const forgedSustained = validReport();
  forgedSustained.terminal.report.sustainedPlay.receipts[1].presented = false;
  rebindTerminalReport(forgedSustained.terminal);
  assert.throws(
    () => verifyPublicSmbScreencastReport(forgedSustained),
    /strict sustained-play validation failed/,
  );

  const terminalError = validReport();
  terminalError.terminal.report.error = { message: "renderer failed" };
  rebindTerminalReport(terminalError.terminal);
  assert.throws(
    () => verifyPublicSmbScreencastReport(terminalError),
    /terminal\.report\.error/,
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
  staleMetadata.screencast.window.snapshotRequestedAtMs -= 10_000;
  staleMetadata.screencast.window.observedAtMs -= 10_000;
  staleMetadata.screencast.terminalTail = terminalTail(
    staleMetadata.screencast.frames,
    staleMetadata.screencast.terminalTail.terminalObservedAtMs,
  );
  assert.throws(
    () => verifyPublicSmbScreencastReport(staleMetadata),
    /too sparse or stale/,
  );
});
