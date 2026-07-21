// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  createUncompressedDevToolsSocket,
} from "./browser_boot_devtools_socket.mjs";

test("DevTools sockets strip only the permessage-deflate handshake offer", () => {
  const originalHeaders = {
    accept: "*/*",
    "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
    "sec-websocket-key": "exact-key",
    "x-lazuli-probe": "preserved",
  };
  const handler = { response: "handler" };
  const delegated = { response: "delegated" };
  const calls = [];
  const dispatcher = {
    dispatch(options, value) {
      calls.push({ options, value });
      return delegated;
    },
  };
  class FakeWebSocket {
    constructor(url, options) {
      this.url = url;
      this.result = options.dispatcher.dispatch({
        headers: originalHeaders,
        origin: "http://127.0.0.1:9222",
      }, handler);
    }
  }

  const socket = createUncompressedDevToolsSocket(
    "ws://127.0.0.1:9222/devtools/page/exact-target",
    { dispatcher, WebSocketConstructor: FakeWebSocket },
  );

  assert.equal(socket.url, "ws://127.0.0.1:9222/devtools/page/exact-target");
  assert.strictEqual(socket.result, delegated);
  assert.strictEqual(calls[0].value, handler);
  assert.deepEqual(calls[0].options, {
    headers: {
      accept: "*/*",
      "sec-websocket-key": "exact-key",
      "x-lazuli-probe": "preserved",
    },
    origin: "http://127.0.0.1:9222",
  });
  assert.equal(
    originalHeaders["Sec-WebSocket-Extensions"],
    "permessage-deflate; client_max_window_bits",
  );
});

test("DevTools sockets fail closed without Node's dispatcher", () => {
  assert.throws(
    () => createUncompressedDevToolsSocket("ws://target", {
      dispatcher: null,
      WebSocketConstructor: class {},
    }),
    /Undici dispatcher is unavailable/,
  );
});

test("DevTools sockets fail closed without Node's WebSocket", () => {
  assert.throws(
    () => createUncompressedDevToolsSocket("ws://target", {
      dispatcher: { dispatch() {} },
      WebSocketConstructor: null,
    }),
    /WebSocket implementation is unavailable/,
  );
});
