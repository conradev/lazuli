// SPDX-License-Identifier: GPL-3.0-only

const CHECKPOINT_SCHEMA = "lazuli-resident-renderer-fidelity-checkpoint-v1";
const ACK_SCHEMA = "lazuli-resident-renderer-fidelity-checkpoint-ack-v1";
const CHECKPOINT_ENDPOINT = "/resident-fidelity/checkpoints";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function validatePayload(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("checkpoint payload must be an object");
  }
  if (payload.schema !== CHECKPOINT_SCHEMA) {
    throw new Error(`checkpoint payload schema must be ${CHECKPOINT_SCHEMA}`);
  }
  positiveInteger(payload.clientSequence, "checkpoint client sequence");
  return payload;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function validateAck(ack, payload) {
  if (ack === null || typeof ack !== "object" || Array.isArray(ack)) {
    throw new Error("checkpoint acknowledgement was not an object");
  }
  if (ack.schema !== ACK_SCHEMA || ack.durable !== true) {
    throw new Error("checkpoint acknowledgement was not durable");
  }
  for (const field of ["runId", "gameKey", "clientSequence"]) {
    if (ack[field] !== payload[field]) {
      throw new Error(`checkpoint acknowledgement changed ${field}`);
    }
  }
  positiveInteger(ack.serverSequence, "checkpoint server sequence");
  for (const field of ["payloadSha256", "recordSha256"]) {
    if (typeof ack[field] !== "string" || !SHA256_PATTERN.test(ack[field])) {
      throw new Error(`checkpoint acknowledgement ${field} was not SHA-256`);
    }
  }
  if (
    typeof ack.evidenceLockSha256 !== "string"
    || !SHA256_PATTERN.test(ack.evidenceLockSha256)
  ) {
    throw new Error("checkpoint acknowledgement evidence lock was not SHA-256");
  }
  if (
    ack.previousRecordSha256 !== null
    && (typeof ack.previousRecordSha256 !== "string"
      || !SHA256_PATTERN.test(ack.previousRecordSha256))
  ) {
    throw new Error("checkpoint acknowledgement previous record hash was invalid");
  }
  return ack;
}

async function appendCheckpoint(message) {
  const requestId = positiveInteger(message.requestId, "checkpoint request id");
  const timeoutMs = positiveInteger(message.timeoutMs, "checkpoint timeout");
  if (timeoutMs > 60_000) throw new Error("checkpoint timeout exceeds 60000 ms");
  const deadlineUnixMs = positiveInteger(message.deadlineUnixMs, "checkpoint deadline");
  const remainingMs = Math.min(timeoutMs, Math.floor(deadlineUnixMs - Date.now()));
  if (remainingMs <= 0) throw new Error("checkpoint end-to-end acknowledgement deadline elapsed");
  const payload = validatePayload(message.payload);
  const expectedPayloadSha256 = await sha256(canonicalJson(payload));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  try {
    const response = await fetch(CHECKPOINT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`checkpoint endpoint returned HTTP ${response.status}`);
    }
    const ack = validateAck(await response.json(), payload);
    if (ack.payloadSha256 !== expectedPayloadSha256) {
      throw new Error("checkpoint acknowledgement did not authenticate its payload");
    }
    globalThis.postMessage({
      type: "resident-fidelity-checkpoint-ack",
      requestId,
      ack,
    });
  } finally {
    clearTimeout(timer);
  }
}

let commandTail = Promise.resolve();

globalThis.addEventListener("message", event => {
  const message = event.data ?? {};
  if (message.type !== "resident-fidelity-checkpoint-append") return;
  commandTail = commandTail.then(async () => {
    try {
      await appendCheckpoint(message);
    } catch (error) {
      globalThis.postMessage({
        type: "resident-fidelity-checkpoint-error",
        requestId: message.requestId ?? null,
        error: String(error?.stack ?? error),
      });
    }
  });
});
