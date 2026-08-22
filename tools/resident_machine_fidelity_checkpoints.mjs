// SPDX-License-Identifier: GPL-3.0-only

export const FIDELITY_CHECKPOINT_SCHEMA =
  "lazuli-resident-renderer-fidelity-checkpoint-v1";
export const FIDELITY_CHECKPOINT_ACK_SCHEMA =
  "lazuli-resident-renderer-fidelity-checkpoint-ack-v1";
export const PRODUCTION_FIDELITY_INSTRUCTION_UPPER_CAP = "16000000000";
export const PRODUCTION_FIDELITY_EXECUTED_CYCLE_UPPER_CAP = "32000000000";
export const PRODUCTION_FIDELITY_CANONICAL_CYCLE_UPPER_CAP = "32000000000";
export const PRODUCTION_FIDELITY_TOTAL_COLD_INSTALL_CAP = 0x000f_ffff;
export const PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP = 65;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROBE_EVENT_PER_SUBMISSION_CAP = 402;

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function uint32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${label} must be an unsigned 32-bit integer`);
  }
  return value >>> 0;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

const CAPTURE_RUN_POLICY_FIELDS = Object.freeze([
  "instructionUpperCap",
  "executedCycleUpperCap",
  "canonicalCycleUpperCap",
  "sliceCycleUpperCap",
  "blockUpperCap",
  "totalHostCallCap",
  "totalColdInstallCap",
  "maxBootReads",
  "bootTimeoutMs",
  "sliceTimeoutMs",
  "runTimeoutMs",
  "externalWallTimeoutMs",
  "zeroProgressSliceCap",
  "workerUrl",
  "navigationPolicy",
]);
const CAPTURE_RUN_SUMMARY_FIELDS = Object.freeze([
  "schema",
  "issuedRunCalls",
  "canonicalCycle",
  "reportedCanonicalCycles",
  "reportedExecutedCycles",
  "reportedExecutedInstructions",
  "reportedRetiredBlocks",
  "reportedHostCalls",
  "reportedColdInstalls",
  "zeroProgressSlices",
  "consecutiveZeroProgressSlices",
  "maximumConsecutiveZeroProgressSlices",
  "operatorPublications",
  "witnessPublications",
  "elapsedWallMs",
  "wallTimeoutMs",
  "accepted",
]);

function exactObjectKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const fields = [...expected].sort();
  if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) {
    throw new Error(`${label} fields changed`);
  }
}

function decimalString(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be an unsigned decimal string`);
  }
  return value;
}

function captureNavigationPolicy(value, label) {
  exactObjectKeys(value, [
    "schema", "gameKey", "algorithm", "cycleOrigin", "controllerEncoding",
    "targetAnchor", "receiptSource", "periodicSiCycles", "maximumReceiptLatencyCycles",
    "maximumPublications", "scriptSha256", "steps",
  ], label);
  if (value.schema !== "lazuli-resident-pre-baseline-navigation-v1") {
    throw new Error(`${label} schema changed`);
  }
  if (typeof value.gameKey !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.gameKey)) {
    throw new Error(`${label} gameKey changed`);
  }
  if (value.algorithm !== "locked-si-observed-not-before-publication-v1") {
    throw new Error(`${label} algorithm changed`);
  }
  if (
    value.cycleOrigin !== "durable-first-frame-canonical-scheduler-cycle"
    || value.controllerEncoding !== "gamecube-packed-controller-v1"
    || value.targetAnchor !== "prior-si-observed-cycle"
    || value.receiptSource !== "periodic"
    || value.periodicSiCycles !== "8108100"
    || value.maximumReceiptLatencyCycles !== "16108100"
    || value.maximumPublications !== PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP
    || typeof value.scriptSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.scriptSha256)
    || !Array.isArray(value.steps)
    || value.steps.length > value.maximumPublications
  ) throw new Error(`${label} authority changed`);
  const steps = value.steps.map((step, index) => {
    const stepLabel = `${label}.steps[${index}]`;
    exactObjectKeys(step, [
      "minimumCanonicalDelay", "buttons", "stickXyCxy", "triggerLrab",
    ], stepLabel);
    decimalString(step.minimumCanonicalDelay, `${stepLabel} minimum canonical delay`);
    if (BigInt(step.minimumCanonicalDelay) === 0n) {
      throw new Error(`${stepLabel} minimum canonical delay must be positive`);
    }
    for (const field of ["buttons", "stickXyCxy", "triggerLrab"]) {
      uint32(step[field], `${stepLabel} ${field}`);
    }
    if ((step.buttons & ~0x0000_1f7f) !== 0) {
      throw new Error(`${stepLabel} buttons include reserved bits`);
    }
    return Object.freeze(structuredClone(step));
  });
  if (steps.length !== 0) {
    const terminal = steps.at(-1);
    if (
      terminal.buttons !== 0
      || terminal.stickXyCxy !== 0x8080_8080
      || terminal.triggerLrab !== 0
    ) throw new Error(`${label} does not end neutral`);
  }
  return Object.freeze({ ...structuredClone(value), steps: Object.freeze(steps) });
}

export function captureRunPolicy(value) {
  exactObjectKeys(value, CAPTURE_RUN_POLICY_FIELDS, "capture runPolicy");
  const result = structuredClone(value);
  for (const field of [
    "instructionUpperCap", "executedCycleUpperCap", "canonicalCycleUpperCap",
    "sliceCycleUpperCap",
  ]) {
    decimalString(result[field], `capture runPolicy ${field}`);
    if (BigInt(result[field]) === 0n) throw new Error(`capture runPolicy ${field} must be positive`);
  }
  for (const field of [
    "blockUpperCap", "totalHostCallCap", "totalColdInstallCap", "maxBootReads",
    "bootTimeoutMs", "sliceTimeoutMs", "runTimeoutMs", "externalWallTimeoutMs",
    "zeroProgressSliceCap",
  ]) positiveInteger(result[field], `capture runPolicy ${field}`);
  if (typeof result.workerUrl !== "string" || !result.workerUrl.startsWith("/")) {
    throw new Error("capture runPolicy workerUrl must be a same-origin absolute path");
  }
  if (
    BigInt(result.sliceCycleUpperCap) > BigInt(result.executedCycleUpperCap)
    || BigInt(result.sliceCycleUpperCap) > BigInt(result.canonicalCycleUpperCap)
  ) {
    throw new Error("capture runPolicy slice cycle cap exceeds a total cycle cap");
  }
  result.navigationPolicy = captureNavigationPolicy(
    result.navigationPolicy,
    "capture runPolicy navigationPolicy",
  );
  return Object.freeze(result);
}

export function captureRunSummary(value, policy, label, accepted) {
  exactObjectKeys(value, CAPTURE_RUN_SUMMARY_FIELDS, label);
  const result = structuredClone(value);
  if (result.schema !== "lazuli-resident-cumulative-run-summary-v2") {
    throw new Error(`${label} schema changed`);
  }
  decimalString(result.canonicalCycle, `${label} canonical cycle`);
  decimalString(result.reportedCanonicalCycles, `${label} reported canonical cycles`);
  decimalString(result.reportedExecutedCycles, `${label} reported executed cycles`);
  decimalString(result.reportedExecutedInstructions, `${label} reported executed instructions`);
  decimalString(result.reportedRetiredBlocks, `${label} reported retired blocks`);
  for (const field of [
    "issuedRunCalls", "reportedHostCalls", "reportedColdInstalls", "zeroProgressSlices",
    "consecutiveZeroProgressSlices", "maximumConsecutiveZeroProgressSlices",
    "operatorPublications", "witnessPublications", "elapsedWallMs",
  ]) nonnegativeInteger(result[field], `${label} ${field}`);
  positiveInteger(result.wallTimeoutMs, `${label} wall timeout`);
  if (typeof result.accepted !== "boolean" || result.accepted !== accepted) {
    throw new Error(`${label} Accepted state changed`);
  }
  const wallTimeout = Math.min(policy.runTimeoutMs, policy.externalWallTimeoutMs);
  if (result.wallTimeoutMs !== wallTimeout || result.elapsedWallMs >= wallTimeout) {
    throw new Error(`${label} wall authority changed or exhausted`);
  }
  if (
    BigInt(result.reportedCanonicalCycles) > BigInt(policy.canonicalCycleUpperCap)
    || BigInt(result.reportedExecutedCycles) > BigInt(policy.executedCycleUpperCap)
    || BigInt(result.reportedExecutedInstructions) > BigInt(policy.instructionUpperCap)
    || result.reportedHostCalls > policy.totalHostCallCap
    || result.reportedColdInstalls > policy.totalColdInstallCap
    || result.consecutiveZeroProgressSlices >= policy.zeroProgressSliceCap
    || result.maximumConsecutiveZeroProgressSlices >= policy.zeroProgressSliceCap
    || result.operatorPublications > PRODUCTION_FIDELITY_OPERATOR_PUBLICATION_CAP
    || result.witnessPublications > 1
  ) {
    throw new Error(`${label} exceeded the frozen cumulative authority`);
  }
  return Object.freeze(result);
}

function expectedNavigationSiPacket(step, mode) {
  const word0 = (
    ((step.buttons >>> 8) & 0xff) << 24
    | (((step.buttons & 0xff) | 0x80) & 0xff) << 16
    | (step.stickXyCxy & 0xff) << 8
    | ((step.stickXyCxy >>> 8) & 0xff)
  ) >>> 0;
  const cStickX = (step.stickXyCxy >>> 16) & 0xff;
  const cStickY = (step.stickXyCxy >>> 24) & 0xff;
  const triggerL = step.triggerLrab & 0xff;
  const triggerR = (step.triggerLrab >>> 8) & 0xff;
  const analogA = (step.triggerLrab >>> 16) & 0xff;
  const analogB = (step.triggerLrab >>> 24) & 0xff;
  const low = mode === 0 || (mode >= 5 && mode <= 7)
    ? [cStickX, cStickY, (triggerL & 0xf0) | (triggerR >>> 4),
      (analogA & 0xf0) | (analogB >>> 4)]
    : mode === 1
      ? [(cStickX & 0xf0) | (cStickY >>> 4), triggerL, triggerR,
        (analogA & 0xf0) | (analogB >>> 4)]
      : mode === 2
        ? [(cStickX & 0xf0) | (cStickY >>> 4),
          (triggerL & 0xf0) | (triggerR >>> 4), analogA, analogB]
        : mode === 4
          ? [cStickX, cStickY, analogA, analogB]
          : [cStickX, cStickY, triggerL, triggerR];
  const word1 = (low[0] << 24 | low[1] << 16 | low[2] << 8 | low[3]) >>> 0;
  return { word0, word1 };
}

export function captureNavigationRuntime(value, runPolicy, label) {
  const policy = runPolicy.navigationPolicy;
  exactObjectKeys(value, [
    "schema", "scriptSha256", "stepCount", "durableSteps", "complete",
    "runCallOrigin", "canonicalCycleOrigin", "siPollIndexOrigin",
    "lastReceiptObservedCanonicalCycle",
    "nextTargetCanonicalCycle", "pendingPublication", "transcript",
  ], label);
  if (
    value.schema !== "lazuli-resident-navigation-runtime-v2"
    || value.scriptSha256 !== policy.scriptSha256
    || value.stepCount !== policy.steps.length
    || nonnegativeInteger(value.durableSteps, `${label} durable steps`) > value.stepCount
    || typeof value.complete !== "boolean"
    || nonnegativeInteger(value.runCallOrigin, `${label} run-call origin`) < 0
    || decimalString(value.canonicalCycleOrigin, `${label} canonical-cycle origin`) === null
    || decimalString(value.siPollIndexOrigin, `${label} SI poll-index origin`) === null
    || !Array.isArray(value.transcript)
    || value.transcript.length !== value.durableSteps
  ) throw new Error(`${label} authority changed`);
  let priorSequence = -1n;
  let priorPollIndex = BigInt(value.siPollIndexOrigin);
  let priorAnchor = BigInt(value.canonicalCycleOrigin);
  const transcript = value.transcript.map((entry, index) => {
    const entryLabel = `${label}.transcript[${index}]`;
    exactObjectKeys(entry, [
      "stepIndex", "sequenceLo", "sequenceHi", "minimumCanonicalDelay",
      "targetCanonicalCycle", "publicationCanonicalCycle", "publicationOvershootCycles",
      "buttons", "stickXyCxy", "triggerLrab", "status", "siPollIndex",
      "siScheduledCycle", "siObservedCycle", "siAppliedSequenceLo", "siAppliedSequenceHi",
      "siPacketWord0", "siPacketWord1", "siSource", "priorSiPollIndex",
      "siControllerMode", "siButtons", "siStickXyCxy", "siTriggerLrab",
    ], entryLabel);
    const step = policy.steps[index];
    const sequenceLo = uint32(entry.sequenceLo, `${entryLabel} sequenceLo`);
    const sequenceHi = uint32(entry.sequenceHi, `${entryLabel} sequenceHi`);
    const sequence = BigInt(sequenceHi) << 32n | BigInt(sequenceLo);
    const target = priorAnchor + BigInt(step.minimumCanonicalDelay);
    const publication = BigInt(decimalString(
      entry.publicationCanonicalCycle,
      `${entryLabel} publication canonical cycle`,
    ));
    const overshoot = BigInt(decimalString(
      entry.publicationOvershootCycles,
      `${entryLabel} publication overshoot`,
    ));
    const scheduled = BigInt(decimalString(entry.siScheduledCycle, `${entryLabel} SI scheduled`));
    const observed = BigInt(decimalString(entry.siObservedCycle, `${entryLabel} SI observed`));
    const mode = uint32(entry.siControllerMode, `${entryLabel} SI controller mode`);
    const packet = expectedNavigationSiPacket(step, mode);
    const pollIndex = BigInt(decimalString(entry.siPollIndex, `${entryLabel} SI poll index`));
    const priorRecordedPoll = BigInt(decimalString(
      entry.priorSiPollIndex,
      `${entryLabel} prior SI poll index`,
    ));
    if (
      entry.stepIndex !== index
      || entry.minimumCanonicalDelay !== step.minimumCanonicalDelay
      || decimalString(entry.targetCanonicalCycle, `${entryLabel} target canonical cycle`)
        !== target.toString()
      || publication < target
      || overshoot !== publication - target
      || overshoot > BigInt(runPolicy.sliceCycleUpperCap)
      || uint32(entry.buttons, `${entryLabel} buttons`) !== step.buttons
      || uint32(entry.stickXyCxy, `${entryLabel} sticks`) !== step.stickXyCxy
      || uint32(entry.triggerLrab, `${entryLabel} triggers`) !== step.triggerLrab
      || entry.status !== 1
      || sequence <= priorSequence
      || priorRecordedPoll < priorPollIndex
      || pollIndex <= priorRecordedPoll
      || scheduled < publication
      || observed < scheduled
      || scheduled - publication > BigInt(policy.periodicSiCycles)
      || observed - publication > BigInt(policy.maximumReceiptLatencyCycles)
      || uint32(entry.siAppliedSequenceLo, `${entryLabel} SI sequenceLo`) !== sequenceLo
      || uint32(entry.siAppliedSequenceHi, `${entryLabel} SI sequenceHi`) !== sequenceHi
      || uint32(entry.siPacketWord0, `${entryLabel} SI packet word 0`) !== packet.word0
      || uint32(entry.siPacketWord1, `${entryLabel} SI packet word 1`) !== packet.word1
      || entry.siSource !== 0
      || mode > 7
      || uint32(entry.siButtons, `${entryLabel} SI buttons`) !== step.buttons
      || uint32(entry.siStickXyCxy, `${entryLabel} SI sticks`) !== step.stickXyCxy
      || uint32(entry.siTriggerLrab, `${entryLabel} SI triggers`) !== step.triggerLrab
    ) throw new Error(`${entryLabel} changed its locked publication`);
    priorSequence = sequence;
    priorPollIndex = pollIndex;
    priorAnchor = observed;
    return Object.freeze(structuredClone(entry));
  });
  const expectedLast = transcript.length === 0 ? null : priorAnchor.toString();
  const nextStep = policy.steps[transcript.length] ?? null;
  const expectedNext = nextStep === null
    ? null
    : (priorAnchor + BigInt(nextStep.minimumCanonicalDelay)).toString();
  if (
    value.lastReceiptObservedCanonicalCycle !== expectedLast
    || value.nextTargetCanonicalCycle !== expectedNext
    || value.complete !== (value.durableSteps === value.stepCount && value.pendingPublication === null)
  ) throw new Error(`${label} derived chronology changed`);
  if (value.pendingPublication !== null) {
    if (value.durableSteps >= value.stepCount) throw new Error(`${label} has a terminal pending step`);
    const pending = value.pendingPublication;
    const pendingLabel = `${label}.pendingPublication`;
    exactObjectKeys(pending, [
      "stepIndex", "sequenceLo", "sequenceHi", "minimumCanonicalDelay",
      "targetCanonicalCycle", "publicationCanonicalCycle", "publicationOvershootCycles",
      "buttons", "stickXyCxy", "triggerLrab", "status", "priorSiPollIndex",
    ], pendingLabel);
    const step = policy.steps[value.durableSteps];
    const target = priorAnchor + BigInt(step.minimumCanonicalDelay);
    const publication = BigInt(decimalString(
      pending.publicationCanonicalCycle,
      `${pendingLabel} publication canonical cycle`,
    ));
    const pendingSequenceLo = uint32(pending.sequenceLo, `${pendingLabel} sequenceLo`);
    const pendingSequenceHi = uint32(pending.sequenceHi, `${pendingLabel} sequenceHi`);
    const pendingSequence = BigInt(pendingSequenceHi) << 32n | BigInt(pendingSequenceLo);
    const pendingPriorPoll = BigInt(decimalString(
      pending.priorSiPollIndex,
      `${pendingLabel} prior SI poll index`,
    ));
    if (
      pending.stepIndex !== value.durableSteps
      || pending.minimumCanonicalDelay !== step.minimumCanonicalDelay
      || pending.targetCanonicalCycle !== target.toString()
      || BigInt(decimalString(pending.publicationOvershootCycles, `${pendingLabel} overshoot`))
        !== publication - target
      || publication < target
      || publication - target > BigInt(runPolicy.sliceCycleUpperCap)
      || pending.buttons !== step.buttons
      || pending.stickXyCxy !== step.stickXyCxy
      || pending.triggerLrab !== step.triggerLrab
      || pending.status !== 1
      || pendingSequence <= priorSequence
      || pendingPriorPoll < priorPollIndex
    ) throw new Error(`${pendingLabel} changed its locked publication`);
  }
  return Object.freeze({ ...structuredClone(value), transcript: Object.freeze(transcript) });
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function submissionIdentity(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("renderer submission identity must be an object");
  }
  if (typeof value.presentedBefore !== "boolean") {
    throw new Error("renderer submission presentedBefore must be boolean");
  }
  return Object.freeze({
    relayRequestId: positiveInteger(value.relayRequestId, "renderer relay request id"),
    renderCallOrdinal: positiveInteger(value.renderCallOrdinal, "render call ordinal"),
    requestFlags: uint32(value.requestFlags, "renderer request flags"),
    sequenceLo: uint32(value.sequenceLo, "renderer sequence low word"),
    sequenceHi: uint32(value.sequenceHi, "renderer sequence high word"),
    opaqueRequestBytes: positiveInteger(
      value.opaqueRequestBytes,
      "opaque renderer request bytes",
      64 * 1024 * 1024,
    ),
    opaqueRequestSha256: digest(
      value.opaqueRequestSha256,
      "opaque renderer request SHA-256",
    ),
    presentedBefore: value.presentedBefore,
  });
}

function exactIdentity(left, right) {
  return Object.keys(left).every(field => left[field] === right[field]);
}

function resolvedReceiptIdentity(value) {
  const identity = submissionIdentity(value);
  return Object.freeze({
    ...identity,
    receiptBytes: positiveInteger(
      value.receiptBytes,
      "renderer receipt bytes",
      64 * 1024 * 1024,
    ),
    receiptSha256: digest(value.receiptSha256, "renderer receipt SHA-256"),
    presentedAfterResolution: (() => {
      if (typeof value.presentedAfterResolution !== "boolean") {
        throw new Error("presentedAfterResolution must be boolean");
      }
      return value.presentedAfterResolution;
    })(),
    receiptRecordSha256: digest(
      value.receiptRecordSha256,
      "durable receipt record SHA-256",
    ),
  });
}

function byteArtifact(value, label, maximum = 64 * 1024 * 1024) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  if (keys.join("\n") !== ["bytes", "sha256"].join("\n")) {
    throw new Error(`${label} must contain exactly bytes and sha256`);
  }
  return Object.freeze({
    bytes: positiveInteger(value.bytes, `${label} bytes`, maximum),
    sha256: digest(value.sha256, `${label} SHA-256`),
  });
}

function fidelityArtifacts(value) {
  return Object.freeze({
    gameFidelityEnvelope: byteArtifact(
      value.gameFidelityEnvelope,
      "GameFidelityV1 envelope",
      16 * 1024,
    ),
    gameFidelityOpaque: byteArtifact(
      value.gameFidelityOpaque,
      "GameFidelityV1 opaque record",
      384,
    ),
    machineEvidenceEnvelope: byteArtifact(
      value.machineEvidenceEnvelope,
      "MachineEvidenceV1 envelope",
      16 * 1024,
    ),
    machineEvidenceOpaque: byteArtifact(
      value.machineEvidenceOpaque,
      "MachineEvidenceV1 opaque record",
      816,
    ),
  });
}

export class ResidentFidelityCheckpointClient {
  constructor(worker, {
    runId,
    gameKey,
    evidenceLockSha256,
    timeoutMs = 10_000,
    recordCap = 65_535,
    probeEventCap = 32_768,
  }) {
    if (!worker || typeof worker.postMessage !== "function") {
      throw new Error("fidelity checkpoint Worker is required");
    }
    if (typeof runId !== "string" || !UUID_PATTERN.test(runId)) {
      throw new Error("fidelity checkpoint runId must be a UUID");
    }
    if (typeof gameKey !== "string" || !KEY_PATTERN.test(gameKey)) {
      throw new Error("fidelity checkpoint gameKey must be lowercase kebab-case");
    }
    digest(evidenceLockSha256, "fidelity evidence lock SHA-256");
    this.worker = worker;
    this.runId = runId;
    this.gameKey = gameKey;
    this.evidenceLockSha256 = evidenceLockSha256;
    this.timeoutMs = positiveInteger(timeoutMs, "checkpoint timeout", 60_000);
    this.recordCap = positiveInteger(recordCap, "checkpoint record cap", 1_000_000);
    this.probeEventCap = positiveInteger(
      probeEventCap,
      "renderer probe event cap",
      this.recordCap,
    );
    this.nextRequestId = 1;
    this.clientSequence = 0;
    this.pending = new Map();
    this.kindCounts = Object.create(null);
    this.probeEvents = 0;
    this.probeEventsThisSubmission = 0;
    this.maximumProbeEventsPerSubmission = 0;
    this.activeSubmission = null;
    this.submissionReturned = false;
    this.lastResolvedReceipt = null;
    this.machineSessionId = null;
    this.machineInitializationRecordSha256 = null;
    this.captureRunPolicy = null;
    this.initialRunSummary = null;
    this.firstFrameRendererRecordSha256 = null;
    this.firstFrameReceipt = null;
    this.firstFrameReadback = null;
    this.baselineRecordSha256 = null;
    this.baselineRequestedController = null;
    this.firstFrameReportRecordSha256 = null;
    this.navigationArmRecordSha256 = null;
    this.navigationStepRecordSha256s = [];
    this.navigationTranscript = [];
    this.navigationRunCallOrigin = null;
    this.navigationCycleOrigin = null;
    this.witnessRecordSha256 = null;
    this.acceptedRecordSha256 = null;
    this.acceptedArtifacts = null;
    this.terminalRecordSha256 = null;
    this.firstRecordSha256 = null;
    this.lastRecordSha256 = null;
    this.lastServerSequence = 0;
    this.firstFailure = null;
    this.probeRelayFailures = 0;
    this.closed = false;
    worker.addEventListener("message", event => this.handle(event.data ?? {}));
    worker.addEventListener("error", event => {
      this.failAll(new Error(event.message || "fidelity checkpoint Worker failed"));
    });
  }

  failAll(error) {
    if (this.firstFailure === null) this.firstFailure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  handle(message) {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.type === "resident-fidelity-checkpoint-error") {
      const error = new Error(String(message.error ?? "checkpoint persistence failed"));
      if (this.firstFailure === null) this.firstFailure = error;
      pending.reject(error);
      return;
    }
    if (message.type !== "resident-fidelity-checkpoint-ack") {
      const error = new Error(`unexpected checkpoint Worker response ${String(message.type)}`);
      if (this.firstFailure === null) this.firstFailure = error;
      pending.reject(error);
      return;
    }
    const ack = message.ack;
    if (
      ack?.schema !== FIDELITY_CHECKPOINT_ACK_SCHEMA
      || ack.runId !== this.runId
      || ack.gameKey !== this.gameKey
      || ack.clientSequence !== pending.clientSequence
      || ack.durable !== true
      || !Number.isSafeInteger(ack.serverSequence)
      || ack.serverSequence !== this.lastServerSequence + 1
      || !SHA256_PATTERN.test(ack.recordSha256 ?? "")
      || ack.evidenceLockSha256 !== this.evidenceLockSha256
      || ack.previousRecordSha256 !== this.lastRecordSha256
    ) {
      const error = new Error("invalid durable checkpoint acknowledgement");
      if (this.firstFailure === null) this.firstFailure = error;
      pending.reject(error);
      return;
    }
    this.firstRecordSha256 ??= ack.recordSha256;
    this.lastRecordSha256 = ack.recordSha256;
    this.lastServerSequence = ack.serverSequence;
    pending.resolve(ack);
  }

  append(kind, fields) {
    if (this.closed) throw new Error("fidelity checkpoint client is closed");
    if (this.terminalRecordSha256 !== null) {
      throw new Error("fidelity checkpoint journal reached its terminal record");
    }
    if (this.clientSequence >= this.recordCap) {
      throw new Error(`fidelity checkpoint record cap ${this.recordCap} reached`);
    }
    const requestId = this.nextRequestId++;
    const clientSequence = ++this.clientSequence;
    const payload = {
      schema: FIDELITY_CHECKPOINT_SCHEMA,
      runId: this.runId,
      gameKey: this.gameKey,
      clientSequence,
      kind,
      ...fields,
    };
    this.kindCounts[kind] = (this.kindCounts[kind] ?? 0) + 1;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(
          `checkpoint ${clientSequence} exceeded the end-to-end ${this.timeoutMs} ms deadline`,
        );
        if (this.firstFailure === null) this.firstFailure = error;
        reject(error);
      }, this.timeoutMs);
      this.pending.set(requestId, { clientSequence, resolve, reject, timer });
      this.worker.postMessage({
        type: "resident-fidelity-checkpoint-append",
        requestId,
        timeoutMs: this.timeoutMs,
        deadlineUnixMs: Date.now() + this.timeoutMs,
        payload,
      });
    });
    return promise;
  }

  async preSubmit(value) {
    if (this.activeSubmission !== null) {
      throw new Error("renderer submission checkpoint already open");
    }
    const identity = submissionIdentity(value);
    await this.append("pre-submit", identity);
    this.throwIfFailed();
    this.activeSubmission = identity;
    this.submissionReturned = false;
    this.probeEventsThisSubmission = 0;
  }

  rendererProbeEvent(...values) {
    if (this.activeSubmission === null) {
      throw new Error("renderer probe event has no active submission");
    }
    if (values.length !== 6) {
      throw new Error("renderer probe event must contain exactly six u32 values");
    }
    this.probeEvents += 1;
    if (this.probeEvents > this.probeEventCap) {
      throw new Error(`renderer probe event cap ${this.probeEventCap} reached`);
    }
    this.probeEventsThisSubmission += 1;
    if (this.probeEventsThisSubmission > PROBE_EVENT_PER_SUBMISSION_CAP) {
      throw new Error(
        `renderer probe per-submission cap ${PROBE_EVENT_PER_SUBMISSION_CAP} reached`,
      );
    }
    this.maximumProbeEventsPerSubmission = Math.max(
      this.maximumProbeEventsPerSubmission,
      this.probeEventsThisSubmission,
    );
    const words = values.map((value, index) => uint32(value, `renderer probe word ${index}`));
    const promise = this.append("renderer-probe-event", {
      relayRequestId: this.activeSubmission.relayRequestId,
      renderCallOrdinal: this.activeSubmission.renderCallOrdinal,
      words,
    });
    promise.catch(error => {
      if (this.firstFailure === null) this.firstFailure = error;
    });
  }

  noteProbeRelayFailure(error) {
    this.probeRelayFailures += 1;
    if (this.firstFailure === null) {
      this.firstFailure = error instanceof Error ? error : new Error(String(error));
    }
  }

  async submitReturned(value, presentedAfterReturn) {
    if (this.activeSubmission === null || this.submissionReturned) {
      throw new Error("renderer submission return checkpoint is out of order");
    }
    const identity = submissionIdentity(value);
    if (!exactIdentity(identity, this.activeSubmission)) {
      throw new Error("renderer submission identity changed at method return");
    }
    if (typeof presentedAfterReturn !== "boolean") {
      throw new Error("presentedAfterReturn must be boolean");
    }
    await this.append("submit-returned", {
      ...identity,
      returnedPromise: true,
      presentedAfterReturn,
    });
    this.throwIfFailed();
    this.submissionReturned = true;
  }

  async receiptResolved(value, receipt, receiptSha256, presentedAfterResolution) {
    if (this.activeSubmission === null || !this.submissionReturned) {
      throw new Error("renderer receipt checkpoint is out of order");
    }
    const identity = submissionIdentity(value);
    if (!exactIdentity(identity, this.activeSubmission)) {
      throw new Error("renderer submission identity changed at receipt resolution");
    }
    if (!(receipt instanceof Uint8Array) || receipt.byteLength === 0) {
      throw new Error("renderer receipt must be a non-empty owned Uint8Array");
    }
    digest(receiptSha256, "renderer receipt SHA-256");
    if (typeof presentedAfterResolution !== "boolean") {
      throw new Error("presentedAfterResolution must be boolean");
    }
    const ack = await this.append("receipt-resolved", {
      ...identity,
      receiptBytes: receipt.byteLength,
      receiptSha256,
      presentedAfterResolution,
    });
    this.throwIfFailed();
    this.activeSubmission = null;
    this.submissionReturned = false;
    this.lastResolvedReceipt = Object.freeze({
      ...identity,
      receiptBytes: receipt.byteLength,
      receiptSha256,
      presentedAfterResolution,
      receiptRecordSha256: ack.recordSha256,
    });
    return ack;
  }

  requireResolvedReceipt(value, label) {
    if (this.machineSessionId === null) {
      throw new Error(`${label} requires one durable machine initialization`);
    }
    if (this.activeSubmission !== null || this.submissionReturned) {
      throw new Error(`${label} requires no open renderer submission`);
    }
    if (this.lastResolvedReceipt === null) {
      throw new Error(`${label} requires one resolved renderer receipt`);
    }
    const identity = resolvedReceiptIdentity(value);
    if (!exactIdentity(identity, this.lastResolvedReceipt)) {
      throw new Error(`${label} did not match the most recently resolved receipt`);
    }
    return identity;
  }

  async captureMachineInitialized(value) {
    if (this.clientSequence !== 0 || this.machineSessionId !== null) {
      throw new Error("capture machine initialization must be the first checkpoint");
    }
    if (typeof value.machineSessionId !== "string" || !UUID_PATTERN.test(value.machineSessionId)) {
      throw new Error("capture machine session ID must be a UUID");
    }
    const machineEvidenceEnvelope = byteArtifact(
      value.machineEvidenceEnvelope,
      "ready MachineEvidenceV1 envelope",
      16 * 1024,
    );
    const machineEvidenceOpaque = byteArtifact(
      value.machineEvidenceOpaque,
      "ready MachineEvidenceV1 opaque record",
      816,
    );
    if (machineEvidenceOpaque.bytes !== 816) {
      throw new Error("ready MachineEvidenceV1 opaque record must be exactly 816 bytes");
    }
    const runPolicy = captureRunPolicy(value.runPolicy);
    const runSummary = captureRunSummary(
      value.runSummary,
      runPolicy,
      "ready cumulative run summary",
      false,
    );
    if (value.bootStatus !== 3 || value.bootReads > runPolicy.maxBootReads) {
      throw new Error("capture ready boot authority changed or exceeded its read cap");
    }
    if (
      runSummary.issuedRunCalls !== 0
      || runSummary.reportedExecutedCycles !== "0"
      || runSummary.reportedExecutedInstructions !== "0"
      || runSummary.reportedHostCalls !== 0
      || runSummary.reportedColdInstalls !== 0
      || runSummary.zeroProgressSlices !== 0
      || runSummary.consecutiveZeroProgressSlices !== 0
      || runSummary.maximumConsecutiveZeroProgressSlices !== 0
      || runSummary.operatorPublications !== 0
      || runSummary.witnessPublications !== 0
      || runSummary.elapsedWallMs !== 0
    ) {
      throw new Error("ready cumulative run summary was not pristine");
    }
    const ack = await this.append("capture-machine-initialized", {
      machineSessionId: value.machineSessionId,
      bootStatus: uint32(value.bootStatus, "capture boot status"),
      bootReads: positiveInteger(value.bootReads, "capture boot reads", 65_535),
      machineEvidenceEnvelopeBytes: machineEvidenceEnvelope.bytes,
      machineEvidenceEnvelopeSha256: machineEvidenceEnvelope.sha256,
      machineEvidenceOpaqueBytes: machineEvidenceOpaque.bytes,
      machineEvidenceOpaqueSha256: machineEvidenceOpaque.sha256,
      runPolicy,
      runSummary,
    });
    this.throwIfFailed();
    this.machineSessionId = value.machineSessionId;
    this.machineInitializationRecordSha256 = ack.recordSha256;
    this.captureRunPolicy = runPolicy;
    this.initialRunSummary = runSummary;
    return ack;
  }

  async firstFrameRendererOwned(value) {
    if (this.firstFrameRendererRecordSha256 !== null) {
      throw new Error("first-frame renderer ownership was already checkpointed");
    }
    if (this.lastRecordSha256 !== this.lastResolvedReceipt?.receiptRecordSha256) {
      throw new Error("first-frame renderer ownership must immediately follow its receipt");
    }
    const identity = this.requireResolvedReceipt(value, "first-frame renderer ownership");
    const readbackMetadata = byteArtifact(
      value.readbackMetadata,
      "first-frame readback metadata",
      1024 * 1024,
    );
    const rgba = byteArtifact(value.rgba, "first-frame RGBA");
    const ack = await this.append("first-frame-renderer-owned", {
      machineSessionId: this.machineSessionId,
      ...identity,
      readbackMetadataBytes: readbackMetadata.bytes,
      readbackMetadataSha256: readbackMetadata.sha256,
      rgbaBytes: rgba.bytes,
      rgbaSha256: rgba.sha256,
    });
    this.throwIfFailed();
    this.firstFrameRendererRecordSha256 = ack.recordSha256;
    this.firstFrameReceipt = identity;
    this.firstFrameReadback = Object.freeze({
      readbackMetadataBytes: readbackMetadata.bytes,
      readbackMetadataSha256: readbackMetadata.sha256,
      rgbaBytes: rgba.bytes,
      rgbaSha256: rgba.sha256,
    });
    return ack;
  }

  async fidelityPhaseOwned(kind, value) {
    if (kind !== "fidelity-baseline-owned" && kind !== "fidelity-accepted-owned") {
      throw new Error("unsupported fidelity ownership phase");
    }
    if (this.firstFrameRendererRecordSha256 === null) {
      throw new Error(`${kind} requires first-frame renderer ownership`);
    }
    if (kind === "fidelity-baseline-owned" && this.baselineRecordSha256 !== null) {
      throw new Error("Baseline ownership was already checkpointed");
    }
    if (
      kind === "fidelity-baseline-owned"
      && this.captureRunPolicy !== null
      && (
        this.navigationTranscript.length !== this.captureRunPolicy.navigationPolicy.steps.length
        || (
          this.captureRunPolicy.navigationPolicy.steps.length !== 0
          && this.navigationArmRecordSha256 === null
        )
      )
    ) {
      throw new Error("Baseline ownership requires the complete locked navigation transcript");
    }
    if (kind === "fidelity-accepted-owned") {
      if (this.acceptedRecordSha256 !== null) {
        throw new Error("Accepted ownership was already checkpointed");
      }
      if (this.witnessRecordSha256 === null) {
        throw new Error("Accepted ownership requires the durable controller witness");
      }
    }
    const identity = this.requireResolvedReceipt(value, `${kind} annotation`);
    const allowedPrevious = [identity.receiptRecordSha256];
    if (
      kind === "fidelity-baseline-owned"
      && identity.receiptRecordSha256 === this.lastResolvedReceipt.receiptRecordSha256
      && this.firstFrameRendererRecordSha256 !== null
    ) {
      allowedPrevious.push(this.firstFrameRendererRecordSha256);
    }
    if (!allowedPrevious.includes(this.lastRecordSha256)) {
      throw new Error(`${kind} must immediately annotate its resolved receipt`);
    }
    const artifacts = fidelityArtifacts(value);
    if (artifacts.gameFidelityOpaque.bytes !== 384) {
      throw new Error(`${kind} GameFidelityV1 opaque record must be exactly 384 bytes`);
    }
    if (artifacts.machineEvidenceOpaque.bytes !== 816) {
      throw new Error(`${kind} MachineEvidenceV1 opaque record must be exactly 816 bytes`);
    }
    const readbackMetadata = byteArtifact(
      value.readbackMetadata,
      `${kind} readback metadata`,
      1024 * 1024,
    );
    const rgba = byteArtifact(value.rgba, `${kind} RGBA`);
    if (kind === "fidelity-baseline-owned" && exactIdentity(identity, this.firstFrameReceipt)) {
      const readback = {
        readbackMetadataBytes: readbackMetadata.bytes,
        readbackMetadataSha256: readbackMetadata.sha256,
        rgbaBytes: rgba.bytes,
        rgbaSha256: rgba.sha256,
      };
      if (JSON.stringify(readback) !== JSON.stringify(this.firstFrameReadback)) {
        throw new Error("same-receipt Baseline did not reuse first-frame renderer ownership");
      }
    }
    const phase = kind === "fidelity-baseline-owned" ? 1 : 5;
    let requestedFields = {};
    if (kind === "fidelity-baseline-owned") {
      requestedFields = {
        requestedButtons: uint32(value.requestedButtons, "Baseline requested buttons"),
        requestedStickXyCxy: uint32(
          value.requestedStickXyCxy,
          "Baseline requested sticks",
        ),
        requestedTriggerLrab: uint32(
          value.requestedTriggerLrab,
          "Baseline requested triggers",
        ),
      };
    }
    const artifactFields = Object.freeze({
      gameFidelityEnvelopeBytes: artifacts.gameFidelityEnvelope.bytes,
      gameFidelityEnvelopeSha256: artifacts.gameFidelityEnvelope.sha256,
      gameFidelityOpaqueBytes: artifacts.gameFidelityOpaque.bytes,
      gameFidelityOpaqueSha256: artifacts.gameFidelityOpaque.sha256,
      machineEvidenceEnvelopeBytes: artifacts.machineEvidenceEnvelope.bytes,
      machineEvidenceEnvelopeSha256: artifacts.machineEvidenceEnvelope.sha256,
      machineEvidenceOpaqueBytes: artifacts.machineEvidenceOpaque.bytes,
      machineEvidenceOpaqueSha256: artifacts.machineEvidenceOpaque.sha256,
    });
    const ack = await this.append(kind, {
      machineSessionId: this.machineSessionId,
      ...identity,
      phase,
      ...artifactFields,
      ...requestedFields,
      readbackMetadataBytes: readbackMetadata.bytes,
      readbackMetadataSha256: readbackMetadata.sha256,
      rgbaBytes: rgba.bytes,
      rgbaSha256: rgba.sha256,
      ...(kind === "fidelity-accepted-owned"
        ? { witnessRecordSha256: this.witnessRecordSha256 }
        : {}),
    });
    this.throwIfFailed();
    if (kind === "fidelity-baseline-owned") {
      this.baselineRecordSha256 = ack.recordSha256;
      this.baselineRequestedController = Object.freeze(requestedFields);
    }
    else {
      this.acceptedRecordSha256 = ack.recordSha256;
      this.acceptedArtifacts = artifactFields;
    }
    return ack;
  }

  async firstFrameReportBound(value) {
    if (this.firstFrameRendererRecordSha256 === null) {
      throw new Error("first-frame report binding requires renderer ownership");
    }
    if (this.firstFrameReportRecordSha256 !== null) {
      throw new Error("first-frame report was already bound");
    }
    const report = byteArtifact(value.report, "canonical first-frame report", 16 * 1024 * 1024);
    const machineEvidenceEnvelope = byteArtifact(
      value.machineEvidenceEnvelope,
      "first-frame MachineEvidenceV1 envelope",
      16 * 1024,
    );
    const machineEvidenceOpaque = byteArtifact(
      value.machineEvidenceOpaque,
      "first-frame MachineEvidenceV1 opaque record",
      816,
    );
    if (machineEvidenceOpaque.bytes !== 816) {
      throw new Error("first-frame MachineEvidenceV1 opaque record must be exactly 816 bytes");
    }
    const ack = await this.append("first-frame-report-bound", {
      machineSessionId: this.machineSessionId,
      reportBytes: report.bytes,
      reportSha256: report.sha256,
      machineEvidenceEnvelopeBytes: machineEvidenceEnvelope.bytes,
      machineEvidenceEnvelopeSha256: machineEvidenceEnvelope.sha256,
      machineEvidenceOpaqueBytes: machineEvidenceOpaque.bytes,
      machineEvidenceOpaqueSha256: machineEvidenceOpaque.sha256,
      firstFrameRendererRecordSha256: this.firstFrameRendererRecordSha256,
      baselineRecordSha256: this.baselineRecordSha256,
    });
    this.throwIfFailed();
    this.firstFrameReportRecordSha256 = ack.recordSha256;
    return ack;
  }

  async navigationArmed(value) {
    if (this.firstFrameReportRecordSha256 === null) {
      throw new Error("navigation arm requires the durable first-frame report");
    }
    if (
      this.navigationArmRecordSha256 !== null
      || (
        this.baselineRecordSha256 !== null
        && this.captureRunPolicy.navigationPolicy.steps.length !== 0
      )
    ) {
      throw new Error("navigation arm was not one-shot before Baseline");
    }
    if (value.machineSessionId !== this.machineSessionId) {
      throw new Error("navigation arm changed the capture machine session");
    }
    const navigation = captureNavigationRuntime(
      value.navigation,
      this.captureRunPolicy,
      "navigation arm runtime",
    );
    const runSummary = captureRunSummary(
      value.runSummary,
      this.captureRunPolicy,
      "navigation arm cumulative run summary",
      false,
    );
    if (
      navigation.durableSteps !== 0
      || navigation.pendingPublication !== null
      || navigation.runCallOrigin !== runSummary.issuedRunCalls
      || navigation.canonicalCycleOrigin !== runSummary.canonicalCycle
      || runSummary.operatorPublications !== 0
      || runSummary.witnessPublications !== 0
    ) {
      throw new Error("navigation arm did not bind the first-frame scheduler authority");
    }
    const ack = await this.append("navigation-armed", {
      machineSessionId: this.machineSessionId,
      firstFrameReportRecordSha256: this.firstFrameReportRecordSha256,
      scriptSha256: navigation.scriptSha256,
      runCallOrigin: navigation.runCallOrigin,
      canonicalCycleOrigin: navigation.canonicalCycleOrigin,
      siPollIndexOrigin: navigation.siPollIndexOrigin,
      stepCount: navigation.stepCount,
      runSummary,
    });
    this.throwIfFailed();
    this.navigationArmRecordSha256 = ack.recordSha256;
    this.navigationRunCallOrigin = navigation.runCallOrigin;
    this.navigationCycleOrigin = navigation.canonicalCycleOrigin;
    return ack;
  }

  async navigationStepReceived(value) {
    if (this.firstFrameReportRecordSha256 === null || this.navigationArmRecordSha256 === null) {
      throw new Error("navigation SI receipt requires the durable first-frame report");
    }
    if (
      this.baselineRecordSha256 !== null
      || this.witnessRecordSha256 !== null
      || this.acceptedRecordSha256 !== null
    ) {
      throw new Error("navigation SI receipt must precede Baseline and the controller witness");
    }
    if (value.machineSessionId !== this.machineSessionId) {
      throw new Error("navigation SI receipt changed the capture machine session");
    }
    const policy = this.captureRunPolicy.navigationPolicy;
    const stepIndex = this.navigationTranscript.length;
    const expected = policy.steps[stepIndex];
    if (expected === undefined) {
      throw new Error("navigation SI receipt exceeded the locked script");
    }
    const navigation = captureNavigationRuntime(
      value.navigation,
      this.captureRunPolicy,
      "navigation SI receipt runtime",
    );
    const runCallOrigin = navigation.runCallOrigin;
    const canonicalCycleOrigin = navigation.canonicalCycleOrigin;
    if (this.navigationRunCallOrigin === null) {
      this.navigationRunCallOrigin = runCallOrigin;
      this.navigationCycleOrigin = canonicalCycleOrigin;
    } else if (
      runCallOrigin !== this.navigationRunCallOrigin
      || canonicalCycleOrigin !== this.navigationCycleOrigin
    ) {
      throw new Error("navigation SI receipt changed its armed origin");
    }
    const step = navigation.transcript.at(-1);
    if (
      navigation.durableSteps !== stepIndex + 1
      || JSON.stringify(navigation.transcript.slice(0, -1))
        !== JSON.stringify(this.navigationTranscript)
      || JSON.stringify(value.navigationStep) !== JSON.stringify(step)
      || step.minimumCanonicalDelay !== expected.minimumCanonicalDelay
    ) {
      throw new Error("navigation SI receipt changed its exact locked step");
    }
    const runSummary = captureRunSummary(
      value.runSummary,
      this.captureRunPolicy,
      "navigation cumulative run summary",
      false,
    );
    if (
      runSummary.operatorPublications !== stepIndex + 1
      || runSummary.witnessPublications !== 0
      || BigInt(runSummary.canonicalCycle) < BigInt(step.siObservedCycle)
      || runSummary.issuedRunCalls < runCallOrigin
    ) {
      throw new Error("navigation cumulative authority diverged from its SI receipt");
    }
    const durableStep = Object.freeze(structuredClone(step));
    const ack = await this.append("navigation-step-received", {
      machineSessionId: this.machineSessionId,
      firstFrameReportRecordSha256: this.firstFrameReportRecordSha256,
      navigationArmRecordSha256: this.navigationArmRecordSha256,
      scriptSha256: navigation.scriptSha256,
      runCallOrigin,
      canonicalCycleOrigin,
      ...durableStep,
      runSummary,
    });
    this.throwIfFailed();
    this.navigationTranscript.push(durableStep);
    this.navigationStepRecordSha256s.push(ack.recordSha256);
    return ack;
  }

  async controllerWitnessPublished(value) {
    if (this.baselineRecordSha256 === null || this.firstFrameReportRecordSha256 === null) {
      throw new Error("controller witness requires durable Baseline and first-frame report");
    }
    if (this.witnessRecordSha256 !== null) {
      throw new Error("controller witness was already checkpointed");
    }
    const navigation = captureNavigationRuntime(
      value.navigation,
      this.captureRunPolicy,
      "controller witness navigation runtime",
    );
    const runSummary = captureRunSummary(
      value.runSummary,
      this.captureRunPolicy,
      "controller witness cumulative run summary",
      false,
    );
    if (
      !navigation.complete
      || navigation.runCallOrigin !== (this.navigationRunCallOrigin ?? navigation.runCallOrigin)
      || navigation.canonicalCycleOrigin
        !== (this.navigationCycleOrigin ?? navigation.canonicalCycleOrigin)
      || JSON.stringify(navigation.transcript) !== JSON.stringify(this.navigationTranscript)
      || runSummary.operatorPublications !== navigation.durableSteps
      || runSummary.witnessPublications !== 1
    ) {
      throw new Error("controller witness lacked the complete durable navigation authority");
    }
    if (
      value.buttons !== this.baselineRequestedController?.requestedButtons
      || value.stickXyCxy !== this.baselineRequestedController?.requestedStickXyCxy
      || value.triggerLrab !== this.baselineRequestedController?.requestedTriggerLrab
    ) {
      throw new Error("controller witness differed from the durable Rust Baseline request");
    }
    const machineEvidenceEnvelope = byteArtifact(
      value.machineEvidenceEnvelope,
      "pre-witness MachineEvidenceV1 envelope",
      16 * 1024,
    );
    const machineEvidenceOpaque = byteArtifact(
      value.machineEvidenceOpaque,
      "pre-witness MachineEvidenceV1 opaque record",
      816,
    );
    if (machineEvidenceOpaque.bytes !== 816) {
      throw new Error("pre-witness MachineEvidenceV1 opaque record must be exactly 816 bytes");
    }
    const ack = await this.append("controller-witness-published", {
      machineSessionId: this.machineSessionId,
      baselineRecordSha256: this.baselineRecordSha256,
      firstFrameReportRecordSha256: this.firstFrameReportRecordSha256,
      sequenceLo: uint32(value.sequenceLo, "controller witness sequence low word"),
      sequenceHi: uint32(value.sequenceHi, "controller witness sequence high word"),
      buttons: uint32(value.buttons, "controller witness buttons"),
      stickXyCxy: uint32(value.stickXyCxy, "controller witness sticks"),
      triggerLrab: uint32(value.triggerLrab, "controller witness triggers"),
      status: positiveInteger(value.status, "controller witness status", 0xffff_ffff),
      machineEvidenceEnvelopeBytes: machineEvidenceEnvelope.bytes,
      machineEvidenceEnvelopeSha256: machineEvidenceEnvelope.sha256,
      machineEvidenceOpaqueBytes: machineEvidenceOpaque.bytes,
      machineEvidenceOpaqueSha256: machineEvidenceOpaque.sha256,
      navigationScriptSha256: navigation.scriptSha256,
      navigationStepCount: navigation.durableSteps,
      navigationArmRecordSha256: this.navigationArmRecordSha256,
      lastNavigationStepRecordSha256: this.navigationStepRecordSha256s.at(-1) ?? null,
      runSummary,
    });
    this.throwIfFailed();
    this.witnessRecordSha256 = ack.recordSha256;
    return ack;
  }

  async fidelityTerminal(value) {
    if (this.acceptedRecordSha256 === null || this.terminalRecordSha256 !== null) {
      throw new Error("terminal fidelity checkpoint is out of order");
    }
    if (this.lastRecordSha256 !== this.acceptedRecordSha256) {
      throw new Error("terminal fidelity checkpoint must immediately follow Accepted ownership");
    }
    const artifacts = fidelityArtifacts(value);
    if (artifacts.gameFidelityOpaque.bytes !== 384
        || artifacts.machineEvidenceOpaque.bytes !== 816) {
      throw new Error("terminal opaque fidelity ABI changed");
    }
    const artifactFields = {
      gameFidelityEnvelopeBytes: artifacts.gameFidelityEnvelope.bytes,
      gameFidelityEnvelopeSha256: artifacts.gameFidelityEnvelope.sha256,
      gameFidelityOpaqueBytes: artifacts.gameFidelityOpaque.bytes,
      gameFidelityOpaqueSha256: artifacts.gameFidelityOpaque.sha256,
      machineEvidenceEnvelopeBytes: artifacts.machineEvidenceEnvelope.bytes,
      machineEvidenceEnvelopeSha256: artifacts.machineEvidenceEnvelope.sha256,
      machineEvidenceOpaqueBytes: artifacts.machineEvidenceOpaque.bytes,
      machineEvidenceOpaqueSha256: artifacts.machineEvidenceOpaque.sha256,
    };
    if (JSON.stringify(artifactFields) !== JSON.stringify(this.acceptedArtifacts)) {
      throw new Error("terminal fidelity artifacts differ from the hard Accepted boundary");
    }
    const runSummary = captureRunSummary(
      value.runSummary,
      this.captureRunPolicy,
      "terminal cumulative run summary",
      true,
    );
    if (runSummary.issuedRunCalls <= 0 || runSummary.witnessPublications !== 1) {
      throw new Error("terminal cumulative run summary omitted run/witness authority");
    }
    const navigation = captureNavigationRuntime(
      value.navigation,
      this.captureRunPolicy,
      "terminal navigation runtime",
    );
    if (
      !navigation.complete
      || navigation.durableSteps !== runSummary.operatorPublications
      || JSON.stringify(navigation.transcript) !== JSON.stringify(this.navigationTranscript)
    ) {
      throw new Error("terminal navigation runtime differed from the durable transcript");
    }
    const ack = await this.append("fidelity-terminal", {
      machineSessionId: this.machineSessionId,
      phase: 5,
      baselineRecordSha256: this.baselineRecordSha256,
      acceptedRecordSha256: this.acceptedRecordSha256,
      ...artifactFields,
      runSummary,
      navigationScriptSha256: navigation.scriptSha256,
      navigationStepCount: navigation.durableSteps,
      navigationArmRecordSha256: this.navigationArmRecordSha256,
      lastNavigationStepRecordSha256: this.navigationStepRecordSha256s.at(-1) ?? null,
    });
    this.throwIfFailed();
    this.terminalRecordSha256 = ack.recordSha256;
    return ack;
  }

  throwIfFailed() {
    if (this.firstFailure !== null) throw this.firstFailure;
  }

  summary() {
    return Object.freeze({
      schema: FIDELITY_CHECKPOINT_SCHEMA,
      runId: this.runId,
      gameKey: this.gameKey,
      evidenceLockSha256: this.evidenceLockSha256,
      recordCap: this.recordCap,
      probeEventCap: this.probeEventCap,
      recordCount: this.clientSequence,
      probeEventCount: this.probeEvents,
      probeEventPerSubmissionCap: PROBE_EVENT_PER_SUBMISSION_CAP,
      maximumProbeEventsPerSubmission: this.maximumProbeEventsPerSubmission,
      probeRelayFailures: this.probeRelayFailures,
      kindCounts: Object.freeze({ ...this.kindCounts }),
      navigationStepRecords: this.navigationStepRecordSha256s.length,
      navigationArmRecordSha256: this.navigationArmRecordSha256,
      firstRecordSha256: this.firstRecordSha256,
      lastRecordSha256: this.lastRecordSha256,
      lastServerSequence: this.lastServerSequence,
      openSubmission: this.activeSubmission !== null,
      submissionReturned: this.submissionReturned,
      failure: this.firstFailure === null
        ? null
        : String(this.firstFailure?.stack ?? this.firstFailure),
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    const error = new Error("fidelity checkpoint client closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
