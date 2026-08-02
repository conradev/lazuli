// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  PUBLIC_SMB_SCREENCAST_SCHEMA,
  PublicSmbScreencastCollector,
  assertCanonicalSmbDiscImage,
  captureGeometryReady,
  configuredPublicSmbCaptureUrl,
  derivePublicSmbTerminalProof,
  parsePublicSmbScreencastArguments,
  stopPublicSmbScreencast,
  waitForPublicSmbTerminal,
} from "./browser_public_smb_screencast.mjs";
import { SUPER_MONKEY_BALL_READY_CHECKPOINT } from "./browser_boot_checkpoint_v3.mjs";
import {
  SMB_SUSTAINED_PLAY_SCHEMA_V3,
  SMB_SUSTAINED_PLAY_SCHEMA_V4,
} from "./browser_boot_smb_sustained_play.mjs";
import {
  smbSustainedPlayReport,
} from "./browser_boot_smb_sustained_play_test_fixture.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function productionCaptureGeometry() {
  return {
    canvas: {
      bottom: 768,
      bufferHeight: 448,
      bufferWidth: 640,
      content: {
        bottom: 742.4,
        height: 716.8,
        left: 0,
        right: 1024,
        top: 25.6,
        width: 1024,
      },
      height: 768,
      left: 0,
      objectFit: "contain",
      objectPosition: "50% 50%",
      right: 1024,
      top: 0,
      width: 1024,
    },
    error: null,
    iframe: {
      bottom: 768,
      height: 768,
      left: 0,
      right: 1024,
      top: 0,
      width: 1024,
    },
    viewport: {
      devicePixelRatio: 1,
      frameDevicePixelRatio: 1,
      frameHeight: 768,
      frameWidth: 1024,
      height: 768,
      scrollX: 0,
      scrollY: 0,
      width: 1024,
    },
  };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb88320;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return result;
}

function viewportPng(red) {
  const width = 1024;
  const height = 768;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const pixel = start + 1 + x * 4;
      scanlines[pixel] = red;
      scanlines[pixel + 1] = x & 0xff;
      scanlines[pixel + 2] = y & 0xff;
      scanlines[pixel + 3] = 255;
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND"),
  ]);
}

function metadata(timestamp) {
  return {
    offsetTop: 0,
    pageScaleFactor: 1,
    deviceWidth: 1024,
    deviceHeight: 768,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
    timestamp,
  };
}

function fakeSession() {
  let listener = null;
  const calls = [];
  return {
    calls,
    emit(event) { listener(event); },
    on(method, callback) {
      assert.equal(method, "Page.screencastFrame");
      listener = callback;
      return () => { listener = null; };
    },
    async send(method, params) {
      calls.push({ method, params });
      return {};
    },
  };
}

function beginSustainedWindow(collector, overrides = {}) {
  const observedAtMs = overrides.observedAtMs ?? Date.now();
  const receiptPrefix = Array.from({ length: 2 }, (_, index) => ({
    ordinal: index + 1,
    presented: index === 1,
    presentationSerial: index === 1 ? 1 : null,
    rendererSequence: 100 + index,
  }));
  return collector.beginSustainedWindow({
    snapshotRequestedAtMs:
      overrides.snapshotRequestedAtMs ?? observedAtMs - 1,
    observedAtMs,
    observedCycle: 1,
    pendingReceipts: 0,
    postedReceipts: receiptPrefix.length,
    receiptPrefix,
    ...overrides,
  });
}

function runningSustainedReport(receipts) {
  const report = smbSustainedPlayReport(SMB_SUSTAINED_PLAY_SCHEMA_V4);
  // Running prefix snapshots precede terminal surface-history publication.
  delete report.rendering.sustainedPresentedSurfaces;
  report.status = "running";
  report.stage = "execute";
  report.cycles -= 1_000;
  report.scenario.status = "running";
  report.scenario.completedCycle = null;
  report.scenario.stepIndex = 14;
  report.scenario.currentStep = "sustained-play-presented";
  report.scenario.steps = report.scenario.steps.slice(0, 14);
  report.sustainedPlay.receipts =
    report.sustainedPlay.receipts.slice(0, receipts);
  report.sustainedPlay.posted = receipts;
  report.sustainedPlay.pending = 0;
  return report;
}

test("terminal wait actively snapshots and retries before the first completed pair", async () => {
  const early = runningSustainedReport(0);
  const ready = runningSustainedReport(16);
  assert.equal(
    Object.hasOwn(early.rendering, "sustainedPresentedSurfaces"),
    false,
  );
  assert.equal(
    Object.hasOwn(ready.rendering, "sustainedPresentedSurfaces"),
    false,
  );
  const terminal = smbSustainedPlayReport(SMB_SUSTAINED_PLAY_SCHEMA_V4);
  terminal.execution.scheduler.renderEvery = 1;
  const runningState = {
    dataset: { renderer: "wgpu-webgpu", status: "running" },
    result: "STARTING",
    surface: "release",
  };
  const terminalState = {
    dataset: { renderer: "wgpu-webgpu", status: "paused" },
    result: JSON.stringify(terminal),
    surface: "release",
  };
  const stalePausedState = {
    dataset: { renderer: "wgpu-webgpu", status: "paused" },
    result: JSON.stringify(ready),
    surface: "release",
  };
  const states = [
    runningState,
    runningState,
    stalePausedState,
    terminalState,
  ];
  const snapshots = [
    { report: early, state: runningState },
    { report: ready, state: runningState },
  ];
  let snapshotRequests = 0;
  const waitedRequestIds = [];
  let clockMs = 1_000;
  const collector = {
    window: null,
    throwIfFailed() {},
    beginSustainedWindow(window) {
      const lastPresented = window.receiptPrefix
        .filter(receipt => receipt.presented)
        .at(-1);
      this.window = {
        ...window,
        acceptedReceipts: window.receiptPrefix.length,
        lastPresentationSerial: lastPresented.presentationSerial,
      };
      return this.window;
    },
    pinTerminalTail(observedAtMs) {
      this.terminalObservedAtMs = observedAtMs;
    },
  };
  const result = await waitForPublicSmbTerminal({}, collector, {
    deadline: 10_000,
    delay: async () => {},
    getState: async () => states.shift(),
    now: () => clockMs++,
    pollMs: 10,
    requestSnapshot: async () => {
      snapshotRequests += 1;
      return snapshotRequests;
    },
    waitSnapshot: async (_session, options) => {
      waitedRequestIds.push(options.requestId);
      return snapshots.shift();
    },
  });
  assert.equal(snapshotRequests, 2);
  assert.deepEqual(waitedRequestIds, [1, 2]);
  assert.equal(collector.window.snapshotRequestedAtMs, 1_004);
  assert.equal(collector.window.observedAtMs, 1_005);
  assert.equal(collector.window.acceptedReceipts, 16);
  assert.equal(collector.window.lastPresentationSerial, 907);
  assert.equal(collector.terminalObservedAtMs, 1_008);
  assert.equal(result.terminal.status, "paused");
});

test("passive collector acknowledges CDP frames and persists summaries without pixels", async () => {
  const session = fakeSession();
  const collector = new PublicSmbScreencastCollector(session, { capacityFrames: 2 });
  const window = beginSustainedWindow(collector);
  const firstTimestamp = window.observedAtMs / 1_000 + 0.001;
  session.emit({
    data: viewportPng(10).toString("base64"),
    metadata: metadata(firstTimestamp),
    sessionId: 1,
  });
  session.emit({
    data: viewportPng(20).toString("base64"),
    metadata: metadata(firstTimestamp + 0.001),
    sessionId: 2,
  });
  collector.pinTerminalTail(
    Math.max(Date.now(), Math.ceil((firstTimestamp + 0.001) * 1_000)),
  );
  await collector.close();
  const evidence = collector.evidence();

  assert.equal(collector.tailReady(), true);
  assert.equal(evidence.receivedFrames, 2);
  assert.equal(evidence.acknowledgedFrames, 2);
  assert.equal(evidence.frames.length, 2);
  assert.equal(evidence.selection, "sustained-window-tail");
  assert.equal(evidence.firstReceivedOrdinal, 1);
  assert.equal(evidence.lastReceivedOrdinal, 2);
  assert.deepEqual(
    evidence.frames.map(frame => frame.receivedOrdinal),
    [1, 2],
  );
  assert.deepEqual(
    evidence.frames.map(frame => frame.selectedOrdinal),
    [1, 2],
  );
  assert.notEqual(evidence.frames[0].png.rgbSha256, evidence.frames[1].png.rgbSha256);
  assert.equal("rgba" in evidence.frames[0].png, false);
  assert.deepEqual(session.calls, [
    { method: "Page.screencastFrameAck", params: { sessionId: 1 } },
    { method: "Page.screencastFrameAck", params: { sessionId: 2 } },
  ]);
});

test("sustained window separates snapshot dispatch from publication observation", () => {
  const session = fakeSession();
  const collector = new PublicSmbScreencastCollector(session, {
    capacityFrames: 1,
  });
  const window = beginSustainedWindow(collector, {
    snapshotRequestedAtMs: 100,
    observedAtMs: 101,
  });
  assert.equal(window.snapshotRequestedAtMs, 100);
  assert.equal(window.observedAtMs, 101);

  const invalid = new PublicSmbScreencastCollector(fakeSession(), {
    capacityFrames: 1,
  });
  assert.throws(
    () => beginSustainedWindow(invalid, {
      snapshotRequestedAtMs: 102,
      observedAtMs: 101,
    }),
    /snapshot request cannot postdate sustained window observation/,
  );
});

test("passive collector fails closed on malformed PNG data after acknowledging transport", async () => {
  const session = fakeSession();
  const collector = new PublicSmbScreencastCollector(session, { capacityFrames: 1 });
  session.emit({ data: "not/base64", metadata: metadata(10), sessionId: 1 });
  await assert.rejects(collector.close(), /invalid bounded base64/);
  assert.deepEqual(session.calls, [
    { method: "Page.screencastFrameAck", params: { sessionId: 1 } },
  ]);
});

test("passive collector ACKs transport before decoding or summarizing a frame", async () => {
  const session = fakeSession();
  const collector = new PublicSmbScreencastCollector(session, {
    capacityFrames: 1,
    summarize: (event, ordinal) => {
      assert.deepEqual(session.calls, [
        { method: "Page.screencastFrameAck", params: { sessionId: 7 } },
      ]);
      return {
        ordinal,
        sessionId: event.sessionId,
        metadata: { timestamp: 10 },
      };
    },
  });
  beginSustainedWindow(collector);
  session.emit({ sessionId: 7 });
  await collector.close();
});

test("terminal tail proof rejects sparse and stale passive frame streams", async () => {
  const session = fakeSession();
  const collector = new PublicSmbScreencastCollector(session, {
    capacityFrames: 2,
    summarize: (event, ordinal) => ({
      ordinal,
      sessionId: event.sessionId,
      metadata: { timestamp: event.timestamp },
    }),
  });
  const sparseWindow = beginSustainedWindow(collector);
  const sparseTimestamp = sparseWindow.observedAtMs / 1_000 + 0.001;
  session.emit({ sessionId: 1, timestamp: sparseTimestamp });
  session.emit({ sessionId: 2, timestamp: sparseTimestamp + 6 });
  await collector.close();
  assert.throws(
    () => collector.pinTerminalTail(collector.frames.at(-1).receivedAtMs),
    /too sparse or stale/,
  );

  const freshSession = fakeSession();
  const fresh = new PublicSmbScreencastCollector(freshSession, {
    capacityFrames: 2,
    summarize: (event, ordinal) => ({
      ordinal,
      sessionId: event.sessionId,
      metadata: { timestamp: event.timestamp },
    }),
  });
  const freshWindow = beginSustainedWindow(fresh);
  const freshTimestamp = freshWindow.observedAtMs / 1_000 + 0.001;
  freshSession.emit({ sessionId: 1, timestamp: freshTimestamp });
  freshSession.emit({ sessionId: 2, timestamp: freshTimestamp + 0.001 });
  await fresh.close();
  const freshTerminalObservedAtMs = Math.max(
    fresh.frames.at(-1).receivedAtMs,
    Math.ceil(fresh.frames.at(-1).metadata.timestamp * 1_000),
  );
  assert.throws(
    () => fresh.pinTerminalTail(freshTerminalObservedAtMs + 5_001),
    /too sparse or stale/,
  );
  const terminalTail = fresh.pinTerminalTail(freshTerminalObservedAtMs);
  assert.ok(terminalTail.terminalTailAgeMs >= 0);
  assert.equal(terminalTail.limits.maxTailSpanMs, 180_000);

  const preFenceSession = fakeSession();
  const preFence = new PublicSmbScreencastCollector(preFenceSession, {
    capacityFrames: 1,
    summarize: event => ({
      metadata: { timestamp: event.timestamp },
      sessionId: event.sessionId,
    }),
  });
  const fenceObservedAtMs = Date.now();
  beginSustainedWindow(preFence, { observedAtMs: fenceObservedAtMs });
  preFenceSession.emit({
    sessionId: 1,
    timestamp: fenceObservedAtMs / 1_000 - 0.001,
  });
  await preFence.close();
  assert.throws(
    () => preFence.pinTerminalTail(preFence.frames[0].receivedAtMs),
    /captured before the sustained window/,
  );
});

test("sustained window discards earlier frames and retains 64 later frames", async () => {
  const session = fakeSession();
  const collector = new PublicSmbScreencastCollector(session, {
    capacityFrames: 64,
    summarize: (event, receivedOrdinal) => ({
      metadata: { timestamp: event.timestamp },
      receivedOrdinal,
      sessionId: event.sessionId,
      source: event.source,
    }),
  });
  const timestampBase = Date.now() / 1_000;
  for (let ordinal = 1; ordinal <= 64; ordinal += 1) {
    session.emit({
      sessionId: ordinal,
      source: ordinal,
      timestamp: timestampBase + ordinal / 1_000,
    });
  }
  assert.equal(collector.tailReady(), true);
  assert.equal(
    collector.canFinalize({ status: "scenario-complete" }),
    false,
    "pre-window frames cannot certify sustained play",
  );
  const window = beginSustainedWindow(collector, {
    postedReceipts: 20,
    receiptPrefix: Array.from({ length: 20 }, (_, index) => ({
      ordinal: index + 1,
      presented: index % 2 === 1,
      presentationSerial: index % 2 === 1 ? (index + 1) / 2 : null,
      rendererSequence: 200 + index,
    })),
  });
  assert.equal(window.receivedFramesBeforeWindow, 64);
  assert.equal(collector.tailReady(), false);
  for (let ordinal = 65; ordinal <= 128; ordinal += 1) {
    session.emit({
      sessionId: ordinal,
      source: ordinal,
      timestamp: window.observedAtMs / 1_000 + (ordinal - 64) / 1_000,
    });
  }
  assert.equal(collector.canFinalize({ status: "scenario-complete" }), false);
  collector.pinTerminalTail(
    Math.max(
      Date.now(),
      Math.ceil((window.observedAtMs / 1_000 + 0.064) * 1_000),
    ),
  );
  assert.equal(collector.canFinalize({ status: "scenario-complete" }), true);
  session.emit({
    sessionId: 129,
    source: 129,
    timestamp: window.observedAtMs / 1_000 + 0.065,
  });
  await collector.close();
  const evidence = collector.evidence();
  assert.equal(evidence.receivedFrames, 129);
  assert.equal(evidence.acknowledgedFrames, 129);
  assert.equal(evidence.postTerminalFrames, 1);
  assert.equal(evidence.firstReceivedOrdinal, 65);
  assert.equal(evidence.lastReceivedOrdinal, 128);
  assert.deepEqual(evidence.frames.map(frame => frame.selectedOrdinal),
    Array.from({ length: 64 }, (_, index) => index + 1));
  assert.deepEqual(evidence.frames.map(frame => frame.receivedOrdinal),
    Array.from({ length: 64 }, (_, index) => index + 65));
  assert.deepEqual(evidence.frames.map(frame => frame.source),
    Array.from({ length: 64 }, (_, index) => index + 65));
});

test("terminal proof requires exact paired sustained play at default cadence", () => {
  const report = smbSustainedPlayReport(SMB_SUSTAINED_PLAY_SCHEMA_V4);
  report.execution.scheduler.renderEvery = 1;
  const proof = derivePublicSmbTerminalProof(report);
  assert.equal(proof.status, "paused");
  assert.equal(proof.stage, "scenario-complete");
  assert.equal(proof.scenario.stepCount, 15);
  assert.equal(proof.gameplayTranscript.steps.length, 13);
  assert.equal(proof.sustainedPlay.received, 120);
  assert.equal(proof.sustainedPlay.staged, 60);
  assert.equal(proof.sustainedPlay.presented, 60);
  assert.equal(proof.sustainedPlay.rejected, 0);
  assert.equal(proof.scheduler.renderEvery, 1);
  assert.strictEqual(proof.report, report);
  assert.match(proof.reportSha256, /^[0-9a-f]{64}$/);

  assert.throws(
    () => derivePublicSmbTerminalProof({ ...report, status: "running" }),
    /not paused at scenario-complete/,
  );
  const wrongCadence = structuredClone(report);
  wrongCadence.execution.scheduler.renderEvery = 2;
  assert.throws(
    () => derivePublicSmbTerminalProof(wrongCadence),
    /default renderEvery 1/,
  );

  const legacy = smbSustainedPlayReport(SMB_SUSTAINED_PLAY_SCHEMA_V3);
  legacy.execution.scheduler.renderEvery = 1;
  assert.throws(
    () => derivePublicSmbTerminalProof(legacy),
    /requires lazuli-smb-sustained-play-v4/,
  );

  const fakeTwoStepReport = structuredClone(report);
  fakeTwoStepReport.sustainedPlay.receipts[1].presented = false;
  assert.throws(
    () => derivePublicSmbTerminalProof(fakeTwoStepReport),
    /strict validation/,
  );
});

test("public SMB capture accepts only the canonical checkpoint CISO identity", () => {
  const canonical = SUPER_MONKEY_BALL_READY_CHECKPOINT.game.image;
  assert.strictEqual(assertCanonicalSmbDiscImage(canonical), canonical);
  assert.throws(
    () => assertCanonicalSmbDiscImage({
      ...canonical,
      sha256: "0".repeat(64),
    }),
    /canonical Super Monkey Ball CISO 441a0ead/,
  );
});

test("stopScreencast failure still closes the collector and drains acknowledgements", async () => {
  const session = fakeSession();
  const send = session.send.bind(session);
  session.send = async (method, params) => {
    if (method === "Page.stopScreencast") throw new Error("stop failed");
    return send(method, params);
  };
  const collector = new PublicSmbScreencastCollector(session, {
    capacityFrames: 1,
    summarize: (event, ordinal) => ({ ordinal, sessionId: event.sessionId }),
  });
  beginSustainedWindow(collector);
  session.emit({ sessionId: 1 });
  await assert.rejects(
    stopPublicSmbScreencast(session, collector, true),
    /stop failed/,
  );
  assert.equal(collector.acknowledgedFrames, 1);
  assert.deepEqual(session.calls, [
    { method: "Page.screencastFrameAck", params: { sessionId: 1 } },
  ]);
});

test("public SMB run URL remains the exact queryless outer root", () => {
  assert.equal(PUBLIC_SMB_SCREENCAST_SCHEMA, "lazuli-public-smb-screencast-v5");
  assert.equal(
    configuredPublicSmbCaptureUrl("https://gekko.free/"),
    "https://gekko.free/",
  );
  assert.throws(
    () => configuredPublicSmbCaptureUrl("https://gekko.free/not-root"),
    /exact public root/,
  );
  assert.throws(
    () => configuredPublicSmbCaptureUrl("https://gekko.free/?renderEvery=1"),
    /exact public root/,
  );
  for (const publicRoot of [
    "http://gekko.free/",
    "https://localhost/",
    "https://user@gekko.free/",
    "https://gekko.free:8443/",
  ]) {
    assert.throws(
      () => configuredPublicSmbCaptureUrl(publicRoot),
      /exact production origin https:\/\/gekko\.free/,
      publicRoot,
    );
  }
});

test("capture geometry distinguishes the full canvas box from contained 640x448 content", () => {
  const production = productionCaptureGeometry();
  assert.equal(captureGeometryReady(production), true);

  const oldBoxAssumption = structuredClone(production);
  Object.assign(oldBoxAssumption.canvas, {
    bottom: 742.4,
    height: 716.8,
    top: 25.6,
  });
  assert.equal(captureGeometryReady(oldBoxAssumption), false);

  const stretched = structuredClone(production);
  stretched.canvas.objectFit = "fill";
  assert.equal(captureGeometryReady(stretched), false);

  const wrongBacking = structuredClone(production);
  wrongBacking.canvas.bufferWidth = 608;
  assert.equal(captureGeometryReady(wrongBacking), false);
});

test("passive CLI requires exact release pins and has no renderer cadence option", () => {
  const base = [
    "--url", "https://gekko.free/",
    "--disc", "/tmp/smb.ciso",
    "--expect-commit", "1".repeat(40),
    "--expect-release-id", "2".repeat(64),
  ];
  const options = parsePublicSmbScreencastArguments(base);
  assert.equal(options.publicUrl, "https://gekko.free/");
  assert.equal("renderEvery" in options, false);
  assert.throws(
    () => parsePublicSmbScreencastArguments([...base, "--render-every", "1"]),
    /unknown argument --render-every/,
  );
});

test("passive runner uses Page.startScreencast without renderer rendezvous", async () => {
  const source = await readFile(
    new URL("./browser_public_smb_screencast.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /session\.send\("Page\.startScreencast"/);
  assert.match(source, /everyNthFrame: 1/);
  assert.match(source, /await waitForPublicSmbTerminal\(session, collector/);
  assert.match(source, /requestSnapshot = requestPublicSnapshot/);
  assert.match(source, /waitSnapshot = waitForPublicSnapshot/);
  assert.match(source, /await requestSnapshot\(session\)/);
  assert.match(source, /await waitSnapshot\(session, \{/);
  assert.ok(
    source.indexOf("snapshotRequestedAtMs = now()")
      < source.indexOf("await requestSnapshot(session)"),
  );
  assert.ok(
    source.indexOf("await waitSnapshot(session, {")
      < source.indexOf("snapshotObservedAtMs = now()"),
  );
  assert.match(
    source,
    /prefix\.acceptedReceipts < 2\s*\|\| prefix\.lastPresentationSerial === null/,
  );
  assert.match(source, /collector\.canFinalize\(terminalResult\?\.terminal \?\? null\)/);
  assert.match(source, /collector\.pinTerminalTail\(observedAtMs\)/);
  assert.doesNotMatch(source, /collector\.complete\(\)/);
  assert.match(source, /Page\.getFrameTree/);
  assert.match(source, /top\.loaderId !== navigationLoaderId/);
  assert.match(source, /matchingFrames\[0\]\.loaderId/);
  assert.match(source, /canvas\.bufferWidth === 640/);
  assert.match(source, /canvas\.bufferHeight === 448/);
  assert.match(source, /canvas\.objectFit === "contain"/);
  assert.match(source, /SMB became \$\{capture\.status\} before the public viewport was capturable/);
  assert.match(
    source,
    /configurePublicCompatibilityDebug\(session, \{\s*scenario: PUBLIC_SMB_SUSTAINED_SCENARIO,\s*viewportCapture: true,\s*\}\)/,
  );
  assert.match(source, /verifySmbSustainedPlay\(report\)/);
  assert.ok(
    source.indexOf("await configurePublicCompatibilityDebug(")
      < source.indexOf("await assignPublicDisc("),
    "compatibility scenario selection must precede local disc activation",
  );
  assert.match(source, /await stopPublicSmbScreencast\(session, collector, started\)/);
  assert.doesNotMatch(source, /lazuliCompositorCapture|capturePendingCompositorFrame/);
  assert.doesNotMatch(source, /setRenderEvery|renderEvery=/);
  assert.ok(
    source.indexOf("await identifyLocalDiscImage(options.disc)")
      < source.indexOf("assertCanonicalSmbDiscImage(discImage)"),
    "local disc identity must be checked against the canonical SMB CISO immediately",
  );
  assert.ok(
    source.indexOf("assertCanonicalSmbDiscImage(discImage)")
      < source.indexOf("await publicPageTarget(options.endpoint)"),
    "local disc identity must fail closed before Chrome is contacted",
  );
});
