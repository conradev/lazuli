// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const frontendUrl = new URL(
  "../crates/ppcwasmjit/examples/browser_resident_frontend.mjs",
  import.meta.url,
);
const generatorUrl = new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
);
const [source, generator] = await Promise.all([
  readFile(frontendUrl, "utf8"),
  readFile(generatorUrl, "utf8"),
]);

function generatedResidentHtmlFixture() {
  const templateStartMarker = 'const TEMPLATE: &str = r##"';
  const templateStart = generator.indexOf(templateStartMarker);
  const templateEnd = generator.lastIndexOf('"##;');
  assert.notEqual(templateStart, -1, "browser shell template start is missing");
  assert.ok(templateEnd > templateStart, "browser shell template end is missing");
  const template = generator.slice(templateStart + templateStartMarker.length, templateEnd);
  const runnerStart = template.indexOf('  <script id="runner-source" type="text/plain">');
  const bodyEnd = template.indexOf("</body>");
  assert.ok(runnerStart >= 0 && bodyEnd > runnerStart, "resident splice boundaries changed");
  return `${template.slice(0, runnerStart)}  <script type="module">\n${source}\n  </script>\n${template.slice(bodyEnd)}`;
}

class TestMessageChannel {
  constructor() {
    let listener = null;
    this.port1 = {
      addEventListener(type, callback) {
        assert.equal(type, "message");
        listener = callback;
      },
      start() {},
    };
    this.port2 = {
      postMessage(data) {
        setImmediate(() => listener?.({ data }));
      },
    };
  }
}

const HASH = "a".repeat(64);
const runtime = {
  choice: "rust-resident-v1",
  abi: {
    coreVersion: 1,
    compileRequestBytes: 84,
    hostRequestBytes: 52,
    runOutcomeBytes: 40,
    machineEvidenceBytes: 816,
    gameFidelityBytes: 384,
    memoryInitialPages: 720,
    memoryMaximumPages: 2048,
  },
  core: { url: `/assets/core-${HASH}.wasm`, sha256: HASH, bytes: 1 },
  dispatcher: { url: `/assets/dispatcher-${HASH}.wasm`, sha256: HASH, bytes: 1 },
  coordinator: { url: `/assets/coordinator-${HASH}.wasm`, sha256: HASH, bytes: 1 },
  adapter: { url: `/assets/adapter-${HASH}.mjs`, sha256: HASH, bytes: 1 },
  worker: { url: `/assets/worker-${HASH}.mjs`, sha256: HASH, bytes: 1 },
};

function testContext() {
  const main = source.indexOf("async function main() {");
  assert.notEqual(main, -1, "resident frontend main boundary is missing");
  const executable = source
    .slice(0, main)
    .replace(
      'import initBrowserRenderer, { WebGpuRenderer } from "/browser_renderer.js";',
      "",
    )
    .replace("__LAZULI_RESIDENT_RELEASE_RUNTIME__", JSON.stringify(runtime));
  const context = vm.createContext({
    ArrayBuffer,
    Blob,
    DataView,
    Error,
    Map,
    Math,
    MessageChannel: TestMessageChannel,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    TypeError,
    URL,
    Uint8Array,
    clearTimeout,
    location: { href: "https://play.example/immutable.html" },
    performance,
    setTimeout,
  });
  vm.runInContext(`${executable}\n;globalThis.__test = {
    POLICY,
    ResidentFrontendManager,
    ResidentInputPublisher,
    ResidentWorkerClient,
    controllerMessage,
    decodeRetailIplImage,
    normalizeControllerState,
    readLocalIplFile,
    sampleControllerState,
    validateDiagnostics,
    validateRunResult,
    validateRuntime,
  };`, context, { filename: "browser_resident_frontend.testable.mjs" });
  return context.__test;
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("resident source consumes only the frozen resident runtime boundary", () => {
  assert.equal(source.match(/__LAZULI_RESIDENT_RELEASE_RUNTIME__/g)?.length, 1);
  assert.match(
    source,
    /import initBrowserRenderer, \{ WebGpuRenderer \} from "\/browser_renderer\.js";/,
  );
  assert.match(source, /await initBrowserRenderer\(\);\s*const renderer = await WebGpuRenderer\.create/);
  assert.doesNotMatch(source, /browser_renderer_bg\.wasm/);
  for (const field of ["worker", "core", "dispatcher", "coordinator"]) {
    assert.match(source, new RegExp(`residentReleaseRuntime\\.${field}\\.url`));
  }
  assert.match(source, /const defaultDiscSourceConfig = false[\s\S]*\? \{ kind: "boot-assets" \}/);
  assert.doesNotMatch(
    source,
    /\/ppcwasmjit\.wasm|\/browser_dsp\.wasm|id="runner-source"|\btable\s*\.\s*set\s*\(|openDiscSource|core_cpu_ptr|core_fastmem_ptr/,
  );
  assert.equal(source.match(/\.arrayBuffer\(\)/g)?.length, 1, "only IPL may be materialized by the page");
  assert.match(source, /file\.arrayBuffer\(\)/);
  assert.doesNotMatch(source, /disc[^\n]*\.arrayBuffer\(\)/i);
  assert.equal(source.match(/has_presented_xfb\(\)/g)?.length, 1);
  assert.match(source, /const hasPresentedXfb = this\.renderer\.has_presented_xfb\(\)/);
  assert.match(source, /renderer: \{\s*hasPresentedXfb,/);
  assert.doesNotMatch(source, /read_presented_xfb_rgba|submit_gx_frame/);
  assert.doesNotMatch(source, /\b(?:DOL|PPC|MMIO|GX|XFB)\b|\b(?:device|scheduler|opcode)\b/i);
});

test("resident generator mode splices the legacy machine out without changing its path", () => {
  assert.match(generator, /include_str!\("browser_resident_frontend\.mjs"\)/);
  assert.match(
    generator,
    /compiler_argument\.as_deref\(\) == Some\(std::ffi::OsStr::new\("--resident-release"\)\)/,
  );
  assert.match(generator, /write_resident_frontend\(&output\);/);
  assert.match(generator, /const LEGACY_RUNNER_START: &str/);
  assert.match(generator, /let compiler_path = compiler_argument[\s\S]*ppcwasmjit\.wasm/);
  assert.match(generator, /!html\.contains\("\/ppcwasmjit\.wasm"\)/);
  assert.match(generator, /!html\.contains\("\/browser_dsp\.wasm"\)/);
});

test("generated resident HTML retains the release shell and exactly one resident script", () => {
  const html = generatedResidentHtmlFixture();
  assert.equal(html.match(/<script\b/g)?.length, 1);
  assert.match(html, /<canvas id="display"/);
  assert.match(html, /<input id="disc-file"/);
  assert.match(html, /<input id="ipl-file"/);
  assert.match(html, /rel="source noopener">Source<\/a>/);
  assert.match(html, /import initBrowserRenderer, \{ WebGpuRenderer \} from "\/browser_renderer\.js";/);
  assert.doesNotMatch(
    html,
    /id="runner-source"|\/ppcwasmjit\.wasm|\/browser_dsp\.wasm|browser_renderer_bg\.wasm|URL\.createObjectURL|compileBlock/,
  );
});

test("runtime validation is exact and fail closed", () => {
  const { validateRuntime } = testContext();
  assert.equal(validateRuntime(structuredClone(runtime)).choice, "rust-resident-v1");
  const extra = structuredClone(runtime);
  extra.machine = {};
  assert.throws(() => validateRuntime(extra), /runtime shape changed/);
  const wrongAbi = structuredClone(runtime);
  wrongAbi.abi.gameFidelityBytes = 0;
  assert.throws(() => validateRuntime(wrongAbi), /gameFidelityBytes changed/);
  const mutableAsset = structuredClone(runtime);
  mutableAsset.worker.url = "/resident-machine-worker.mjs";
  assert.throws(() => validateRuntime(mutableAsset), /worker URL is invalid/);
  const unhashedAsset = structuredClone(runtime);
  unhashedAsset.worker.url = "/assets/resident-machine-worker.mjs";
  assert.throws(() => validateRuntime(unhashedAsset), /not content-addressed/);
});

test("diagnostics preserve exact opaque 816-byte evidence and counter shapes", () => {
  const { validateDiagnostics } = testContext();
  const diagnostics = {
    booted: true,
    memoryPages: 720,
    totalBootReads: 7,
    totalDiReads: 8,
    totalRenderCalls: 9,
    totalColdInstalls: 10,
    pendingControllerSample: false,
    totalControllerRetries: 11,
    tableSlots: 65_536,
    machineEvidence: {
      available: true,
      bytes: 816,
      encoding: "base64",
      payload: "A".repeat(1_088),
    },
  };
  assert.equal(validateDiagnostics(structuredClone(diagnostics)).totalRenderCalls, 9);
  const extra = structuredClone(diagnostics);
  extra.pc = 0x8000_0000;
  assert.throws(() => validateDiagnostics(extra), /diagnostics shape changed/);
  const wrongEvidence = structuredClone(diagnostics);
  wrongEvidence.machineEvidence.bytes = 792;
  assert.throws(() => validateDiagnostics(wrongEvidence), /byte length changed/);
});

test("controller publication uses exact u64 sequence and little-endian byte lanes", () => {
  const { controllerMessage } = testContext();
  const published = controllerMessage({
    buttons: 0x1101,
    stickX: 0x11,
    stickY: 0x22,
    cStickX: 0x33,
    cStickY: 0x44,
    triggerL: 0x55,
    triggerR: 0x66,
    analogA: 0x77,
    analogB: 0x88,
  }, 0x0000_0001_0000_0002n);
  assert.equal(published.message.sequenceLo, 2);
  assert.equal(published.message.sequenceHi, 1);
  assert.equal(published.message.buttons, 0x1101);
  assert.equal(published.message.stickXyCxy, 0x4433_2211);
  assert.equal(published.message.triggerLrab, 0x8877_6655);
  assert.throws(() => controllerMessage({
    ...published.state,
    buttons: 0x8000_0000,
  }, 2n), /reserved bits/);
  assert.throws(() => controllerMessage(published.state, 0n), /sequence is invalid/);
});

test("a physical Gamepad D-pad direction drives both buttons and the digital stick", () => {
  const { sampleControllerState } = testContext();
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
  buttons[14] = { pressed: true, value: 1 };
  const state = sampleControllerState({
    axes: [0, 0, 0, 0],
    buttons,
    connected: true,
  }, 0);
  assert.deepEqual([state.buttons, state.stickX, state.stickY], [0x0001, 0x01, 0x80]);
});

test("a retained rejected controller sample is never resent or replaced", async () => {
  const { ResidentInputPublisher } = testContext();
  const requests = [];
  const statuses = [0, 1];
  const client = {
    request(message) {
      requests.push(structuredClone(message));
      return Promise.resolve({ status: statuses.shift() });
    },
  };
  const failures = [];
  const publisher = new ResidentInputPublisher(() => client, error => failures.push(error));
  const neutral = {
    buttons: 0,
    stickX: 0x80,
    stickY: 0x80,
    cStickX: 0x80,
    cStickY: 0x80,
    triggerL: 0,
    triggerR: 0,
    analogA: 0,
    analogB: 0,
  };
  publisher.update({ ...neutral, buttons: 0x0100, analogA: 0xff });
  await settle();
  publisher.update(neutral);
  await settle();
  assert.equal(requests.length, 1, "newer neutral state replaced a retained press");
  publisher.observeDiagnostics({ pendingControllerSample: true });
  await settle();
  assert.equal(requests.length, 1);
  publisher.observeDiagnostics({ pendingControllerSample: false });
  await settle();
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map(message => [message.sequenceLo, message.buttons]),
    [[1, 0x0100], [2, 0]],
  );
  assert.deepEqual(failures, []);
});

test("run results accept only actual adapter boundaries and canonical decimals", () => {
  const { POLICY, validateRunResult } = testContext();
  const rust = validateRunResult({
    result: {
      boundary: "rust",
      cycleUpperCap: POLICY.cycleUpperCap,
      blockUpperCap: POLICY.blockUpperCap,
      outcome: {
        reason: 0,
        detail: 1,
        executedCycles: "1000000",
        executedInstructions: "42",
      },
      hostCalls: 7,
      coldInstalls: 8,
    },
  });
  assert.equal(rust.cycles, 1_000_000n);
  assert.equal(rust.instructions, 42n);
  assert.equal(validateRunResult({
    result: { boundary: "cold-install-cap", hostCalls: 0, coldInstalls: 64 },
  }).boundary, "cold-install-cap");
  assert.equal(validateRunResult({
    result: { boundary: "host-call-cap", hostCalls: 64, coldInstalls: 0 },
  }).boundary, "host-call-cap");
  assert.throws(() => validateRunResult({
    result: { boundary: "yield", hostCalls: 0, coldInstalls: 0 },
  }), /unknown.*boundary/);
  assert.throws(() => validateRunResult({
    result: {
      boundary: "rust",
      cycleUpperCap: POLICY.cycleUpperCap,
      blockUpperCap: POLICY.blockUpperCap,
      outcome: {
        reason: 0,
        detail: 0,
        executedCycles: "1e6",
        executedInstructions: "1",
      },
      hostCalls: 0,
      coldInstalls: 0,
    },
  }), /unsigned decimal/);
  assert.throws(() => validateRunResult({
    result: { boundary: "host-call-cap", hostCalls: 63, coldInstalls: 0 },
  }), /did not reach its cap/);
  assert.throws(() => validateRunResult({
    result: {
      boundary: "rust",
      cycleUpperCap: POLICY.cycleUpperCap,
      blockUpperCap: POLICY.blockUpperCap,
      outcome: {
        reason: 0,
        detail: 0,
        executedCycles: "0",
        executedInstructions: "1",
      },
      hostCalls: 0,
      coldInstalls: 0,
    },
  }), /positive instructions with zero cycles/);
});

test("renderer relay copies opaque bytes and returns the exact canonical receipt", async () => {
  const { ResidentWorkerClient } = testContext();
  const listeners = new Map();
  const posts = [];
  const worker = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    postMessage(message, transfer = []) { posts.push({ message, transfer }); },
    terminate() {},
  };
  const rendererCalls = [];
  const renderer = {
    submit_resident_render(bytes, flags, lo, hi) {
      rendererCalls.push({ bytes: bytes.slice(), flags, lo, hi });
      return Promise.resolve(Uint8Array.of(9, 8, 7));
    },
    check_health() {},
  };
  const failures = [];
  const client = new ResidentWorkerClient(worker, renderer, error => failures.push(error));
  const sourceBytes = Uint8Array.of(1, 2, 3);
  listeners.get("message")({ data: {
    type: "resident-render-request",
    id: 4,
    source: sourceBytes,
    requestFlags: 5,
    sequenceLo: 6,
    sequenceHi: 7,
  } });
  sourceBytes.fill(0xff);
  await settle();
  assert.deepEqual(Array.from(rendererCalls[0].bytes), [1, 2, 3]);
  assert.deepEqual(rendererCalls[0], {
    bytes: rendererCalls[0].bytes,
    flags: 5,
    lo: 6,
    hi: 7,
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].message.type, "resident-render-receipt");
  assert.deepEqual(Array.from(posts[0].message.receipt), [9, 8, 7]);
  assert.equal(posts[0].transfer.length, 1);
  assert.deepEqual(failures, []);
  client.forceClose();
});

test("renderer rejection returns an error and trips the sticky failure boundary", async () => {
  const { ResidentWorkerClient } = testContext();
  const listeners = new Map();
  const posts = [];
  const worker = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    postMessage(message) { posts.push(message); },
    terminate() {},
  };
  const failure = new Error("GPU lost");
  const failures = [];
  new ResidentWorkerClient(worker, {
    submit_resident_render() { return Promise.reject(failure); },
    check_health() {},
  }, error => failures.push(error));
  listeners.get("message")({ data: {
    type: "resident-render-request",
    id: 1,
    source: Uint8Array.of(1),
    requestFlags: 0,
    sequenceLo: 1,
    sequenceHi: 0,
  } });
  await settle();
  assert.equal(posts[0].type, "resident-render-error");
  assert.match(posts[0].error, /GPU lost/);
  assert.equal(failures[0], failure);
});

test("close settles page render work without returning into a closed Worker relay", async t => {
  for (const ordering of ["worker-first", "renderer-first"]) {
    await t.test(ordering, async () => {
      const { ResidentWorkerClient } = testContext();
      const listeners = new Map();
      const posts = [];
      const events = [];
      const submission = deferred();
      const worker = {
        addEventListener(type, listener) { listeners.set(type, listener); },
        postMessage(message) {
          posts.push(message);
          events.push(`post:${message.type}`);
        },
        terminate() { events.push("terminate"); },
      };
      const client = new ResidentWorkerClient(worker, {
        submit_resident_render() {
          events.push("submit");
          return submission.promise;
        },
        check_health() { events.push("health"); },
      }, error => assert.fail(`unexpected close failure: ${error}`));
      listeners.get("message")({ data: {
        type: "resident-render-request",
        id: 9,
        source: Uint8Array.of(1),
        requestFlags: 0,
        sequenceLo: 1,
        sequenceHi: 0,
      } });
      const closing = client.closeGracefully();
      const closeRequest = posts.find(message => message.type === "resident-close");
      assert.ok(closeRequest, "close was not sent while renderer work was pending");

      if (ordering === "worker-first") {
        listeners.get("message")({ data: {
          type: "resident-closed",
          requestId: closeRequest.requestId,
        } });
        await settle();
        assert.doesNotMatch(events.join(","), /terminate/);
        submission.resolve(Uint8Array.of(2));
      } else {
        submission.resolve(Uint8Array.of(2));
        await settle();
        assert.doesNotMatch(events.join(","), /terminate/);
        listeners.get("message")({ data: {
          type: "resident-closed",
          requestId: closeRequest.requestId,
        } });
      }

      await closing;
      assert.deepEqual(
        posts.map(message => message.type),
        ["resident-close"],
        "closing returned a late receipt into the Worker's rejected renderer relay",
      );
      assert.deepEqual(events.filter(event => event === "health" || event === "terminate"), [
        "health",
        "terminate",
      ]);
    });
  }
});

test("renderer reset order is reset, drain, health, then diagnostics reset", async () => {
  const { ResidentFrontendManager } = testContext();
  const calls = [];
  const renderer = {
    reset() { calls.push("reset"); },
    drain() { calls.push("drain"); return Promise.resolve([]); },
    check_health() { calls.push("health"); },
    reset_diagnostics() { calls.push("diagnostics"); },
  };
  const manager = new ResidentFrontendManager(renderer, {});
  await manager.resetRenderer();
  assert.deepEqual(calls, ["reset", "drain", "health", "diagnostics"]);
});

test("resident diagnostics expose only the generic first-presentation witness", async () => {
  const { ResidentFrontendManager } = testContext();
  const output = { textContent: "" };
  let presented = false;
  let presentXfbCalls = 0;
  const manager = new ResidentFrontendManager({
    diagnostics() { return { presentXfbCalls }; },
    has_presented_xfb() { return presented; },
    host_diagnostics() { return {}; },
  }, { output });

  const before = await manager.diagnostics();
  assert.deepEqual(JSON.parse(JSON.stringify(before.renderer)), {
    diagnostics: { presentXfbCalls: 0 },
    hasPresentedXfb: false,
    hostDiagnostics: {},
  });
  assert.equal(JSON.stringify(JSON.parse(output.textContent)), JSON.stringify(before));

  presented = true;
  presentXfbCalls = 1;
  const after = await manager.diagnostics();
  assert.deepEqual(JSON.parse(JSON.stringify(after.renderer)), {
    diagnostics: { presentXfbCalls: 1 },
    hasPresentedXfb: true,
    hostDiagnostics: {},
  });
  assert.equal(JSON.stringify(JSON.parse(output.textContent)), JSON.stringify(after));
});

test("resident renderer readiness is explicit on initialization and failure", () => {
  assert.match(
    source,
    /const renderer = await WebGpuRenderer\.create\(elements\.canvas\);\s*document\.body\.dataset\.renderer = "wgpu-webgpu";/,
  );
  assert.match(
    source,
    /main\(\)\.catch\(error => \{\s*document\.body\.dataset\.status = "stopped";\s*document\.body\.dataset\.renderer = "unavailable";/,
  );
});

test("retail IPL transform is isolated, exact-size, and matches the legacy vector", async () => {
  const { decodeRetailIplImage, readLocalIplFile } = testContext();
  const input = new Uint8Array(2 * 1024 * 1024);
  const decoded = decodeRetailIplImage(input);
  assert.equal(decoded.region, "NTSC");
  assert.equal(decoded.decodedBytes, 0x15ee40 - 0x100);
  assert.deepEqual(Array.from(decoded.image.subarray(0x100, 0x120)), [
    0x89, 0x7e, 0x47, 0x7f, 0xf4, 0x42, 0x3f, 0xe2,
    0xa1, 0x44, 0x32, 0xa6, 0x30, 0x13, 0xbc, 0xd1,
    0xdc, 0x12, 0xe0, 0xcc, 0xa5, 0x65, 0x36, 0x8c,
    0xdf, 0x2a, 0xba, 0x9a, 0xef, 0x28, 0x83, 0xad,
  ]);
  assert.equal(input[0x100], 0, "IPL transform mutated selected file bytes");

  let read = false;
  class ObservedBlob extends Blob {
    async arrayBuffer() {
      read = true;
      return super.arrayBuffer();
    }
  }
  await assert.rejects(
    readLocalIplFile(new ObservedBlob([new Uint8Array(input.byteLength - 1)])),
    /exactly 2 MiB/,
  );
  assert.equal(read, false, "invalid IPL was read before exact-size rejection");
});
