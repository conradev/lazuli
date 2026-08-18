// SPDX-License-Identifier: GPL-3.0-only

import initRenderer, {
  WebGpuRenderer,
} from "/resident-artifacts/browser_renderer.js";

const output = document.querySelector("#result");
const parameters = new URL(location.href).searchParams;

function positiveIntegerString(name, fallback) {
  const raw = parameters.get(name) ?? fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  return raw;
}

function publish(value) {
  globalThis.__residentPcProbe = value;
  output.textContent = JSON.stringify(value, null, 2);
}

function ownedBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error("renderer receipt was not bytes");
}

async function main() {
  publish({ status: "initializing", schema: "lazuli-resident-pc-probe-v1" });
  const [manifest] = await Promise.all([
    fetch("/resident-artifacts/manifest.json", { cache: "no-store" }).then(response => {
      if (!response.ok) throw new Error(`artifact manifest returned HTTP ${response.status}`);
      return response.json();
    }),
    initRenderer("/resident-artifacts/browser_renderer_bg.wasm"),
  ]);
  const renderer = await WebGpuRenderer.create(document.querySelector("#display"));
  const worker = new Worker("/tools/resident_machine_perf_pc_probe_worker.mjs", {
    type: "module",
  });
  let renderCalls = 0;
  let renderFailures = 0;
  const report = await new Promise((resolve, reject) => {
    worker.addEventListener("error", event => reject(new Error(event.message)));
    worker.addEventListener("message", event => {
      const message = event.data ?? {};
      if (message.type === "resident-pc-probe-report") {
        resolve(message.report);
        return;
      }
      if (message.type === "resident-pc-probe-error") {
        reject(new Error(message.error));
        return;
      }
      if (message.type !== "resident-pc-probe-render-request") return;
      renderCalls += 1;
      Promise.resolve(renderer.submit_resident_render(
        message.source,
        message.requestFlags,
        message.sequenceLo,
        message.sequenceHi,
      )).then(receiptValue => {
        const receipt = ownedBytes(receiptValue);
        worker.postMessage({
          type: "resident-pc-probe-render-receipt",
          id: message.id,
          receipt,
        }, [receipt.buffer]);
      }, error => {
        renderFailures += 1;
        worker.postMessage({
          type: "resident-pc-probe-render-error",
          id: message.id,
          error: String(error?.stack ?? error),
        });
      });
    });
    worker.postMessage({
      type: "resident-pc-probe-start",
      artifacts: {
        core: "/resident-artifacts/browser_machine.wasm",
        dispatcher: "/resident-artifacts/resident_dispatcher.wasm",
        coordinator: "/resident-artifacts/core_run_coordinator.wasm",
      },
      discUrl: "/disc",
      warmupInstructions: positiveIntegerString("warmupInstructions", "8536728"),
      measureInstructions: positiveIntegerString("measureInstructions", "1011549"),
    });
  });
  worker.terminate();
  publish({
    ...report,
    artifacts: manifest,
    renderer: {
      calls: renderCalls,
      failures: renderFailures,
      diagnostics: renderer.diagnostics(),
    },
  });
}

main().catch(error => publish({
  status: "failed",
  schema: "lazuli-resident-pc-probe-v1",
  error: String(error?.stack ?? error),
}));
