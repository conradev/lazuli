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
  "    const gxPresentationCachePixelLimit",
  controllerStart,
);
assert.notEqual(controllerStart, -1, "missing controller binding start");
assert.notEqual(controllerEnd, -1, "missing controller binding end");
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
    navigator: { getGamepads: () => [] },
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
    dispatchDocument(type, properties) {
      return dispatch(documentListeners, type, properties);
    },
    dispatchWindow(type, properties) {
      return dispatch(windowListeners, type, properties);
    },
    latestButtons() {
      context.sampleController();
      return messages.at(-1).state.buttons;
    },
    timers,
  };
}

test("captured pointers hold multiple controller buttons independently", () => {
  const harness = createHarness();
  const a = harness.buttons.get("#controller-a");
  const b = harness.buttons.get("#controller-b");

  a.dispatch("pointerdown", { pointerId: 1, pointerType: "touch" });
  b.dispatch("pointerdown", { pointerId: 2, pointerType: "touch" });
  assert.equal(a.hasPointerCapture(1), true);
  assert.equal(b.hasPointerCapture(2), true);
  assert.equal(harness.latestButtons(), 0x0300);

  a.dispatch("pointerup", { pointerId: 1, pointerType: "touch" });
  assert.equal(harness.latestButtons(), 0x0200);
  b.dispatch("pointercancel", { pointerId: 2, pointerType: "touch" });
  assert.equal(harness.latestButtons(), 0);
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
