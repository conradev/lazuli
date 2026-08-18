// SPDX-License-Identifier: GPL-3.0-only

import {
  ResidentMachineAdapter,
  openRawHttpContainer,
} from "/web/resident-machine.mjs";

function ownedBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error("render request was not bytes");
}

class RendererRelay {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
  }

  submit_resident_render(sourceValue, requestFlags, sequenceLo, sequenceHi) {
    const id = this.nextId++;
    const source = ownedBytes(sourceValue);
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    postMessage({
      type: "resident-pc-probe-render-request",
      id,
      source,
      requestFlags,
      sequenceLo,
      sequenceHi,
    }, [source.buffer]);
    return promise;
  }

  settle(message) {
    const pending = this.pending.get(message.id);
    if (!pending) throw new Error(`unknown renderer request ${String(message.id)}`);
    this.pending.delete(message.id);
    if (message.type === "resident-pc-probe-render-receipt") {
      pending.resolve(ownedBytes(message.receipt));
    } else {
      pending.reject(new Error(String(message.error ?? "renderer failed")));
    }
  }
}

function readPc(adapter) {
  const pointer = adapter.core.core_cpu_ptr() >>> 0;
  const pc = new DataView(adapter.memory.buffer).getUint32(pointer, true);
  return `0x${pc.toString(16).padStart(8, "0")}`;
}

async function advance(adapter, targetInstructions) {
  let cycles = 0n;
  let instructions = 0n;
  let boundaries = 0;
  let coldInstalls = 0;
  let hostCalls = 0;
  const details = Object.create(null);
  while (instructions < targetInstructions) {
    const result = await adapter.runSlice({
      cycleUpperCap: 1_000_000n,
      blockUpperCap: 16_384,
      maxHostCalls: 65_535,
      maxColdInstalls: 65_535,
    });
    if (result.boundary !== "rust") {
      throw new Error(`PC probe reached unobservable partial boundary ${result.boundary}`);
    }
    if (result.outcome.reason !== 0) {
      throw new Error(
        `PC probe stopped with reason ${result.outcome.reason}, detail ${result.outcome.detail}`,
      );
    }
    boundaries += 1;
    cycles += result.outcome.executedCycles;
    instructions += result.outcome.executedInstructions;
    coldInstalls += result.coldInstalls;
    hostCalls += result.hostCalls;
    const detail = String(result.outcome.detail);
    details[detail] = (details[detail] ?? 0) + 1;
  }
  return {
    targetInstructions: targetInstructions.toString(),
    executedInstructions: instructions.toString(),
    instructionOvershoot: (instructions - targetInstructions).toString(),
    executedCycles: cycles.toString(),
    boundaries,
    coldInstalls,
    hostCalls,
    details,
  };
}

const renderer = new RendererRelay();
addEventListener("message", event => {
  const message = event.data ?? {};
  if (message.type === "resident-pc-probe-render-receipt" ||
      message.type === "resident-pc-probe-render-error") {
    renderer.settle(message);
    return;
  }
  if (message.type !== "resident-pc-probe-start") return;
  Promise.resolve().then(async () => {
    const adapter = await ResidentMachineAdapter.create({
      artifacts: message.artifacts,
      rawContainer: await openRawHttpContainer(message.discUrl, { baseUrl: location.href }),
      renderer,
    });
    try {
      const boot = await adapter.boot();
      const warmup = await advance(adapter, BigInt(message.warmupInstructions));
      const startPc = readPc(adapter);
      const measurement = await advance(adapter, BigInt(message.measureInstructions));
      const endPc = readPc(adapter);
      postMessage({
        type: "resident-pc-probe-report",
        report: {
          status: "complete",
          schema: "lazuli-resident-pc-probe-v1",
          purpose: "dev-only workload diagnostics; PC never feeds execution policy",
          boot,
          warmup,
          measurement,
          startPc,
          endPc,
          diagnostics: adapter.diagnostics(),
        },
      });
    } finally {
      adapter.close();
    }
  }).catch(error => postMessage({
    type: "resident-pc-probe-error",
    error: String(error?.stack ?? error),
  }));
});
