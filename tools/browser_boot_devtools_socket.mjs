// SPDX-License-Identifier: GPL-3.0-only

// Node's built-in WebSocket exposes dispatcher injection but no public accessor
// for the dispatcher that fetch initialized before the DevTools target lookup.
const UNDICI_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

function withoutWebSocketCompression(headers) {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("Node WebSocket exposed an unsupported handshake header shape");
  }
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== "sec-websocket-extensions",
    ),
  );
}

export function createUncompressedDevToolsSocket(targetUrl, {
  dispatcher = globalThis[UNDICI_GLOBAL_DISPATCHER],
  WebSocketConstructor = globalThis.WebSocket,
} = {}) {
  if (dispatcher === null || typeof dispatcher?.dispatch !== "function") {
    throw new Error(
      "Node's Undici dispatcher is unavailable; fetch the DevTools target list first",
    );
  }
  if (typeof WebSocketConstructor !== "function") {
    throw new Error("Node's WebSocket implementation is unavailable");
  }
  // Node 24's permessage-deflate inflater can wedge after a large CDP result.
  // Refuse the extension at dispatch time so Chrome sends plain text frames.
  const uncompressedDispatcher = {
    dispatch(options, handler) {
      return dispatcher.dispatch({
        ...options,
        headers: withoutWebSocketCompression(options.headers),
      }, handler);
    },
  };
  return new WebSocketConstructor(targetUrl, {
    dispatcher: uncompressedDispatcher,
  });
}
