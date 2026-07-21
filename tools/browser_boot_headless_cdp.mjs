// SPDX-License-Identifier: GPL-3.0-only

import {
  createUncompressedDevToolsSocket,
} from "./browser_boot_devtools_socket.mjs";

export const DEFAULT_DEVTOOLS_REQUEST_TIMEOUT_MS = 10_000;

const TRANSIENT_ERROR_NAMES = new Set([
  "DevToolsConnectionClosedError",
  "DevToolsRequestTimeoutError",
]);

function transportError(name, message, method = null, cause = null) {
  const error = new Error(message);
  error.name = name;
  if (method !== null) error.method = method;
  if (cause !== null) error.cause = cause;
  return error;
}

function boundedTimeoutBefore(deadline, now, limit, method) {
  if (!Number.isFinite(deadline)) return limit;
  const remaining = Math.ceil(deadline - now());
  if (remaining <= 0) {
    throw transportError(
      "DevToolsRequestTimeoutError",
      `headless observation deadline expired before ${method}`,
      method,
    );
  }
  return Math.min(limit, remaining);
}

export function isTransientDevToolsError(error) {
  return TRANSIENT_ERROR_NAMES.has(error?.name);
}

export class DevToolsSession {
  constructor(url, {
    cancelTimer = clearTimeout,
    createSocket = createUncompressedDevToolsSocket,
    requestTimeoutMs = DEFAULT_DEVTOOLS_REQUEST_TIMEOUT_MS,
    scheduleTimer = setTimeout,
  } = {}) {
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error("DevTools request timeout must be a positive integer");
    }
    this.cancelTimer = cancelTimer;
    this.createSocket = createSocket;
    this.exceptions = [];
    this.generation = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.requestTimeoutMs = requestTimeoutMs;
    this.scheduleTimer = scheduleTimer;
    this.socket = null;
    this.url = url;
  }

  settle(id, generation, error, result) {
    const pending = this.pending.get(id);
    if (pending === undefined || pending.generation !== generation) return;
    this.pending.delete(id);
    this.cancelTimer(pending.timer);
    if (error !== null) pending.reject(error);
    else pending.resolve(result);
  }

  failGeneration(generation, error) {
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      this.settle(id, generation, error, null);
    }
    if (this.generation === generation) this.socket = null;
  }

  handleMessage(generation, socket, event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch (cause) {
      this.failGeneration(generation, transportError(
        "DevToolsConnectionClosedError",
        "Chrome DevTools sent an invalid protocol message",
        null,
        cause,
      ));
      socket.close();
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined || pending.generation !== generation) return;
      if (message.error !== undefined) {
        this.settle(
          message.id,
          generation,
          new Error(`${pending.method}: ${message.error.message}`),
          null,
        );
      } else {
        this.settle(message.id, generation, null, message.result ?? {});
      }
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      this.exceptions.push(message.params?.exceptionDetails ?? message.params ?? message);
    }
  }

  async openSocket(timeoutMs = this.requestTimeoutMs) {
    const generation = this.generation + 1;
    this.generation = generation;
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.addEventListener(
      "message",
      event => this.handleMessage(generation, socket, event),
    );
    socket.addEventListener("close", () => {
      this.failGeneration(generation, transportError(
        "DevToolsConnectionClosedError",
        "Chrome DevTools connection closed",
      ));
    });
    socket.addEventListener("error", event => {
      this.failGeneration(generation, transportError(
        "DevToolsConnectionClosedError",
        "Chrome DevTools connection failed",
        null,
        event,
      ));
      socket.close();
    });
    const opening = new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) this.cancelTimer(timer);
        callback(value);
      };
      timer = this.scheduleTimer(() => {
        const error = transportError(
          "DevToolsRequestTimeoutError",
          `Chrome DevTools connection timed out after ${timeoutMs}ms`,
          "WebSocket.connect",
        );
        finish(reject, error);
        if (this.generation === generation && this.socket === socket) {
          this.socket = null;
        }
        socket.close();
      }, timeoutMs);
      socket.addEventListener("open", () => finish(resolve), { once: true });
      socket.addEventListener("error", event => finish(
        reject,
        transportError(
          "DevToolsConnectionClosedError",
          "Chrome DevTools connection failed before opening",
          "WebSocket.connect",
          event,
        ),
      ), { once: true });
      socket.addEventListener("close", () => finish(
        reject,
        transportError(
          "DevToolsConnectionClosedError",
          "Chrome DevTools connection closed before opening",
          "WebSocket.connect",
        ),
      ), { once: true });
    });
    try {
      await opening;
    } catch (error) {
      if (this.generation === generation && this.socket === socket) {
        this.socket = null;
      }
      socket.close();
      throw error;
    }
  }

  async connect() {
    await this.openSocket();
  }

  send(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const socket = this.socket;
    const generation = this.generation;
    if (socket === null || socket.readyState !== 1) {
      return Promise.reject(transportError(
        "DevToolsConnectionClosedError",
        `Chrome DevTools connection is not open for ${method}`,
        method,
      ));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = this.scheduleTimer(() => this.settle(
        id,
        generation,
        transportError(
          "DevToolsRequestTimeoutError",
          `${method} timed out after ${timeoutMs}ms`,
          method,
        ),
        null,
      ), timeoutMs);
      this.pending.set(id, {
        generation,
        method,
        reject,
        resolve,
        timer,
      });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (cause) {
        this.settle(id, generation, transportError(
          "DevToolsConnectionClosedError",
          `Chrome DevTools could not send ${method}`,
          method,
          cause,
        ), null);
      }
    });
  }

  async evaluate(expression, timeoutMs = this.requestTimeoutMs) {
    const response = await this.send("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
    }, timeoutMs);
    if (response.exceptionDetails !== undefined) {
      throw new Error(`Runtime.evaluate failed: ${JSON.stringify(response.exceptionDetails)}`);
    }
    return response.result?.value;
  }

  async reconnect({ deadline = Number.POSITIVE_INFINITY, now = Date.now } = {}) {
    const oldSocket = this.socket;
    this.socket = null;
    oldSocket?.close();
    try {
      await this.openSocket(boundedTimeoutBefore(
        deadline,
        now,
        this.requestTimeoutMs,
        "WebSocket.connect",
      ));
      await this.send("Runtime.enable", {}, boundedTimeoutBefore(
        deadline,
        now,
        this.requestTimeoutMs,
        "Runtime.enable",
      ));
      await this.send("Page.enable", {}, boundedTimeoutBefore(
        deadline,
        now,
        this.requestTimeoutMs,
        "Page.enable",
      ));
    } catch (error) {
      const failedSocket = this.socket;
      this.socket = null;
      failedSocket?.close();
      throw error;
    }
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}

export async function observeHeadlessPage(
  session,
  {
    deadline,
    includeFrameTree,
  },
  {
    delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    now = Date.now,
    pageState,
  },
) {
  while (true) {
    try {
      const state = await pageState(session);
      let frameLoaderId = null;
      if (includeFrameTree) {
        const frameTree = await session.send("Page.getFrameTree");
        frameLoaderId = frameTree.frameTree?.frame?.loaderId ?? null;
      }
      return { frameLoaderId, state };
    } catch (error) {
      if (!isTransientDevToolsError(error)) throw error;
      let recoveryError = error;
      while (now() < deadline) {
        try {
          await session.reconnect({ deadline, now });
          recoveryError = null;
          break;
        } catch (reconnectError) {
          if (!isTransientDevToolsError(reconnectError)) throw reconnectError;
          recoveryError = reconnectError;
          const remaining = Math.max(0, deadline - now());
          if (remaining > 0) await delay(Math.min(25, remaining));
        }
      }
      if (recoveryError === null && now() >= deadline) {
        recoveryError = transportError(
          "DevToolsRequestTimeoutError",
          "headless observation deadline expired after reconnect",
          "observeHeadlessPage",
        );
      }
      if (recoveryError !== null) throw recoveryError;
    }
  }
}
