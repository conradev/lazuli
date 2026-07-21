// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  DevToolsSession,
  observeHeadlessPage,
} from "./browser_boot_headless_cdp.mjs";
import {
  createUncompressedDevToolsSocket,
} from "./browser_boot_devtools_socket.mjs";

function manualTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    cancelTimer(id) {
      pending.delete(id);
    },
    fireNext() {
      const next = pending.entries().next().value;
      assert.notEqual(next, undefined, "expected a pending timer");
      const [id, callback] = next;
      pending.delete(id);
      callback();
    },
    pendingCount() {
      return pending.size;
    },
    scheduleTimer(callback) {
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      return id;
    },
  };
}

function virtualTimers(clock) {
  let nextId = 1;
  const pending = new Map();
  return {
    cancelTimer(id) {
      pending.delete(id);
    },
    pendingCount() {
      return pending.size;
    },
    scheduleTimer(callback, milliseconds) {
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      queueMicrotask(() => {
        const pendingCallback = pending.get(id);
        if (pendingCallback === undefined) return;
        pending.delete(id);
        clock.value += milliseconds;
        pendingCallback();
      });
      return id;
    },
  };
}

class FakeSocket {
  constructor(url) {
    this.calls = [];
    this.errorMethods = new Set();
    this.listeners = new Map();
    this.readyState = 0;
    this.responses = new Map([
      ["Runtime.enable", {}],
      ["Page.enable", {}],
    ]);
    this.stalledMethods = new Set();
    this.url = url;
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: options.once === true });
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    const listeners = this.listeners.get(type) ?? [];
    for (const entry of [...listeners]) {
      entry.listener(event);
      if (entry.once) listeners.splice(listeners.indexOf(entry), 1);
    }
  }

  open() {
    if (this.readyState === 3) return;
    this.readyState = 1;
    this.emit("open");
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  send(text) {
    const call = JSON.parse(text);
    this.calls.push(call);
    if (this.errorMethods.has(call.method)) {
      this.emit("error", { message: `${call.method} transport failure` });
      return;
    }
    if (this.responses.has(call.method) && !this.stalledMethods.has(call.method)) {
      this.respond(call.id, this.responses.get(call.method));
    }
  }

  respond(id, result) {
    this.emit("message", { data: JSON.stringify({ id, result }) });
  }

  throwException(detail) {
    this.emit("message", {
      data: JSON.stringify({
        method: "Runtime.exceptionThrown",
        params: { exceptionDetails: detail },
      }),
    });
  }
}

function timeoutError(method) {
  const error = new Error(`${method} timed out`);
  error.name = "DevToolsRequestTimeoutError";
  error.method = method;
  return error;
}

function exactLargeTerminalReport(length = 1_048_577) {
  const report = {
    error: "terminal sentinel",
    padding: "",
    stage: "worker",
    status: "stopped",
    tail: "complete-tail-sentinel",
  };
  const empty = JSON.stringify(report);
  report.padding = "x".repeat(length - empty.length);
  const text = JSON.stringify(report);
  assert.equal(text.length, length);
  return text;
}

test("DevTools sessions default to uncompressed WebSockets", () => {
  const session = new DevToolsSession("ws://127.0.0.1/devtools/page/default");
  assert.strictEqual(session.createSocket, createUncompressedDevToolsSocket);
});

test("DevTools requests time out cleanly and reconnect to the original target", async () => {
  const timers = manualTimers();
  const sockets = [];
  const targetUrl = "ws://127.0.0.1/devtools/page/original-target";
  const session = new DevToolsSession(targetUrl, {
    cancelTimer: timers.cancelTimer,
    createSocket(url) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
    requestTimeoutMs: 50,
    scheduleTimer: timers.scheduleTimer,
  });

  await session.connect();
  const lost = session.send("Runtime.evaluate", { expression: "lost" });
  const lostId = sockets[0].calls.at(-1).id;
  timers.fireNext();
  await assert.rejects(
    lost,
    error => error.name === "DevToolsRequestTimeoutError"
      && error.method === "Runtime.evaluate",
  );

  sockets[0].respond(lostId, { result: { value: "late" } });
  const next = session.send("Page.getFrameTree");
  sockets[0].respond(sockets[0].calls.at(-1).id, {
    frameTree: { frame: { loaderId: "loader-original" } },
  });
  assert.equal((await next).frameTree.frame.loaderId, "loader-original");

  sockets[0].throwException({ text: "before reconnect" });
  const closed = session.send("Runtime.evaluate", { expression: "closed" });
  sockets[0].close();
  await assert.rejects(
    closed,
    error => error.name === "DevToolsConnectionClosedError",
  );
  await session.reconnect();
  sockets[1].throwException({ text: "after reconnect" });

  assert.deepEqual(sockets.map(socket => socket.url), [targetUrl, targetUrl]);
  assert.deepEqual(
    sockets[1].calls.map(call => call.method),
    ["Runtime.enable", "Page.enable"],
  );
  assert.deepEqual(session.exceptions, [
    { text: "before reconnect" },
    { text: "after reconnect" },
  ]);
  session.close();
});

test("failed physical connections are closed instead of leaking late sockets", async () => {
  const timers = manualTimers();
  const sockets = [];
  const options = {
    cancelTimer: timers.cancelTimer,
    createSocket(url) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    requestTimeoutMs: 50,
    scheduleTimer: timers.scheduleTimer,
  };
  const timedOut = new DevToolsSession("ws://target/timed-out", options);
  const connecting = timedOut.connect();
  timers.fireNext();
  await assert.rejects(
    connecting,
    error => error.name === "DevToolsRequestTimeoutError"
      && error.method === "WebSocket.connect",
  );
  assert.equal(sockets[0].readyState, 3);
  sockets[0].open();
  assert.equal(sockets[0].readyState, 3);

  const invalid = new DevToolsSession("ws://target/invalid-json", options);
  const opened = invalid.connect();
  sockets[1].open();
  await opened;
  sockets[1].emit("message", { data: "not JSON" });
  assert.equal(sockets[1].readyState, 3);
  await assert.rejects(
    invalid.send("Runtime.evaluate"),
    error => error.name === "DevToolsConnectionClosedError",
  );

  const errored = new DevToolsSession("ws://target/errored", options);
  const opening = errored.connect();
  sockets[2].emit("error", { message: "connection refused" });
  await assert.rejects(
    opening,
    error => error.name === "DevToolsConnectionClosedError"
      && error.method === "WebSocket.connect",
  );
  assert.equal(sockets[2].readyState, 3);
});

test("every reconnect phase is bounded and closes its failed physical socket", async () => {
  for (const failure of ["WebSocket.connect", "Runtime.enable", "Page.enable"]) {
    const clock = { value: 0 };
    const timers = virtualTimers(clock);
    const sockets = [];
    const targetUrl = `ws://127.0.0.1/devtools/page/${failure}`;
    const session = new DevToolsSession(targetUrl, {
      cancelTimer: timers.cancelTimer,
      createSocket(url) {
        const socket = new FakeSocket(url);
        if (sockets.length === 1 && failure !== "WebSocket.connect") {
          socket.stalledMethods.add(failure);
        }
        sockets.push(socket);
        if (sockets.length === 1 || failure !== "WebSocket.connect") {
          queueMicrotask(() => socket.open());
        }
        return socket;
      },
      requestTimeoutMs: 10,
      scheduleTimer: timers.scheduleTimer,
    });

    await session.connect();
    await assert.rejects(
      session.reconnect({ deadline: 100, now: () => clock.value }),
      error => error.name === "DevToolsRequestTimeoutError"
        && error.method === failure,
      failure,
    );

    assert.equal(clock.value, 10, failure);
    assert.deepEqual(sockets.map(socket => socket.url), [targetUrl, targetUrl], failure);
    assert.equal(sockets[0].readyState, 3, failure);
    assert.equal(sockets[1].readyState, 3, failure);
    assert.equal(session.socket, null, failure);
    assert.equal(timers.pendingCount(), 0, failure);
  }
});

test("an opened socket error is closed before reconnect can retry", async () => {
  const timers = manualTimers();
  const sockets = [];
  const targetUrl = "ws://127.0.0.1/devtools/page/opened-error-target";
  const session = new DevToolsSession(targetUrl, {
    cancelTimer: timers.cancelTimer,
    createSocket(url) {
      const socket = new FakeSocket(url);
      if (sockets.length === 1) socket.errorMethods.add("Runtime.enable");
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
    requestTimeoutMs: 10,
    scheduleTimer: timers.scheduleTimer,
  });

  await session.connect();
  await assert.rejects(
    session.reconnect(),
    error => error.name === "DevToolsConnectionClosedError",
  );

  assert.deepEqual(sockets.map(socket => socket.url), [targetUrl, targetUrl]);
  assert.equal(sockets[0].readyState, 3);
  assert.equal(sockets[1].readyState, 3);
  assert.equal(session.socket, null);
  assert.equal(timers.pendingCount(), 0);
});

test("fresh observation recovers either lost read and returns the complete terminal report", async () => {
  const reportText = exactLargeTerminalReport();
  for (const failure of ["pageState", "Page.getFrameTree"]) {
    const calls = [];
    let generation = 0;
    const session = {
      exceptions: [{ text: "before reconnect" }],
      async readPageState() {
        calls.push({ generation, method: "pageState" });
        if (generation === 0 && failure === "pageState") {
          throw timeoutError("Runtime.evaluate");
        }
        return {
          dataset: { renderer: "wgpu-webgpu" },
          result: generation === 0 ? "" : reportText,
          title: "Lazuli debug harness",
          url: "http://127.0.0.1:8766/?headlessRun=fresh",
        };
      },
      async reconnect() {
        calls.push({ generation, method: "reconnect" });
        generation += 1;
        calls.push({ generation, method: "Runtime.enable" });
        calls.push({ generation, method: "Page.enable" });
        this.exceptions.push({ text: "after reconnect" });
      },
      async send(method) {
        calls.push({ generation, method });
        assert.equal(method, "Page.getFrameTree");
        if (generation === 0 && failure === "Page.getFrameTree") {
          throw timeoutError(method);
        }
        return {
          frameTree: { frame: { loaderId: "loader-fresh" } },
        };
      },
    };

    const observation = await observeHeadlessPage(session, {
      deadline: 1,
      includeFrameTree: true,
    }, {
      now: () => 0,
      pageState: value => value.readPageState(),
    });
    const report = JSON.parse(observation.state.result);

    assert.equal(observation.frameLoaderId, "loader-fresh", failure);
    assert.equal(observation.state.result.length, 1_048_577, failure);
    assert.equal(report.status, "stopped", failure);
    assert.equal(report.tail, "complete-tail-sentinel", failure);
    assert.equal(
      calls.filter(call => call.method === "pageState").length,
      2,
      failure,
    );
    assert.deepEqual(session.exceptions, [
      { text: "before reconnect" },
      { text: "after reconnect" },
    ]);
    assert.equal(
      calls.some(call => call.method === "Page.navigate" || call.method.startsWith("DOM.")),
      false,
      failure,
    );
    assert.deepEqual(
      calls.filter(call => call.method.endsWith("enable")).map(call => call.method),
      ["Runtime.enable", "Page.enable"],
      failure,
    );
  }
});

test("observation survives a read timeout and a reconnect Runtime.enable timeout", async () => {
  const reportText = exactLargeTerminalReport();
  const terminalState = {
    dataset: { renderer: "wgpu-webgpu" },
    result: reportText,
    title: "Lazuli debug harness",
    url: "http://127.0.0.1:8766/?headlessRun=fresh",
  };
  const clock = { value: 0 };
  const timers = virtualTimers(clock);
  const sockets = [];
  const targetUrl = "ws://127.0.0.1/devtools/page/exact-original-target";
  const session = new DevToolsSession(targetUrl, {
    cancelTimer: timers.cancelTimer,
    createSocket(url) {
      const socket = new FakeSocket(url);
      const generation = sockets.length;
      if (generation === 1) socket.stalledMethods.add("Runtime.enable");
      if (generation === 2) {
        socket.responses.set("Runtime.evaluate", {
          result: { value: terminalState },
        });
        socket.responses.set("Page.getFrameTree", {
          frameTree: { frame: { loaderId: "loader-after-reconnect" } },
        });
      }
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
    requestTimeoutMs: 10,
    scheduleTimer: timers.scheduleTimer,
  });

  await session.connect();
  const observation = await observeHeadlessPage(session, {
    deadline: 100,
    includeFrameTree: true,
  }, {
    async delay(milliseconds) {
      clock.value += milliseconds;
    },
    now: () => clock.value,
    pageState: value => value.evaluate("window.__lazuliHeadlessPageState"),
  });
  const report = JSON.parse(observation.state.result);

  assert.equal(clock.value, 45);
  assert.equal(observation.frameLoaderId, "loader-after-reconnect");
  assert.equal(observation.state.result.length, 1_048_577);
  assert.equal(report.status, "stopped");
  assert.equal(report.tail, "complete-tail-sentinel");
  assert.deepEqual(sockets.map(socket => socket.url), [
    targetUrl,
    targetUrl,
    targetUrl,
  ]);
  assert.deepEqual(sockets.map(socket => socket.calls.map(call => call.method)), [
    ["Runtime.evaluate"],
    ["Runtime.enable"],
    ["Runtime.enable", "Page.enable", "Runtime.evaluate", "Page.getFrameTree"],
  ]);
  assert.equal(sockets[0].readyState, 3);
  assert.equal(sockets[1].readyState, 3);
  assert.equal(sockets[2].readyState, 1);
  assert.equal(timers.pendingCount(), 0);
  assert.equal(
    sockets.some(socket => socket.calls.some(call =>
      call.method === "Page.navigate" || call.method.startsWith("DOM."))),
    false,
  );
  session.close();
  assert.equal(sockets[2].readyState, 3);
});

test("permanent reconnect failure stops at the observation deadline without leaks", async () => {
  const clock = { value: 0 };
  const timers = virtualTimers(clock);
  const sockets = [];
  const targetUrl = "ws://127.0.0.1/devtools/page/permanent-failure-target";
  const session = new DevToolsSession(targetUrl, {
    cancelTimer: timers.cancelTimer,
    createSocket(url) {
      const socket = new FakeSocket(url);
      if (sockets.length > 0) socket.stalledMethods.add("Runtime.enable");
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
    requestTimeoutMs: 10,
    scheduleTimer: timers.scheduleTimer,
  });

  await session.connect();
  await assert.rejects(
    observeHeadlessPage(session, {
      deadline: 60,
      includeFrameTree: true,
    }, {
      async delay(milliseconds) {
        clock.value += milliseconds;
      },
      now: () => clock.value,
      pageState: value => value.evaluate("window.__lazuliHeadlessPageState"),
    }),
    error => error.name === "DevToolsRequestTimeoutError"
      && error.method === "Runtime.enable",
  );

  assert.equal(clock.value, 60);
  assert.equal(sockets.length, 3);
  assert.deepEqual(sockets.map(socket => socket.url), [
    targetUrl,
    targetUrl,
    targetUrl,
  ]);
  assert.deepEqual(sockets.map(socket => socket.calls.map(call => call.method)), [
    ["Runtime.evaluate"],
    ["Runtime.enable"],
    ["Runtime.enable"],
  ]);
  assert.equal(sockets.every(socket => socket.readyState === 3), true);
  assert.equal(session.socket, null);
  assert.equal(timers.pendingCount(), 0);
  assert.equal(
    sockets.some(socket => socket.calls.some(call =>
      call.method === "Page.navigate" || call.method.startsWith("DOM."))),
    false,
  );
});
