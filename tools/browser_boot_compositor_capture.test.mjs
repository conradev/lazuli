// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

function temporalCapture(ordinal = 1) {
  const generation = 500 + ordinal;
  return {
    scenario: "smb-ready-play",
    step: "post-play-presented",
    ordinal,
    rendererSequence: 700 + ordinal,
    presentation: {
      selected: true,
      field: ordinal % 2 === 0 ? "bottom" : "top",
      address: "0x01200500",
      copyIndex: generation,
      copyRow: 0,
      width: 640,
      height: 448,
    },
    presentedSurface: {
      address: "0x01200500",
      generation,
      row: 0,
      presentationSerial: 900 + ordinal,
      width: 640,
      height: 448,
    },
  };
}

function coordinatorHarness() {
  const animationFrames = [];
  const cancelledAnimationFrames = [];
  const timers = new Map();
  let nextAnimationFrame = 1;
  let nextTimer = 1;
  let randomSequence = 0;
  const rect = {
    bottom: 608,
    height: 448,
    left: 192,
    right: 832,
    top: 160,
    width: 640,
  };
  const currentWorker = {};
  const document = {
    visibilityState: "visible",
  };
  const context = {
    URLSearchParams,
    acknowledgedCompositorCaptureToken: null,
    activeCompositorCapture: null,
    compositorCaptureEnabled: true,
    compositorCaptureSequence: 0,
    compositorCaptureTimeoutMs: 60_000,
    compositorCaptureWorkerEpoch: 3,
    crypto: {
      randomUUID() {
        randomSequence += 1;
        return `00000000-0000-4000-8000-${String(randomSequence).padStart(12, "0")}`;
      },
    },
    devicePixelRatio: 1,
    display: {
      height: 448,
      isConnected: true,
      width: 640,
      getBoundingClientRect() { return { ...rect }; },
    },
    document,
    innerHeight: 768,
    innerWidth: 1024,
    scrollX: 0,
    scrollY: 0,
    temporalSelectedXfbCapacity: 8,
    visualViewport: {
      height: 768,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: 1,
      width: 1024,
    },
    worker: currentWorker,
    cancelAnimationFrame(id) { cancelledAnimationFrames.push(id); },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) {
      const id = nextAnimationFrame;
      nextAnimationFrame += 1;
      animationFrames.push({ callback, id });
      return id;
    },
    setTimeout(callback, delay) {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, delay });
      return id;
    },
  };
  vm.createContext(context);
  vm.runInContext([
    "freezeCompositorGeometry",
    "captureCompositorGeometry",
    "compositorGeometryEqual",
    "compositorCaptureProvenance",
    "finishCompositorCapture",
    "failCompositorCapture",
    "resetCompositorCaptureForWorker",
    "buildCompositorCaptureDescriptor",
    "waitForCompositorCapture",
    "pendingCompositorCapture",
    "acknowledgeCompositorCapture",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.compositor-capture.js",
  });
  function runAnimationFrame() {
    const frame = animationFrames.shift();
    assert.ok(frame, "expected a queued animation frame");
    frame.callback();
    return frame.id;
  }
  function runTimeout() {
    const [id, timer] = timers.entries().next().value ?? [];
    assert.ok(timer, "expected a pending timeout");
    timers.delete(id);
    timer.callback();
    return timer.delay;
  }
  return {
    animationFrames,
    cancelledAnimationFrames,
    context,
    currentWorker,
    document,
    rect,
    runAnimationFrame,
    runTimeout,
    timers,
  };
}

test("compositor capture is a strict SMB-only query opt-in", () => {
  const context = { URLSearchParams };
  vm.createContext(context);
  vm.runInContext(extractFunction("compositorCaptureOptIn"), context);

  assert.equal(context.compositorCaptureOptIn("?scenario=smb-ready-play"), false);
  assert.equal(
    context.compositorCaptureOptIn(
      "?scenario=smb-ready-play&compositorCapture=1&headlessRun=run-1",
    ),
    true,
  );
  for (const search of [
    "?compositorCapture=1",
    "?scenario=warioware&compositorCapture=1",
    "?scenario=smb-ready-play&compositorCapture=0",
    "?scenario=smb-ready-play&compositorCapture=1&compositorCapture=1",
    "?scenario=smb-ready-play&scenario=smb-ready-play&compositorCapture=1",
    "?scenario=smb-ready-play&compositorCapture=1",
    "?scenario=smb-ready-play&compositorCapture=1&headlessRun=",
    "?scenario=smb-ready-play&compositorCapture=1&headlessRun=a&headlessRun=b",
  ]) {
    assert.throws(
      () => context.compositorCaptureOptIn(search),
      /requires exactly one non-empty headlessRun/,
      search,
    );
  }
});

test("two stable animation frames publish one exact frozen descriptor", async () => {
  const harness = coordinatorHarness();
  const pending = harness.context.waitForCompositorCapture(
    temporalCapture(),
    harness.currentWorker,
  );
  assert.equal(harness.context.pendingCompositorCapture(), null);
  assert.equal(harness.animationFrames.length, 1);
  assert.equal([...harness.timers.values()][0].delay, 60_000);

  harness.runAnimationFrame();
  assert.equal(harness.context.pendingCompositorCapture(), null);
  assert.equal(harness.animationFrames.length, 1);
  harness.runAnimationFrame();

  const descriptor = harness.context.pendingCompositorCapture();
  assert.deepEqual(Array.from(Object.keys(descriptor)), [
    "protocol",
    "token",
    "scenario",
    "step",
    "ordinal",
    "rendererSequence",
    "presentationSerial",
    "address",
    "generation",
    "row",
    "width",
    "height",
    "geometry",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(descriptor)), {
    protocol: "lazuli-compositor-capture-v1",
    token: "lazuli-compositor-v1:3:1:701:901:00000000-0000-4000-8000-000000000001",
    scenario: "smb-ready-play",
    step: "post-play-presented",
    ordinal: 1,
    rendererSequence: 701,
    presentationSerial: 901,
    address: "0x01200500",
    generation: 501,
    row: 0,
    width: 640,
    height: 448,
    geometry: {
      canvas: {
        bufferWidth: 640,
        bufferHeight: 448,
        left: 192,
        top: 160,
        right: 832,
        bottom: 608,
        width: 640,
        height: 448,
      },
      viewport: {
        width: 1024,
        height: 768,
        devicePixelRatio: 1,
        scrollX: 0,
        scrollY: 0,
        visual: {
          offsetLeft: 0,
          offsetTop: 0,
          pageLeft: 0,
          pageTop: 0,
          width: 1024,
          height: 768,
          scale: 1,
        },
      },
    },
  });
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.geometry), true);
  assert.equal(Object.isFrozen(descriptor.geometry.canvas), true);
  assert.equal(Object.isFrozen(descriptor.geometry.viewport), true);
  assert.equal(Object.isFrozen(descriptor.geometry.viewport.visual), true);
  assert.doesNotThrow(() => structuredClone(descriptor));

  assert.equal(harness.context.acknowledgeCompositorCapture(descriptor.token), true);
  assert.strictEqual(await pending, descriptor);
  assert.equal(harness.context.pendingCompositorCapture(), null);
  assert.equal(harness.context.acknowledgeCompositorCapture(descriptor.token), true);
  assert.equal(harness.timers.size, 0);
  harness.context.resetCompositorCaptureForWorker(true);
  assert.throws(
    () => harness.context.acknowledgeCompositorCapture(descriptor.token),
    /no compositor capture is pending/,
  );
});

test("wrong, premature, hidden, and timed-out acknowledgements fail closed", async () => {
  {
    const harness = coordinatorHarness();
    assert.throws(
      () => harness.context.acknowledgeCompositorCapture(null),
      /no compositor capture is pending/,
    );
  }
  {
    const harness = coordinatorHarness();
    const pending = harness.context.waitForCompositorCapture(
      temporalCapture(),
      harness.currentWorker,
    );
    const rejected = assert.rejects(pending, /invalid compositor capture acknowledgement/);
    assert.throws(
      () => harness.context.acknowledgeCompositorCapture("premature"),
      /invalid compositor capture acknowledgement/,
    );
    await rejected;
    assert.equal(harness.context.pendingCompositorCapture(), null);
  }
  {
    const harness = coordinatorHarness();
    const pending = harness.context.waitForCompositorCapture(
      temporalCapture(),
      harness.currentWorker,
    );
    harness.runAnimationFrame();
    harness.runAnimationFrame();
    const rejected = assert.rejects(pending, /invalid compositor capture acknowledgement/);
    assert.throws(
      () => harness.context.acknowledgeCompositorCapture("wrong-token"),
      /invalid compositor capture acknowledgement/,
    );
    await rejected;
  }
  {
    const harness = coordinatorHarness();
    const pending = harness.context.waitForCompositorCapture(
      temporalCapture(),
      harness.currentWorker,
    );
    const rejected = assert.rejects(pending, /document became hidden/);
    harness.document.visibilityState = "hidden";
    harness.runAnimationFrame();
    await rejected;
  }
  {
    const harness = coordinatorHarness();
    const pending = harness.context.waitForCompositorCapture(
      temporalCapture(),
      harness.currentWorker,
    );
    const rejected = assert.rejects(pending, /acknowledgement timed out/);
    assert.equal(harness.runTimeout(), 60_000);
    await rejected;
  }
});

test("geometry drift and worker replacement cancel before publication", async () => {
  {
    const harness = coordinatorHarness();
    harness.rect.width += 1;
    harness.rect.right += 1;
    const pending = harness.context.waitForCompositorCapture(
      temporalCapture(),
      harness.currentWorker,
    );
    const rejected = assert.rejects(pending, /capture geometry is invalid/);
    harness.runAnimationFrame();
    await rejected;
    assert.equal(harness.context.pendingCompositorCapture(), null);
  }
  {
    const harness = coordinatorHarness();
    const pending = harness.context.waitForCompositorCapture(
      temporalCapture(),
      harness.currentWorker,
    );
    const rejected = assert.rejects(pending, /geometry changed between animation frames/);
    harness.runAnimationFrame();
    harness.rect.left += 1;
    harness.rect.right += 1;
    harness.runAnimationFrame();
    await rejected;
    assert.equal(harness.context.pendingCompositorCapture(), null);
  }
  {
    const harness = coordinatorHarness();
    const pending = harness.context.waitForCompositorCapture(
      temporalCapture(),
      harness.currentWorker,
    );
    const rejected = assert.rejects(pending, /cancelled by worker replacement/);
    harness.context.resetCompositorCaptureForWorker(true);
    await rejected;
    assert.equal(harness.context.pendingCompositorCapture(), null);
    assert.deepEqual(harness.cancelledAnimationFrames, [1]);
    assert.equal(harness.context.compositorCaptureWorkerEpoch, 4);
  }
});

test("provenance mismatch and concurrent capture requests fail closed", async () => {
  {
    const harness = coordinatorHarness();
    const capture = temporalCapture();
    capture.presentedSurface.presentationSerial = 0;
    assert.throws(
      () => harness.context.waitForCompositorCapture(capture, harness.currentWorker),
      /provenance is invalid/,
    );
  }
  {
    const harness = coordinatorHarness();
    const capture = temporalCapture();
    capture.presentedSurface.generation = 0;
    capture.presentation.copyIndex = 0;
    assert.throws(
      () => harness.context.waitForCompositorCapture(capture, harness.currentWorker),
      /provenance is invalid/,
    );
  }
  {
    const harness = coordinatorHarness();
    const first = harness.context.waitForCompositorCapture(
      temporalCapture(1),
      harness.currentWorker,
    );
    const firstRejected = assert.rejects(first, /duplicate compositor capture request/);
    const second = harness.context.waitForCompositorCapture(
      temporalCapture(2),
      harness.currentWorker,
    );
    await assert.rejects(second, /duplicate compositor capture request/);
    await firstRejected;
    assert.equal(harness.context.pendingCompositorCapture(), null);
  }
});

test("page contract fences renderer completion behind capture acknowledgement", () => {
  const rendererFrame = extractFunction("handleRendererFrame");
  const readback = rendererFrame.indexOf("await captureTemporalSelectedXfb");
  const compositor = rendererFrame.indexOf("await waitForCompositorCapture");
  const completion = rendererFrame.indexOf('type: "renderer-frame-complete"');
  assert.ok(readback >= 0 && readback < compositor && compositor < completion);
  assert.match(
    rendererFrame,
    /typeof compositorCaptureEnabled !== "undefined"\s*&& compositorCaptureEnabled/,
  );

  const workerStart = extractFunction("startWorker");
  assert.ok(
    workerStart.indexOf("resetCompositorCaptureForWorker(replacingWorker)")
      < workerStart.indexOf("worker.terminate()"),
  );
  assert.match(source, /Object\.defineProperty\(globalThis, "lazuliCompositorCapture"/);
  assert.match(source, /value: Object\.freeze\(\{\s*acknowledge:\s*acknowledgeCompositorCapture,\s*pending:\s*pendingCompositorCapture,/s);
  assert.match(source, /body\[data-compositor-capture="enabled"\][\s\S]*\.shell > \.play-controls/);
  assert.match(
    source,
    /body\[data-compositor-capture="enabled"\] \.shell #display \{[\s\S]*width: auto;[\s\S]*height: auto;[\s\S]*aspect-ratio: auto;[\s\S]*object-fit: fill;/,
  );
  assert.match(source, /document\.addEventListener\("visibilitychange"/);
});
