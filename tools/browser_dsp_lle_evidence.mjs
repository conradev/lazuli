#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

const DSP_LLE_EXECUTION_QUANTUM_CPU_CYCLES = 768;
const DSP_LLE_STOP_REASONS = Object.freeze([
  "instruction-budget",
  "halted",
  "dsp-mailbox-full",
  "cpu-mailbox-empty",
]);
const CURRENT_DSP_DEVICE_EVENTS = Object.freeze(new Set([
  "dspAudioDmaBlock",
  "dspAudioDmaComplete",
  "dspAudioDmaInitialInterrupt",
  "dspAudioDmaStart",
  "dspAudioDmaStop",
  "dspCpuMailboxCommit",
  "dspExternalInterrupt",
  "dspInitialize",
  "dspMailboxConsume",
]));
const LEGACY_DSP_MMIO_FIELDS = Object.freeze([
  "dspCurrentMail",
  "dspQueuedMails",
  "dspScheduledMail",
  "dspMode",
  "dspUcodeHash",
  "dspAxCompressorPosition",
  "dspAxCommand",
  "dspZeldaCommand",
  "dspTrace",
]);

function requireVerifierOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("DSP LLE evidence verifier options must be an object");
  }
  if (typeof options.fail !== "function") {
    throw new TypeError("DSP LLE evidence verifier requires a failure callback");
  }
  if (typeof options.root !== "string" || options.root.length === 0) {
    throw new TypeError("DSP LLE evidence verifier requires an evidence root");
  }
  return options;
}

export function verifyDspLleEvidence(report, options) {
  const { fail, root } = requireVerifierOptions(options);
  const path = suffix => `${root}.${suffix}`;
  const requiredObject = (value, valuePath) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(valuePath, "expected an object");
    }
    return value;
  };
  const requirePositiveInteger = (value, valuePath) => {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail(valuePath, "expected a positive integer");
    }
    return value;
  };
  const requireNonNegativeInteger = (value, valuePath) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(valuePath, "expected a non-negative integer");
    }
    return value;
  };
  const requireExact = (value, expected, valuePath) => {
    if (value !== expected) {
      fail(
        valuePath,
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`,
      );
    }
    return value;
  };
  const rejectPresentFields = (value, fields, valuePath) => {
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(value, field)) {
        fail(`${valuePath}.${field}`, "expected legacy HLE evidence to be absent");
      }
    }
  };

  requiredObject(report, root);
  const eventsPath = path("deviceEvents");
  const events = requiredObject(report.deviceEvents, eventsPath);
  requirePositiveInteger(
    events.dspAudioDmaStart,
    `${eventsPath}.dspAudioDmaStart`,
  );
  requirePositiveInteger(
    events.dspAudioDmaBlock,
    `${eventsPath}.dspAudioDmaBlock`,
  );
  for (const name of Object.keys(events)) {
    if (name.startsWith("dsp") && !CURRENT_DSP_DEVICE_EVENTS.has(name)) {
      fail(
        `${eventsPath}.${name}`,
        "expected legacy or unknown DSP event evidence to be absent",
      );
    }
  }

  const audioPath = path("audioCompatibility");
  const audio = requiredObject(report.audioCompatibility, audioPath);
  rejectPresentFields(audio, ["dspFirstUnsupported"], audioPath);

  const mmioPath = path("mmioState");
  const mmio = requiredObject(report.mmioState, mmioPath);
  rejectPresentFields(mmio, LEGACY_DSP_MMIO_FIELDS, mmioPath);

  const dspPath = `${audioPath}.dspLle`;
  const dsp = requiredObject(audio.dspLle, dspPath);
  requireExact(dsp.backend, "lle-wasm", `${dspPath}.backend`);
  requireExact(dsp.abi, 1, `${dspPath}.abi`);
  const slices = requirePositiveInteger(dsp.slices, `${dspPath}.slices`);
  const budgeted = requirePositiveInteger(
    dsp.budgetedInstructions,
    `${dspPath}.budgetedInstructions`,
  );
  const executed = requirePositiveInteger(
    dsp.executedInstructions,
    `${dspPath}.executedInstructions`,
  );
  if (executed > budgeted) {
    fail(
      `${dspPath}.executedInstructions`,
      "expected no more executed instructions than the cumulative budget",
    );
  }
  if (slices > Math.floor(budgeted / 64)) {
    fail(
      `${dspPath}.budgetedInstructions`,
      "expected at least 64 budgeted instructions for every execution slice",
    );
  }

  const pendingCpuCycles = requireNonNegativeInteger(
    dsp.pendingCpuCycles,
    `${dspPath}.pendingCpuCycles`,
  );
  if (pendingCpuCycles >= DSP_LLE_EXECUTION_QUANTUM_CPU_CYCLES) {
    fail(
      `${dspPath}.pendingCpuCycles`,
      `expected a value from 0 through ${DSP_LLE_EXECUTION_QUANTUM_CPU_CYCLES - 1}`,
    );
  }
  const lastExecutionCycle = requireNonNegativeInteger(
    dsp.lastExecutionCycle,
    `${dspPath}.lastExecutionCycle`,
  );
  const lastServiceCycle = requireNonNegativeInteger(
    dsp.lastServiceCycle,
    `${dspPath}.lastServiceCycle`,
  );
  const budgetedCpuCycles = budgeted * 12;
  const accountedCpuCycles = budgetedCpuCycles + pendingCpuCycles;
  if (
    !Number.isSafeInteger(accountedCpuCycles)
    || accountedCpuCycles !== lastServiceCycle
  ) {
    fail(
      `${dspPath}.lastServiceCycle`,
      "expected exact cumulative budget and pending-cycle accounting",
    );
  }
  if (
    lastExecutionCycle > lastServiceCycle
    || lastServiceCycle !== report.cycles
  ) {
    fail(
      `${dspPath}.lastServiceCycle`,
      "expected lastExecutionCycle <= lastServiceCycle === report.cycles",
    );
  }
  if (
    lastExecutionCycle < budgetedCpuCycles
    || lastExecutionCycle >= budgetedCpuCycles + 12
  ) {
    fail(
      `${dspPath}.lastExecutionCycle`,
      "expected the last execution cycle to match the cumulative instruction budget",
    );
  }

  const nextExecutionCycle = requirePositiveInteger(
    dsp.nextExecutionCycle,
    `${dspPath}.nextExecutionCycle`,
  );
  if (
    nextExecutionCycle <= lastServiceCycle
    || nextExecutionCycle - lastServiceCycle + pendingCpuCycles
      !== DSP_LLE_EXECUTION_QUANTUM_CPU_CYCLES
  ) {
    fail(
      `${dspPath}.nextExecutionCycle`,
      "expected the next coherent 768-CPU-cycle DSP boundary after the last service",
    );
  }

  const stopPath = `${dspPath}.lastStopReason`;
  const stop = requiredObject(dsp.lastStopReason, stopPath);
  const stopCode = requireNonNegativeInteger(stop.code, `${stopPath}.code`);
  if (stopCode >= DSP_LLE_STOP_REASONS.length) {
    fail(
      `${stopPath}.code`,
      "expected a non-fault DSP stop reason from 0 through 3",
    );
  }
  requireExact(stop.name, DSP_LLE_STOP_REASONS[stopCode], `${stopPath}.name`);
  requireExact(dsp.fault, null, `${dspPath}.fault`);
  const dspPc = requireNonNegativeInteger(dsp.pc, `${dspPath}.pc`);
  if (dspPc > 0xffff) {
    fail(`${dspPath}.pc`, "expected an unsigned 16-bit DSP program counter");
  }

  for (const name of [
    "cpuMailboxWrites",
    "cpuMailboxReads",
    "dspMailboxWrites",
    "dspMailboxReads",
  ]) {
    requirePositiveInteger(dsp[name], `${dspPath}.${name}`);
  }
  for (const name of [
    "cpuMailboxHighWrites",
    "mailboxReadAccesses",
    "dspInterruptAssertions",
  ]) {
    requireNonNegativeInteger(dsp[name], `${dspPath}.${name}`);
  }
  if (dsp.mailboxReadAccesses < dsp.dspMailboxReads) {
    fail(
      `${dspPath}.mailboxReadAccesses`,
      "expected at least as many receive-mailbox accesses as consuming reads",
    );
  }
  if (dsp.dspMailboxReads > dsp.dspMailboxWrites) {
    fail(
      `${dspPath}.dspMailboxReads`,
      "expected no more consuming reads than DSP mailbox writes",
    );
  }
  if (dsp.cpuMailboxReads > dsp.cpuMailboxWrites) {
    fail(
      `${dspPath}.cpuMailboxReads`,
      "expected no more DSP consumes than CPU mailbox commits",
    );
  }
  if (dsp.dspMailboxWrites - dsp.dspMailboxReads > 1) {
    fail(
      `${dspPath}.dspMailboxWrites`,
      "expected at most one unread value in the single-slot DSP mailbox",
    );
  }

  const stopReasonCountsPath = `${dspPath}.stopReasonCounts`;
  const stopReasonCounts = requiredObject(
    dsp.stopReasonCounts,
    stopReasonCountsPath,
  );
  let countedSlices = 0;
  for (const [name, count] of Object.entries(stopReasonCounts)) {
    if (!DSP_LLE_STOP_REASONS.includes(name)) {
      fail(
        `${stopReasonCountsPath}.${name}`,
        "expected a non-fault DSP stop reason",
      );
    }
    countedSlices += requireNonNegativeInteger(
      count,
      `${stopReasonCountsPath}.${name}`,
    );
  }
  requireExact(countedSlices, slices, stopReasonCountsPath);
  if ((stopReasonCounts[stop.name] ?? 0) === 0) {
    fail(
      `${stopReasonCountsPath}.${stop.name}`,
      "expected the last stop reason to have a positive cumulative count",
    );
  }

  const audioDmaPath = `${mmioPath}.dspAudioDma`;
  const audioDma = requiredObject(mmio.dspAudioDma, audioDmaPath);
  requireExact(audioDma.enabled, true, `${audioDmaPath}.enabled`);
  const configuredBlocks = requirePositiveInteger(
    audioDma.configuredBlocks,
    `${audioDmaPath}.configuredBlocks`,
  );
  const remainingBlocks = requirePositiveInteger(
    audioDma.remainingBlocks,
    `${audioDmaPath}.remainingBlocks`,
  );
  if (remainingBlocks > configuredBlocks) {
    fail(
      `${audioDmaPath}.remainingBlocks`,
      "expected no more remaining blocks than configured blocks",
    );
  }
  requireExact(
    audioDma.blocksLeft,
    remainingBlocks - 1,
    `${audioDmaPath}.blocksLeft`,
  );
  requirePositiveInteger(audioDma.cyclesPerBlock, `${audioDmaPath}.cyclesPerBlock`);
  const nextAudioDmaCycle = requirePositiveInteger(
    audioDma.nextCycle,
    `${audioDmaPath}.nextCycle`,
  );
  if (nextAudioDmaCycle <= report.cycles) {
    fail(
      `${audioDmaPath}.nextCycle`,
      "expected the enabled audio DMA to remain scheduled after the snapshot",
    );
  }

  return Object.freeze({
    slices,
    budgeted,
    executed,
    lastServiceCycle,
  });
}
