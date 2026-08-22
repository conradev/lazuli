// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  RESIDENT_BLOCK_ABSOLUTE_MAX,
  RESIDENT_BLOCK_UPPER_CAP,
  RESIDENT_CYCLE_ABSOLUTE_MAX,
  RESIDENT_CYCLE_UPPER_CAP,
  ResidentMachineAdapter,
  openRawHttpContainer,
  relayResidentRender,
} from "../web/resident-machine.mjs";

const [corePath, dispatcherPath, coordinatorPath] = process.argv.slice(2);
if (!corePath || !dispatcherPath || !coordinatorPath) {
  process.stderr.write(
    "usage: resident_machine_adapter_contract.mjs " +
      "<browser_machine.wasm> <resident_dispatcher.wasm> <core_run_coordinator.wasm>\n",
  );
  process.exit(2);
}

function writeBe32(bytes, offset, value) {
  new DataView(bytes.buffer).setUint32(offset, value >>> 0, false);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeBootableIso() {
  const gameCubeMagic = 0xc233_9f3d;
  const bootOffset = 0x3000;
  const fstOffset = 0xf000;
  const textOffset = 0x100;
  const textTarget = 0x8001_0000;
  const image = new Uint8Array(0x1_0000);
  image.set(new TextEncoder().encode("RZLE01\0\x02\0\x20"), 0);
  image.set(new TextEncoder().encode("Rust Resident Adapter Contract\0"), 0x20);
  writeBe32(image, 0x1c, gameCubeMagic);
  writeBe32(image, 0x420, bootOffset);
  writeBe32(image, 0x424, fstOffset);
  writeBe32(image, 0x428, 13);
  writeBe32(image, 0x42c, 13);
  image.fill(0x41, 0x440, 0x600);
  image.fill(0x82, 0x800, 0xa00);
  image.fill(0xc3, 0xc00, 0xe00);

  // One real resident PPC block: addi r3,r3,1; branch at the second instruction to itself.
  writeBe32(image, bootOffset + 0x00, textOffset);
  writeBe32(image, bootOffset + 0x48, textTarget);
  writeBe32(image, bootOffset + 0x90, 8);
  writeBe32(image, bootOffset + 0xe0, textTarget);
  writeBe32(image, bootOffset + textOffset, 0x3863_0001);
  writeBe32(image, bootOffset + textOffset + 4, 0x4800_0000);
  image.set([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0], fstOffset);
  return image;
}

function putHostRequest(memory, pointer, record) {
  const view = new DataView(memory.buffer);
  record.forEach((value, index) => view.setUint32(pointer + index * 4, value >>> 0, true));
}

async function verifyRunCapClamping() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  const outcomePointer = 0x1000;
  putHostRequest(memory, outcomePointer, [1, 40, 0, 1, 0, 0, 0, 0, 0, 0]);
  const coordinatorCalls = [];
  const adapter = new ResidentMachineAdapter({
    memory,
    core: {
      core_abi_version() { return 1; },
      core_di_pending_count() { return 0; },
    },
    dispatcher: { blocks: { length: 1 } },
    coordinator: {
      core_run(cycleUpperCap, blockUpperCap) {
        coordinatorCalls.push([cycleUpperCap, blockUpperCap]);
        return outcomePointer;
      },
    },
    renderer: null,
    rawContainer: {
      byteLength: 1n,
      async read() { throw new Error("cap-clamp fixture unexpectedly read the disc"); },
    },
  });
  adapter.booted = true;

  await adapter.runSlice();
  await adapter.runSlice({
    cycleUpperCap: RESIDENT_CYCLE_ABSOLUTE_MAX,
    blockUpperCap: RESIDENT_BLOCK_ABSOLUTE_MAX,
  });
  await adapter.runSlice({
    cycleUpperCap: RESIDENT_CYCLE_ABSOLUTE_MAX + 1n,
    blockUpperCap: RESIDENT_BLOCK_ABSOLUTE_MAX + 1,
  });

  assert.deepEqual(coordinatorCalls, [
    [RESIDENT_CYCLE_UPPER_CAP, RESIDENT_BLOCK_UPPER_CAP],
    [RESIDENT_CYCLE_ABSOLUTE_MAX, RESIDENT_BLOCK_ABSOLUTE_MAX],
    [RESIDENT_CYCLE_ABSOLUTE_MAX, RESIDENT_BLOCK_ABSOLUTE_MAX],
  ]);
  return {
    defaults: {
      cycleUpperCap: RESIDENT_CYCLE_UPPER_CAP.toString(),
      blockUpperCap: RESIDENT_BLOCK_UPPER_CAP,
    },
    absoluteMaxima: {
      cycleUpperCap: RESIDENT_CYCLE_ABSOLUTE_MAX.toString(),
      blockUpperCap: RESIDENT_BLOCK_ABSOLUTE_MAX,
    },
    aboveMaximumClamped: true,
  };
}

async function verifyRendererPointerReacquisition() {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4 });
  const firstRequestPointer = 0x1000;
  const movedRequestPointer = 0x1100;
  const sourcePointer = 0x2000;
  const receiptPointer = 0x3000;
  const source = Uint8Array.from([0x4c, 0x5a, 0x47, 0x58]);
  new Uint8Array(memory.buffer, sourcePointer, source.length).set(source);
  const request = [
    1,
    52,
    7,
    0x1122_3344,
    0x5566_7788,
    1,
    1,
    sourcePointer,
    source.length,
    receiptPointer,
    96,
    0xaabb_ccdd,
    0x0102_0304,
  ];
  putHostRequest(memory, firstRequestPointer, request);
  let currentPointer = firstRequestPointer;
  let pending = 1;
  let rendererCalls = 0;
  let acceptanceObserverCalls = 0;
  let detachedAfterRendererAwait = false;
  const receipt = Uint8Array.from({ length: 80 }, (_unused, index) => (index * 17) & 0xff);
  const core = {
    core_render_pending_count() {
      return pending;
    },
    core_render_request_ptr() {
      return currentPointer;
    },
    core_render_complete(...actual) {
      assert.deepEqual(actual.slice(0, 13), request);
      assert.equal(actual[13], 0);
      assert.equal(actual[14], receipt.length);
      assert.deepEqual(
        new Uint8Array(memory.buffer, receiptPointer, receipt.length),
        receipt,
      );
      pending = 0;
      return 1;
    },
  };
  const renderer = {
    async submit_resident_render(actualSource, flags, sequenceLo, sequenceHi) {
      rendererCalls += 1;
      assert.deepEqual(actualSource, source);
      assert.equal(flags, request[6]);
      assert.equal(sequenceLo, request[11]);
      assert.equal(sequenceHi, request[12]);
      const detached = memory.buffer;
      memory.grow(1);
      detachedAfterRendererAwait = detached.byteLength === 0;
      currentPointer = movedRequestPointer;
      putHostRequest(memory, movedRequestPointer, request);
      await Promise.resolve();
      return receipt;
    },
  };

  assert.equal(await relayResidentRender({
    core,
    memory,
    renderer,
    async onAccepted() {
      acceptanceObserverCalls += 1;
      assert.equal(pending, 0, "observer ran before Rust accepted the renderer receipt");
      assert.deepEqual(
        new Uint8Array(memory.buffer, receiptPointer, receipt.length),
        receipt,
      );
      await Promise.resolve();
    },
  }), 1);
  assert.equal(rendererCalls, 1);
  assert.equal(acceptanceObserverCalls, 1);
  assert.equal(pending, 0);
  assert.equal(detachedAfterRendererAwait, true);
  return {
    rendererCalls,
    acceptanceObserverCalls,
    detachedAfterRendererAwait,
    receiptBytes: receipt.length,
  };
}

async function verifyRendererPromiseRejection() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  const requestPointer = 0x1000;
  const sourcePointer = 0x2000;
  const receiptPointer = 0x3000;
  const source = Uint8Array.from([0x4c, 0x5a, 0x47, 0x58]);
  new Uint8Array(memory.buffer, sourcePointer, source.length).set(source);
  const request = [
    1,
    52,
    9,
    0x1234_5678,
    0x9abc_def0,
    1,
    0,
    sourcePointer,
    source.length,
    receiptPointer,
    80,
    11,
    12,
  ];
  putHostRequest(memory, requestPointer, request);
  let pending = 1;
  let completionCalls = 0;
  let acceptanceObserverCalls = 0;
  const core = {
    core_render_pending_count() {
      return pending;
    },
    core_render_request_ptr() {
      return requestPointer;
    },
    core_render_complete(...actual) {
      completionCalls += 1;
      assert.deepEqual(actual, [...request, 6, 0]);
      assert.ok(
        new Uint8Array(memory.buffer, receiptPointer, 80).every(byte => byte === 0),
        "renderer rejection fabricated or touched a receipt",
      );
      pending = 0;
      return 2;
    },
  };
  const rejection = new Error("pre-admission renderer rejection");
  await assert.rejects(
    relayResidentRender({
      core,
      memory,
      renderer: {
        async submit_resident_render(actualSource) {
          assert.deepEqual(actualSource, source);
          throw rejection;
        },
      },
      onAccepted() {
        acceptanceObserverCalls += 1;
      },
    }),
    error => error === rejection,
  );
  assert.equal(completionCalls, 1);
  assert.equal(acceptanceObserverCalls, 0);
  assert.equal(pending, 0);
  return {
    completionCalls,
    acceptanceObserverCalls,
    hostStatus: 6,
    filledLength: 0,
    rustResult: 2,
  };
}

function verifyGameFidelityTransport() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  const pointer = 0x2000;
  const record = Uint8Array.from(
    { length: 384 },
    (_unused, index) => index * 29 & 0xff,
  );
  new Uint8Array(memory.buffer, pointer, record.byteLength).set(record);
  let phase = 1;
  let buttons = 0x0100;
  let stickXyCxy = 0x8080_8080;
  let triggerLrab = 0x00ff_0000;
  let snapshotPointer = pointer;
  const adapter = new ResidentMachineAdapter({
    memory,
    core: {
      core_game_fidelity_phase: () => phase,
      core_game_fidelity_requested_buttons: () => buttons,
      core_game_fidelity_requested_stick_xy_cxy: () => stickXyCxy,
      core_game_fidelity_requested_trigger_lrab: () => triggerLrab,
      core_game_fidelity_snapshot: () => snapshotPointer,
    },
    dispatcher: null,
    coordinator: null,
    renderer: null,
    rawContainer: null,
    gameFidelityBytes: record.byteLength,
    captureFidelity: true,
  });
  const baseline = adapter.gameFidelityState();
  assert.deepEqual(baseline.requestedController, {
    buttons,
    stickXyCxy,
    triggerLrab,
  });
  assert.equal(baseline.phase, 1);
  assert.deepEqual(new Uint8Array(Buffer.from(baseline.record.payload, "base64")), record);

  phase = 6;
  buttons = 0;
  stickXyCxy = 0;
  triggerLrab = 0;
  const failed = adapter.gameFidelityState();
  assert.equal(failed.phase, 6);
  assert.equal(failed.requestedController, null);
  assert.equal(failed.record.available, true);

  snapshotPointer = 0;
  const unavailable = adapter.gameFidelityState();
  assert.deepEqual(unavailable.record, {
    available: false,
    bytes: 384,
    encoding: "base64",
    payload: null,
  });

  phase = 5;
  buttons = 1;
  assert.throws(
    () => adapter.gameFidelityState(),
    /requested controller state outside Baseline/,
  );
  return {
    baselinePhase: baseline.phase,
    failedPhase: failed.phase,
    opaqueRecordBytes: record.byteLength,
  };
}

async function verifyDiPointerReacquisition() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const stagingPointer = 0x4000;
  const descriptor = [3, 0, 5, 0, 0x20, 1, 4];
  const expectedOffset = 0x1_0000_0020n;
  const payload = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
  let pending = 1;
  let detachedAcrossRead = false;
  let completionCalls = 0;
  const core = {
    core_di_pending_count() {
      return pending;
    },
    core_di_request_epoch_lo() { return descriptor[0]; },
    core_di_request_epoch_hi() { return descriptor[1]; },
    core_di_request_id_lo() { return descriptor[2]; },
    core_di_request_id_hi() { return descriptor[3]; },
    core_di_request_container_offset_lo() { return descriptor[4]; },
    core_di_request_container_offset_hi() { return descriptor[5]; },
    core_di_request_length() { return descriptor[6]; },
    core_di_staging_ptr(...actual) {
      assert.deepEqual(actual, descriptor);
      return stagingPointer;
    },
    core_di_complete(...actual) {
      completionCalls += 1;
      assert.deepEqual(actual, [...descriptor, payload.length, 0]);
      assert.deepEqual(
        new Uint8Array(memory.buffer, stagingPointer, payload.length),
        payload,
      );
      pending = 0;
      return 2;
    },
  };
  const adapter = new ResidentMachineAdapter({
    memory,
    core,
    dispatcher: null,
    coordinator: null,
    renderer: null,
    rawContainer: {
      byteLength: expectedOffset + BigInt(payload.length),
      async read(offset, length) {
        assert.equal(offset, expectedOffset);
        assert.equal(length, payload.length);
        const stale = memory.buffer;
        memory.grow(1);
        detachedAcrossRead = stale.byteLength === 0;
        await Promise.resolve();
        return payload;
      },
    },
  });
  adapter.booted = true;
  const result = await adapter.serviceDiReads(1);
  assert.deepEqual(result, { calls: 1, pending: 0 });
  assert.equal(completionCalls, 1);
  assert.equal(detachedAcrossRead, true);
  return { completionCalls, detachedAcrossRead, physicalOffset: expectedOffset.toString() };
}

async function verifyDiPublishedDuringCoordinatorRun() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  const staleOutcomePointer = 0x1000;
  const completedOutcomePointer = 0x1100;
  const stagingPointer = 0x2000;
  const descriptor = [7, 0, 11, 0, 0x40, 0, 4];
  const payload = Uint8Array.from([0xca, 0xfe, 0xba, 0xbe]);
  // This is the exact transient Rust state after an install commits: the old CompileRequired
  // outcome remains readable, but its request pointer and authoritative host copy are consumed.
  putHostRequest(memory, staleOutcomePointer, [1, 40, 1, 2, 5, 0, 3, 0, 0, 0]);
  putHostRequest(memory, completedOutcomePointer, [1, 40, 0, 2, 9, 0, 7, 0, 0, 0]);

  let pending = 0;
  let coordinatorCalls = 0;
  let completionCalls = 0;
  let retentionProbeCalls = 0;
  let publishDiWithCompletedOutcome = false;
  const core = {
    core_abi_version() { return 1; },
    core_di_pending_count() { return pending; },
    core_di_request_epoch_lo() { return descriptor[0]; },
    core_di_request_epoch_hi() { return descriptor[1]; },
    core_di_request_id_lo() { return descriptor[2]; },
    core_di_request_id_hi() { return descriptor[3]; },
    core_di_request_container_offset_lo() { return descriptor[4]; },
    core_di_request_container_offset_hi() { return descriptor[5]; },
    core_di_request_length() { return descriptor[6]; },
    core_di_staging_ptr(...actual) {
      assert.deepEqual(actual, descriptor);
      return stagingPointer;
    },
    core_di_complete(...actual) {
      completionCalls += 1;
      assert.deepEqual(actual, [...descriptor, payload.length, 0]);
      assert.deepEqual(
        new Uint8Array(memory.buffer, stagingPointer, payload.length),
        payload,
      );
      pending = 0;
      return 1;
    },
    core_pending_compile_request_bytes() {
      retentionProbeCalls += 1;
      return 0;
    },
  };
  const adapter = new ResidentMachineAdapter({
    memory,
    core,
    dispatcher: { blocks: { length: 1 } },
    coordinator: {
      core_run() {
        coordinatorCalls += 1;
        if (coordinatorCalls === 1) {
          // Models service_due_resident_events publishing DI work before core_begin_slice can
          // replace the retained post-install outcome with a new dispatcher result.
          pending = 1;
          return staleOutcomePointer;
        }
        if (publishDiWithCompletedOutcome) {
          // Models a normal dispatched segment whose ServiceEvents path both commits exact
          // accounting and publishes the next DI request before returning EventBoundary.
          publishDiWithCompletedOutcome = false;
          pending = 1;
        }
        return completedOutcomePointer;
      },
    },
    renderer: null,
    rawContainer: {
      byteLength: 0x100n,
      async read(offset, length) {
        assert.equal(offset, 0x40n);
        assert.equal(length, payload.length);
        return payload;
      },
    },
  });
  adapter.booted = true;

  const result = await adapter.runSlice({
    cycleUpperCap: 100n,
    blockUpperCap: 10,
    maxHostCalls: 1,
    maxColdInstalls: 1,
  });
  assert.equal(result.boundary, "rust");
  assert.equal(result.outcome.reason, 0);
  assert.equal(result.hostCalls, 1);
  assert.equal(result.coldInstalls, 0);
  assert.equal(coordinatorCalls, 2);
  assert.equal(completionCalls, 1);
  assert.equal(retentionProbeCalls, 1,
    "adapter did not authenticate the consumed provisional compile request");
  assert.equal(adapter.diagnostics().totalDiReads, 1);

  publishDiWithCompletedOutcome = true;
  const accounted = await adapter.runSlice({
    cycleUpperCap: 100n,
    blockUpperCap: 10,
    maxHostCalls: 1,
    maxColdInstalls: 1,
  });
  assert.equal(accounted.boundary, "rust");
  assert.equal(accounted.outcome.reason, 0);
  assert.equal(accounted.outcome.detail, 2);
  assert.equal(accounted.outcome.executedCycles, 9n);
  assert.equal(accounted.outcome.executedInstructions, 7n);
  assert.equal(accounted.hostCalls, 0,
    "adapter serviced DI before returning completed dispatcher accounting");
  assert.equal(coordinatorCalls, 3);
  assert.equal(completionCalls, 1);
  assert.equal(retentionProbeCalls, 1,
    "adapter classified a completed EventBoundary as a provisional compile outcome");
  assert.equal(pending, 1, "completed EventBoundary did not leave DI work for the next run");
  assert.equal(adapter.diagnostics().totalDiReads, 1);
  return {
    coordinatorCalls,
    completionCalls,
    retentionProbeCalls,
    resumedReason: result.outcome.reason,
    accounted: {
      reason: accounted.outcome.reason,
      detail: accounted.outcome.detail,
      cycles: accounted.outcome.executedCycles.toString(),
      instructions: accounted.outcome.executedInstructions.toString(),
    },
  };
}

function verifyControllerRetryRetention() {
  const observed = [];
  const statuses = [0, 0, 1, 3];
  const fake = new ResidentMachineAdapter({
    memory: null,
    core: {
      core_input_publish(...sample) {
        observed.push(sample);
        return statuses.shift();
      },
    },
    dispatcher: null,
    coordinator: null,
    renderer: null,
    rawContainer: null,
  });
  const retained = [17, 0, 0x0100, 0x8080_8080, 0];
  const later = [18, 0, 0x0200, 0x8080_8080, 0];
  assert.equal(fake.publishController(...retained), 0);
  assert.equal(fake.publishController(...later), 0);
  assert.equal(observed.length, 1, "later input replaced a retained rejected sample");
  assert.equal(fake.retryControllerInput(), 0);
  assert.equal(fake.retryControllerInput(), 1);
  assert.deepEqual(observed.slice(0, 3), [retained, retained, retained]);
  assert.equal(fake.publishController(...later), 3);
  assert.deepEqual(observed[3], later);
  return {
    exactRetryCalls: 2,
    laterSampleWithheld: true,
    acceptedStatus: 1,
  };
}

function verifyMachineEvidenceTransport() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const pointer = 0x1000;
  let calls = 0;
  let detachedAcrossSnapshot = false;
  const core = {
    core_machine_evidence_snapshot() {
      calls += 1;
      if (calls === 3) return 0;
      if (calls === 1) {
        const stale = memory.buffer;
        memory.grow(1);
        detachedAcrossSnapshot = stale.byteLength === 0;
      }
      new Uint8Array(memory.buffer, pointer, 5).set(
        calls === 1 ? [1, 2, 3, 4, 5] : [2, 3, 4, 5, 6],
      );
      return pointer;
    },
  };
  const adapter = new ResidentMachineAdapter({
    memory,
    core,
    dispatcher: { blocks: { length: 0 } },
    coordinator: null,
    renderer: null,
    rawContainer: null,
    machineEvidenceBytes: 5,
  });
  const first = adapter.diagnostics().machineEvidence;
  const second = adapter.diagnostics().machineEvidence;
  const unavailable = adapter.diagnostics().machineEvidence;
  assert.deepEqual(first, {
    available: true,
    bytes: 5,
    encoding: "base64",
    payload: "AQIDBAU=",
  });
  assert.deepEqual(second, {
    available: true,
    bytes: 5,
    encoding: "base64",
    payload: "AgMEBQY=",
  });
  assert.deepEqual(unavailable, {
    available: false,
    bytes: 5,
    encoding: "base64",
    payload: null,
  });
  assert.equal(detachedAcrossSnapshot, true);
  return { calls, detachedAcrossSnapshot, unavailableFailClosed: true };
}

async function verifyStrictRawHttpRanges() {
  const source = Uint8Array.from([0x10, 0x20, 0x30, 0x40]);
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(options.headers);
    const range = options.headers.Range;
    if (range === "bytes=0-0") {
      return new Response(source.slice(0, 1), {
        status: 206,
        headers: { "Content-Range": "bytes 0-0/4", ETag: '"frozen"' },
      });
    }
    assert.equal(range, "bytes=1-2");
    assert.equal(options.headers["If-Match"], '"frozen"');
    return new Response(source.slice(1, 3), {
      status: 206,
      headers: { "Content-Range": "bytes 1-2/4", ETag: '"frozen"' },
    });
  };
  const container = await openRawHttpContainer("https://example.test/game", { fetchImpl });
  assert.equal(container.byteLength, 4n);
  assert.deepEqual(await container.read(1n, 2), source.slice(1, 3));
  return { requests: requests.length, immutableBytes: container.byteLength.toString() };
}

const [coreBytes, dispatcherBytes, coordinatorBytes, adapterSource, workerSource] =
  await Promise.all([
    readFile(corePath),
    readFile(dispatcherPath),
    readFile(coordinatorPath),
    readFile(new URL("../web/resident-machine.mjs", import.meta.url), "utf8"),
    readFile(new URL("../web/resident-machine-worker.mjs", import.meta.url), "utf8"),
  ]);

assert.doesNotMatch(adapterSource, /\bblocks\s*\.\s*set\s*\(/);
assert.doesNotMatch(workerSource, /\bblocks\s*\.\s*set\s*\(/);
assert.doesNotMatch(adapterSource, /browser_boot\.rs|openDiscSource/);
assert.doesNotMatch(workerSource, /browser_boot\.rs|openDiscSource/);

const iso = makeBootableIso();
const rawHttp = await verifyStrictRawHttpRanges();
let adapter;
let rawReads = 0;
let detachedDuringRawRead = false;
const physicalRequests = [];
const rawContainer = {
  byteLength: BigInt(iso.length),
  async read(offset, length) {
    const start = Number(offset);
    const end = start + length;
    assert.ok(Number.isSafeInteger(start) && start >= 0 && end <= iso.length);
    physicalRequests.push({ offset: offset.toString(), length });
    rawReads += 1;
    if (rawReads === 1) {
      const stale = adapter.memory.buffer;
      adapter.memory.grow(1);
      detachedDuringRawRead = stale.byteLength === 0;
    }
    await Promise.resolve();
    return iso.slice(start, end);
  },
};
const renderer = {
  calls: 0,
  async submit_resident_render() {
    this.calls += 1;
    throw new Error("boot-loop fixture unexpectedly requested rendering");
  },
};

const originalTableSet = WebAssembly.Table.prototype.set;
let javascriptTableSets = 0;
WebAssembly.Table.prototype.set = function countedTableSet(...arguments_) {
  javascriptTableSets += 1;
  return originalTableSet.apply(this, arguments_);
};

let boot;
let run;
let coordinatorCalls;
let pagesBeforeBoot;
try {
  adapter = await ResidentMachineAdapter.create({
    artifacts: {
      core: coreBytes,
      dispatcher: dispatcherBytes,
      coordinator: coordinatorBytes,
    },
    rawContainer,
    renderer,
    // Artifact bytes are already supplied, so this function must remain unreachable.
    fetchImpl() {
      throw new Error("resident adapter unexpectedly fetched a supplied Wasm artifact");
    },
  });
  const initialDiagnostics = adapter.diagnostics();
  pagesBeforeBoot = initialDiagnostics.memoryPages;
  assert.deepEqual(
    {
      available: initialDiagnostics.machineEvidence.available,
      bytes: initialDiagnostics.machineEvidence.bytes,
      encoding: initialDiagnostics.machineEvidence.encoding,
    },
    { available: true, bytes: 816, encoding: "base64" },
  );
  assert.equal(
    Buffer.from(initialDiagnostics.machineEvidence.payload, "base64").byteLength,
    816,
  );
  const repeatedEvidence = adapter.diagnostics().machineEvidence;
  assert.equal(repeatedEvidence.available, true);
  assert.notEqual(repeatedEvidence.payload, initialDiagnostics.machineEvidence.payload);
  boot = await adapter.boot({ maxReads: 64 });
  assert.equal(boot.status, 3);
  assert.ok(boot.reads > 0 && boot.reads <= 64);
  assert.equal(detachedDuringRawRead, true);
  const bootView = new DataView(adapter.memory.buffer);
  const bootState = {
    pc: bootView.getUint32(adapter.core.core_cpu_ptr(), true),
    code: bootView.getUint32(adapter.core.core_main_ram_offset() + 0x1_0000, false),
    generationLo: adapter.core.core_address_space_generation_lo(),
    generationHi: adapter.core.core_address_space_generation_hi(),
  };

  const calls = [];
  const coreRun = adapter.coordinator.core_run;
  adapter.coordinator = {
    core_run(...arguments_) {
      calls.push(arguments_);
      return coreRun(...arguments_);
    },
  };
  run = await adapter.runSlice({
    cycleUpperCap: 1_000_000n,
    blockUpperCap: 1,
    maxHostCalls: 4,
    maxColdInstalls: 2,
  });
  coordinatorCalls = calls.map(arguments_ => ({
    arity: arguments_.length,
    cycles: arguments_[0].toString(),
    blocks: arguments_[1],
  }));
  assert.ok(
    coordinatorCalls.length >= 2,
    `cold install did not resume resident dispatch: ${JSON.stringify({ coordinatorCalls, run, bootState },
      (_key, value) => typeof value === "bigint" ? value.toString() : value)}`,
  );
  assert.ok(coordinatorCalls.every(call => call.arity === 2));
  assert.equal(run.boundary, "rust");
  assert.equal(run.outcome.reason, 0);
  assert.equal(run.coldInstalls, 1);
  assert.ok(run.outcome.executedInstructions > 0n);
  assert.ok(run.outcome.executedCycles > 0n);
  assert.equal(adapter.diagnostics().totalColdInstalls, 1);
  assert.equal(renderer.calls, 0);
} finally {
  WebAssembly.Table.prototype.set = originalTableSet;
}

assert.equal(javascriptTableSets, 0, "JavaScript wrote the resident dispatch table");
const rendererRelay = await verifyRendererPointerReacquisition();
const rendererRejection = await verifyRendererPromiseRejection();
const diRelay = await verifyDiPointerReacquisition();
const diDuringCoordinator = await verifyDiPublishedDuringCoordinatorRun();
const runCapClamping = await verifyRunCapClamping();
const controllerRetry = verifyControllerRetryRetention();
const machineEvidenceTransport = verifyMachineEvidenceTransport();
const gameFidelityTransport = verifyGameFidelityTransport();
const inputStatus = adapter.publishController(1, 0, 0, 0x8080_8080, 0);
assert.ok([1, 2, 3].includes(inputStatus));

process.stdout.write(`${JSON.stringify({
  ok: true,
  artifacts: {
    core: { bytes: coreBytes.byteLength, sha256: sha256(coreBytes) },
    dispatcher: { bytes: dispatcherBytes.byteLength, sha256: sha256(dispatcherBytes) },
    coordinator: { bytes: coordinatorBytes.byteLength, sha256: sha256(coordinatorBytes) },
  },
  boot,
  rawReads,
  physicalRequests,
  rawHttp,
  detachedDuringRawRead,
  coldInstall: {
    installs: run.coldInstalls,
    residentInstructions: run.outcome.executedInstructions.toString(),
    residentCycles: run.outcome.executedCycles.toString(),
  },
  coordinatorCalls,
  publicCoordinatorArguments: ["cycleUpperCap", "blockUpperCap"],
  semanticJavascriptArguments: 0,
  javascriptTableSets,
  rendererRelay,
  rendererRejection,
  diRelay,
  diDuringCoordinator,
  runCapClamping,
  controllerRetry,
  machineEvidenceTransport,
  gameFidelityTransport,
  inputStatus,
  memoryPages: {
    initial: 720,
    maximum: 2048,
    beforeBoot: pagesBeforeBoot,
    afterContract: adapter.diagnostics().memoryPages,
  },
  diagnostics: adapter.diagnostics(),
})}\n`);
