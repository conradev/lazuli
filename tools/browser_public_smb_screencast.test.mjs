// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  PublicSmbScreencastCollector,
  assertCanonicalSmbDiscImage,
  captureGeometryReady,
  configuredPublicSmbCaptureUrl,
  derivePublicSmbTerminalProof,
  parsePublicSmbScreencastArguments,
  stopPublicSmbScreencast,
} from "./browser_public_smb_screencast.mjs";
import { SUPER_MONKEY_BALL_READY_CHECKPOINT } from "./browser_boot_checkpoint_v3.mjs";
import { gameplayReport } from "./browser_boot_gameplay_transcript_fixture.mjs";

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

test("passive collector acknowledges CDP frames and persists summaries without pixels", async () => {
  const session = fakeSession();
  const collector = new PublicSmbScreencastCollector(session, { capacityFrames: 2 });
  session.emit({
    data: viewportPng(10).toString("base64"),
    metadata: metadata(10),
    sessionId: 1,
  });
  session.emit({
    data: viewportPng(20).toString("base64"),
    metadata: metadata(11),
    sessionId: 2,
  });
  await collector.close();
  const evidence = collector.evidence();

  assert.equal(collector.tailReady(), true);
  assert.equal(evidence.receivedFrames, 2);
  assert.equal(evidence.acknowledgedFrames, 2);
  assert.equal(evidence.frames.length, 2);
  assert.equal(evidence.selection, "rolling-tail");
  assert.equal(evidence.firstReceivedOrdinal, 1);
  assert.equal(evidence.lastReceivedOrdinal, 2);
  assert.notEqual(evidence.frames[0].png.rgbSha256, evidence.frames[1].png.rgbSha256);
  assert.equal("rgba" in evidence.frames[0].png, false);
  assert.deepEqual(session.calls, [
    { method: "Page.screencastFrameAck", params: { sessionId: 1 } },
    { method: "Page.screencastFrameAck", params: { sessionId: 2 } },
  ]);
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
  session.emit({ sessionId: 7 });
  await collector.close();
});

test("terminal tail proof rejects sparse and stale passive frame streams", async () => {
  const timestampBase = Date.now() / 1_000;
  const session = fakeSession();
  const collector = new PublicSmbScreencastCollector(session, {
    capacityFrames: 2,
    summarize: (event, ordinal) => ({
      ordinal,
      sessionId: event.sessionId,
      metadata: { timestamp: event.timestamp },
    }),
  });
  session.emit({ sessionId: 1, timestamp: timestampBase });
  session.emit({ sessionId: 2, timestamp: timestampBase + 6 });
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
  freshSession.emit({ sessionId: 1, timestamp: timestampBase });
  freshSession.emit({ sessionId: 2, timestamp: timestampBase + 0.016 });
  await fresh.close();
  assert.throws(
    () => fresh.pinTerminalTail(fresh.frames.at(-1).receivedAtMs + 5_001),
    /too sparse or stale/,
  );
  const terminalTail = fresh.pinTerminalTail(fresh.frames.at(-1).receivedAtMs);
  assert.equal(terminalTail.terminalTailAgeMs, 0);
  assert.equal(terminalTail.limits.maxTailSpanMs, 180_000);
});

test("rolling capture cannot finish at 64 and retains only the renumbered final 64", async () => {
  const session = fakeSession();
  const collector = new PublicSmbScreencastCollector(session, {
    capacityFrames: 64,
    summarize: (event, ordinal) => ({ ordinal, sessionId: event.sessionId, source: event.source }),
  });
  for (let ordinal = 1; ordinal <= 70; ordinal += 1) {
    session.emit({ sessionId: ordinal, source: ordinal });
    if (ordinal === 64) {
      assert.equal(collector.tailReady(), true);
      assert.equal(collector.canFinalize(null), false, "64 early frames are not terminal proof");
    }
  }
  assert.equal(collector.canFinalize(null), false);
  assert.equal(collector.canFinalize({ status: "scenario-complete" }), true);
  await collector.close();
  const evidence = collector.evidence();
  assert.equal(evidence.receivedFrames, 70);
  assert.equal(evidence.acknowledgedFrames, 70);
  assert.equal(evidence.firstReceivedOrdinal, 7);
  assert.equal(evidence.lastReceivedOrdinal, 70);
  assert.deepEqual(evidence.frames.map(frame => frame.ordinal),
    Array.from({ length: 64 }, (_, index) => index + 1));
  assert.deepEqual(evidence.frames.map(frame => frame.source),
    Array.from({ length: 64 }, (_, index) => index + 7));
});

test("terminal proof requires exact paused smb-ready-play completion at default cadence", () => {
  const report = gameplayReport();
  report.execution.scheduler.renderEvery = 1;
  const proof = derivePublicSmbTerminalProof(report);
  assert.equal(proof.status, "paused");
  assert.equal(proof.stage, "scenario-complete");
  assert.equal(proof.scenario.stepCount, 13);
  assert.equal(proof.gameplayTranscript.steps.length, 13);
  assert.equal(proof.scheduler.renderEvery, 1);
  assert.match(proof.reportSha256, /^[0-9a-f]{64}$/);

  assert.throws(
    () => derivePublicSmbTerminalProof({ ...report, status: "running" }),
    /not paused at scenario-complete/,
  );
  assert.throws(
    () => derivePublicSmbTerminalProof({
      ...report,
      execution: { scheduler: { renderEvery: 2 } },
    }),
    /default renderEvery 1/,
  );

  const fakeTwoStepReport = structuredClone(report);
  fakeTwoStepReport.scenario.steps = fakeTwoStepReport.scenario.steps.slice(0, 2);
  fakeTwoStepReport.scenario.stepIndex = 2;
  assert.throws(
    () => derivePublicSmbTerminalProof(fakeTwoStepReport),
    /scenario\.steps\.length|expected 13/,
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
  session.emit({ sessionId: 1 });
  await assert.rejects(
    stopPublicSmbScreencast(session, collector, true),
    /stop failed/,
  );
  assert.equal(collector.evidence().acknowledgedFrames, 1);
  assert.deepEqual(session.calls, [
    { method: "Page.screencastFrameAck", params: { sessionId: 1 } },
  ]);
});

test("public SMB run URL is the exact passive trio on the outer root", () => {
  assert.equal(
    configuredPublicSmbCaptureUrl("https://gekko.free/", "run-1"),
    "https://gekko.free/?scenario=smb-ready-play&viewportCapture=1&headlessRun=run-1",
  );
  assert.throws(
    () => configuredPublicSmbCaptureUrl("https://gekko.free/app.html", "run-1"),
    /exact public root/,
  );
  assert.throws(
    () => configuredPublicSmbCaptureUrl("https://gekko.free/?renderEvery=1", "run-1"),
    /exact public root/,
  );
  for (const publicRoot of [
    "http://gekko.free/",
    "https://localhost/",
    "https://user@gekko.free/",
    "https://gekko.free:8443/",
  ]) {
    assert.throws(
      () => configuredPublicSmbCaptureUrl(publicRoot, "run-1"),
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
  assert.equal(options.publicUrl.includes("viewportCapture=1"), true);
  assert.equal(options.publicUrl.includes("renderEvery"), false);
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
  assert.match(source, /collector\.canFinalize\(terminalResult\?\.terminal \?\? null\)/);
  assert.match(source, /collector\.pinTerminalTail\(terminalResult\.observedAtMs\)/);
  assert.doesNotMatch(source, /collector\.complete\(\)/);
  assert.match(source, /Page\.getFrameTree/);
  assert.match(source, /top\.loaderId !== navigationLoaderId/);
  assert.match(source, /matchingFrames\[0\]\.loaderId/);
  assert.match(source, /canvas\.bufferWidth === 640/);
  assert.match(source, /canvas\.bufferHeight === 448/);
  assert.match(source, /canvas\.objectFit === "contain"/);
  assert.match(source, /SMB became \$\{capture\.status\} before the public viewport was capturable/);
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
