#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sourcePath = new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
);
const source = readFileSync(sourcePath, "utf8");
const controllerStart = source.lastIndexOf("    let controllerSequence = 0;");
const controllerEnd = source.indexOf(
  "    function submitGxFrame(message)",
  controllerStart,
);
assert.notEqual(controllerStart, -1, "missing controller binding start");
assert.notEqual(controllerEnd, -1, "missing packed renderer submission boundary");
const controllerSource = source.slice(controllerStart, controllerEnd);

class FakeElement {
  constructor(nativeAction = false) {
    this.captures = new Set();
    this.listeners = new Map();
    this.nativeAction = nativeAction;
    this.style = {};
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  closest() {
    return this.nativeAction ? this : null;
  }

  dispatch(type, properties = {}) {
    const event = {
      button: 0,
      code: "",
      currentTarget: this,
      defaultPrevented: false,
      detail: 0,
      pointerId: 0,
      pointerType: "mouse",
      timeStamp: 0,
      target: this,
      preventDefault() { this.defaultPrevented = true; },
      ...properties,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  hasPointerCapture(pointerId) {
    return this.captures.has(pointerId);
  }

  setPointerCapture(pointerId) {
    this.captures.add(pointerId);
  }

  releasePointerCapture(pointerId) {
    if (!this.captures.delete(pointerId)) return;
    this.dispatch("lostpointercapture", { pointerId });
  }
}

function createEventTarget(nativeAction = false) {
  return new FakeElement(nativeAction);
}

function createHarness() {
  const buttons = new Map([
    ["#controller-up", createEventTarget(true)],
    ["#controller-down", createEventTarget(true)],
    ["#controller-left", createEventTarget(true)],
    ["#controller-right", createEventTarget(true)],
    ["#controller-a", createEventTarget(true)],
    ["#controller-b", createEventTarget(true)],
    ["#controller-start", createEventTarget(true)],
  ]);
  const body = createEventTarget(false);
  const documentListeners = new Map();
  const windowListeners = new Map();
  const messages = [];
  const gamepads = [];
  const timers = new Map();
  let timerId = 0;

  function addListener(target, type, listener) {
    const listeners = target.get(type) ?? [];
    listeners.push(listener);
    target.set(type, listeners);
  }

  function dispatch(listeners, type, properties = {}) {
    const event = {
      code: "",
      defaultPrevented: false,
      pointerId: 0,
      target: body,
      preventDefault() { this.defaultPrevented = true; },
      ...properties,
    };
    for (const listener of listeners.get(type) ?? []) listener(event);
    return event;
  }

  const document = {
    hidden: false,
    addEventListener(type, listener) {
      addListener(documentListeners, type, listener);
    },
    querySelector(selector) {
      return buttons.get(selector) ?? null;
    },
  };
  const context = {
    Element: FakeElement,
    addEventListener(type, listener) {
      addListener(windowListeners, type, listener);
    },
    clearTimeout(id) { timers.delete(id); },
    document,
    lastControllerPacket: "",
    navigator: { getGamepads: () => gamepads },
    requestAnimationFrame() {},
    setTimeout(callback, duration) {
      timerId += 1;
      timers.set(timerId, { callback, duration });
      return timerId;
    },
    worker: { postMessage(message) { messages.push(message); } },
  };
  vm.createContext(context);
  vm.runInContext(controllerSource, context, {
    filename: "browser_boot.controller.js",
  });

  return {
    body,
    buttons,
    context,
    document,
    gamepads,
    dispatchDocument(type, properties) {
      return dispatch(documentListeners, type, properties);
    },
    dispatchWindow(type, properties) {
      return dispatch(windowListeners, type, properties);
    },
    acknowledgePoll(buttons, sequence = messages.at(-1)?.sequence ?? 0) {
      context.acknowledgeControllerPoll(buttons, sequence);
    },
    latestButtons() {
      context.sampleController();
      return messages.at(-1).state.buttons;
    },
    latestState() {
      context.sampleController();
      return JSON.parse(JSON.stringify(messages.at(-1).state));
    },
    messages,
    timers,
  };
}

test("keyboard directions drive the main stick and retain D-pad bits", () => {
  const harness = createHarness();

  harness.dispatchWindow("keydown", { code: "ArrowLeft" });
  let state = harness.latestState();
  assert.deepEqual(
    state,
    {
      buttons: 0x0001,
      stickX: 0x01,
      stickY: 0x80,
      cStickX: 0x80,
      cStickY: 0x80,
      triggerL: 0,
      triggerR: 0,
      analogA: 0,
      analogB: 0,
    },
  );

  harness.dispatchWindow("keydown", { code: "ArrowUp" });
  state = harness.latestState();
  assert.deepEqual(
    { buttons: state.buttons, stickX: state.stickX, stickY: state.stickY },
    { buttons: 0x0009, stickX: 0x01, stickY: 0xff },
  );

  harness.dispatchWindow("keyup", { code: "ArrowLeft" });
  state = harness.latestState();
  assert.deepEqual(
    { buttons: state.buttons, stickX: state.stickX, stickY: state.stickY },
    { buttons: 0x0008, stickX: 0x80, stickY: 0xff },
  );
});

test("touch directions atomically publish matching D-pad and stick states", () => {
  const harness = createHarness();
  const right = harness.buttons.get("#controller-right");

  right.dispatch("pointerdown", {
    pointerId: 12,
    pointerType: "touch",
    timeStamp: 100,
  });
  let state = harness.latestState();
  assert.deepEqual(
    { buttons: state.buttons, stickX: state.stickX, stickY: state.stickY },
    { buttons: 0x0002, stickX: 0xff, stickY: 0x80 },
  );
  for (let poll = 0; poll < 3; poll += 1) {
    harness.acknowledgePoll(0x0002);
  }

  right.dispatch("pointerup", {
    pointerId: 12,
    pointerType: "touch",
    timeStamp: 400,
  });
  state = harness.latestState();
  assert.deepEqual(
    { buttons: state.buttons, stickX: state.stickX, stickY: state.stickY },
    { buttons: 0, stickX: 0x80, stickY: 0x80 },
  );

  const transitions = harness.messages.slice(-2);
  assert.deepEqual(
    transitions.map(message => [message.sequence, message.state.buttons, message.state.stickX]),
    [[2, 0x0002, 0xff], [3, 0, 0x80]],
  );
});

test("virtual directions override only their physical gamepad axis", () => {
  const harness = createHarness();
  harness.gamepads.push({
    axes: [-0.5, 0.25, 0.75, -1],
    buttons: [],
    connected: true,
  });

  let state = harness.latestState();
  assert.deepEqual(
    {
      stickX: state.stickX,
      stickY: state.stickY,
      cStickX: state.cStickX,
      cStickY: state.cStickY,
    },
    { stickX: 0x41, stickY: 0x60, cStickX: 0xdf, cStickY: 0xff },
  );

  harness.dispatchWindow("keydown", { code: "ArrowUp" });
  state = harness.latestState();
  assert.deepEqual(
    {
      buttons: state.buttons,
      stickX: state.stickX,
      stickY: state.stickY,
      cStickX: state.cStickX,
      cStickY: state.cStickY,
    },
    {
      buttons: 0x0008,
      stickX: 0x41,
      stickY: 0xff,
      cStickX: 0xdf,
      cStickY: 0xff,
    },
  );
});

test("captured pointers hold multiple controller buttons independently", () => {
  const harness = createHarness();
  const a = harness.buttons.get("#controller-a");
  const b = harness.buttons.get("#controller-b");

  a.dispatch("pointerdown", {
    pointerId: 1,
    pointerType: "touch",
    timeStamp: 0,
  });
  b.dispatch("pointerdown", {
    pointerId: 2,
    pointerType: "touch",
    timeStamp: 0,
  });
  assert.equal(a.hasPointerCapture(1), true);
  assert.equal(b.hasPointerCapture(2), true);
  assert.equal(harness.latestButtons(), 0x0300);
  for (let poll = 0; poll < 3; poll += 1) {
    harness.acknowledgePoll(0x0300);
  }

  a.dispatch("pointerup", {
    pointerId: 1,
    pointerType: "touch",
    timeStamp: 300,
  });
  assert.equal(harness.latestButtons(), 0x0200);
  b.dispatch("pointercancel", { pointerId: 2, pointerType: "touch" });
  assert.equal(harness.latestButtons(), 0);
});

test("fast pointer clicks survive delayed SI acknowledgement", () => {
  const harness = createHarness();
  const b = harness.buttons.get("#controller-b");

  b.dispatch("pointerdown", {
    pointerId: 17,
    pointerType: "mouse",
    timeStamp: 100,
  });
  b.dispatch("pointerup", {
    pointerId: 17,
    pointerType: "mouse",
    timeStamp: 110,
  });
  b.dispatch("click", { detail: 1, timeStamp: 110 });

  assert.equal(harness.messages.at(-1).state.buttons, 0x0200);
  assert.equal(harness.timers.size, 1);
  const [timerId, timer] = harness.timers.entries().next().value;
  assert.equal(timer.duration, 240);
  harness.timers.delete(timerId);
  timer.callback();
  assert.equal(harness.latestButtons(), 0x0200);
  assert.equal(harness.timers.size, 1);
  assert.equal(harness.timers.values().next().value.duration, 1_760);
  for (let poll = 0; poll < 2; poll += 1) {
    harness.acknowledgePoll(0x0200);
  }
  assert.equal(harness.latestButtons(), 0x0200);
  harness.acknowledgePoll(0x0200);
  assert.deepEqual(
    harness.messages.slice(-2).map(message => [message.sequence, message.state.buttons]),
    [[2, 0x0200], [3, 0]],
  );
  assert.equal(b.hasPointerCapture(17), false);
});

test("button pulses synchronously publish their press and timed release", () => {
  const harness = createHarness();

  harness.context.lazuliController.pulseA(250);
  assert.equal(harness.messages.at(-1).state.buttons, 0x0100);
  assert.equal(harness.timers.size, 1);
  for (let poll = 0; poll < 3; poll += 1) {
    harness.acknowledgePoll(0x0100);
  }
  assert.equal(harness.latestButtons(), 0x0100);

  const [timerId, timer] = harness.timers.entries().next().value;
  harness.timers.delete(timerId);
  timer.callback();
  assert.deepEqual(
    harness.messages.slice(-2).map(message => message.state.buttons),
    [0x0100, 0],
  );
  assert.equal(harness.latestButtons(), 0);
});

test("repeated same-button clicks publish a fresh release and press edge", () => {
  const harness = createHarness();
  const a = harness.buttons.get("#controller-a");

  a.dispatch("pointerdown", {
    pointerId: 20,
    pointerType: "mouse",
    timeStamp: 100,
  });
  a.dispatch("pointerup", {
    pointerId: 20,
    pointerType: "mouse",
    timeStamp: 110,
  });
  const firstTimer = harness.timers.values().next().value;
  a.dispatch("pointerdown", {
    pointerId: 21,
    pointerType: "mouse",
    timeStamp: 120,
  });
  a.dispatch("pointerup", {
    pointerId: 21,
    pointerType: "mouse",
    timeStamp: 130,
  });

  assert.deepEqual(
    harness.messages.slice(-3).map(message => [message.sequence, message.state.buttons]),
    [[2, 0x0100], [3, 0], [4, 0x0100]],
  );
  assert.equal(harness.timers.size, 1);

  firstTimer.callback();
  assert.equal(harness.latestButtons(), 0x0100);
});

test("pulse watchdog releases input when SI acknowledgements never arrive", () => {
  const harness = createHarness();

  harness.context.lazuliController.pulseB(250);
  let [timerId, timer] = harness.timers.entries().next().value;
  harness.timers.delete(timerId);
  timer.callback();

  assert.equal(harness.latestButtons(), 0x0200);
  assert.equal(harness.timers.size, 1);
  [timerId, timer] = harness.timers.entries().next().value;
  assert.equal(timer.duration, 1_750);
  harness.timers.delete(timerId);
  timer.callback();

  assert.equal(harness.latestButtons(), 0);
  assert.equal(harness.timers.size, 0);
});

test("window blur clears keyboard, pointer, and pulse input", () => {
  const harness = createHarness();
  const b = harness.buttons.get("#controller-b");
  harness.dispatchWindow("keydown", { code: "KeyZ" });
  b.dispatch("pointerdown", { pointerId: 7, pointerType: "touch" });
  harness.context.lazuliController.pulseStart(1000);
  assert.equal(harness.latestButtons(), 0x1300);
  assert.equal(harness.timers.size, 1);

  harness.dispatchWindow("blur");
  assert.equal(harness.latestButtons(), 0);
  assert.equal(harness.timers.size, 0);
  assert.equal(b.hasPointerCapture(7), false);
});

test("visibility loss clears all held controller input", () => {
  const harness = createHarness();
  const a = harness.buttons.get("#controller-a");
  harness.dispatchWindow("keydown", { code: "ArrowLeft" });
  a.dispatch("pointerdown", { pointerId: 9, pointerType: "touch" });
  harness.context.lazuliController.pulseStart(1000);
  assert.equal(harness.latestButtons(), 0x1101);

  harness.document.hidden = true;
  harness.dispatchDocument("visibilitychange");
  assert.equal(harness.latestButtons(), 0);
});

test("native click activation pulses without stealing focused controls", () => {
  const harness = createHarness();
  const a = harness.buttons.get("#controller-a");
  const keydown = harness.dispatchWindow("keydown", {
    code: "Enter",
    target: a,
  });
  assert.equal(keydown.defaultPrevented, false);
  assert.equal(harness.latestButtons(), 0);

  a.dispatch("click", { detail: 0 });
  assert.equal(harness.latestButtons(), 0x0100);
  harness.dispatchWindow("blur");
  a.dispatch("click", { detail: 1 });
  assert.equal(harness.latestButtons(), 0);
});
