// SPDX-License-Identifier: GPL-3.0-only

import { validateRelease } from "../web/release.mjs";
import {
  compactPublicActiveRelease,
  validateCompactPublicActiveRelease,
} from "./browser_public_release_identity.mjs";

export {
  compactPublicActiveRelease,
  validateCompactPublicActiveRelease,
} from "./browser_public_release_identity.mjs";

export const PUBLIC_SCENARIO = "smb-ready-play";
export const PUBLIC_VIEWPORT = Object.freeze({
  deviceScaleFactor: 1,
  dontSetVisibleSize: false,
  height: 768,
  mobile: false,
  positionX: 0,
  positionY: 0,
  screenHeight: 768,
  screenWidth: 1024,
  width: 1024,
});

export const PUBLIC_RESIDENT_DIAGNOSTICS_SCHEMA =
  "lazuli-resident-frontend-diagnostics-v1";
export const PUBLIC_RESIDENT_POLICY = Object.freeze({
  maxBootReads: 8_192,
  cycleUpperCap: "8000000",
  blockUpperCap: 131_072,
  maxHostCalls: 64,
  maxColdInstalls: 4_096,
  zeroProgressSliceCap: 4_096,
  bootTimeoutMs: 180_000,
  sliceTimeoutMs: 180_000,
  closeTimeoutMs: 30_000,
  renderTimeoutMs: 180_000,
});

export class PublicResidentMilestonePendingError extends Error {
  constructor(path, detail) {
    super(`public resident milestone pending at ${path}: ${detail}`);
    this.name = "PublicResidentMilestonePendingError";
    this.path = path;
    this.detail = detail;
  }
}

export class PublicResidentProtocolError extends Error {
  constructor(path, detail) {
    super(`invalid public resident protocol at ${path}: ${detail}`);
    this.name = "PublicResidentProtocolError";
    this.path = path;
    this.detail = detail;
  }
}

const STALE_DOM_REFERENCE_ERRORS = [
  /(?:could not find|no) node with given id/i,
  /cannot find context with specified id/i,
  /document (?:was )?(?:updated|replaced)/i,
  /node with given id does not belong to the document/i,
];

const PUBLIC_RESIDENT_BINDING_SOURCE = `() => {
  const frame = document.querySelector("#app");
  const frameDocument = frame?.contentDocument ?? null;
  const frameWindow = frame?.contentWindow ?? null;
  if (frameDocument === null || frameWindow === null) return null;
  return {
    frameDocumentTimeOrigin: frameWindow.performance.timeOrigin,
    frameSource: frame.src,
    frameUrl: frameWindow.location.href,
    topDocumentTimeOrigin: performance.timeOrigin,
    topUrl: location.href,
  };
}`;

const PUBLIC_RESIDENT_STATE = `(() => {
  const residentBinding = ${PUBLIC_RESIDENT_BINDING_SOURCE};
  const frame = document.querySelector("#app");
  const status = document.querySelector("#status");
  const frameDocument = frame?.contentDocument ?? null;
  const frameWindow = frame?.contentWindow ?? null;
  const input = frameDocument?.querySelector("#disc-file") ?? null;
  const result = frameDocument?.querySelector("#result") ?? null;
  return {
    binding: residentBinding(),
    dataset: Object.fromEntries(Object.entries(frameDocument?.body?.dataset ?? {})),
    discStatus: frameDocument?.querySelector("#disc-status")?.textContent ?? null,
    frameHidden: frame?.hidden ?? null,
    frameReadyState: frameDocument?.readyState ?? null,
    hasDiscInput: frameWindow !== null && input instanceof frameWindow.HTMLInputElement,
    hasResult: frameWindow !== null && result instanceof frameWindow.HTMLElement,
    result: result?.textContent?.trim() ?? "",
    runnerAvailable: typeof frameWindow?.lazuliCycleRunner?.snapshot === "function",
    statusHidden: status?.hidden ?? null,
    surface: frameDocument?.querySelector(".shell")?.dataset.surface ?? null,
    topReadyState: document.readyState,
  };
})()`;

const PUBLIC_RESIDENT_DISC_INPUT = `(expectedBinding => {
  const residentBinding = ${PUBLIC_RESIDENT_BINDING_SOURCE};
  const binding = residentBinding();
  if (JSON.stringify(binding) !== JSON.stringify(expectedBinding)) {
    throw new Error("public resident document changed before disc assignment");
  }
  const frame = document.querySelector("#app");
  const frameDocument = frame?.contentDocument ?? null;
  const frameWindow = frame?.contentWindow ?? null;
  const input = frameDocument?.querySelector("#disc-file") ?? null;
  if (!(input instanceof frameWindow?.HTMLInputElement)) {
    throw new Error("public resident release has no file input");
  }
  return input;
})`;

const ACTIVATE_PUBLIC_RESIDENT_DISC = `(expectedBinding => {
  const residentBinding = ${PUBLIC_RESIDENT_BINDING_SOURCE};
  const binding = residentBinding();
  if (JSON.stringify(binding) !== JSON.stringify(expectedBinding)) {
    throw new Error("public resident document changed during disc assignment");
  }
  const frame = document.querySelector("#app");
  const frameDocument = frame?.contentDocument ?? null;
  const frameWindow = frame?.contentWindow ?? null;
  const input = frameDocument?.querySelector("#disc-file") ?? null;
  if (!(input instanceof frameWindow?.HTMLInputElement)) {
    throw new Error("public resident release has no file input to activate");
  }
  const fileCount = input.files?.length ?? 0;
  if (fileCount !== 1) {
    throw new Error("assigned public resident disc count is " + fileCount + ", expected 1");
  }
  const statusBefore = frameDocument.body?.dataset?.status ?? null;
  const discStatusBefore = frameDocument.querySelector("#disc-status")?.textContent ?? null;
  const alreadyActivated = (
    statusBefore === "loading"
    || statusBefore === "running"
    || statusBefore === "paused"
  ) && typeof discStatusBefore === "string" && discStatusBefore.startsWith("local: ");
  const dispatched = statusBefore === "waiting" && discStatusBefore === "open a disc";
  if (dispatched) input.dispatchEvent(new frameWindow.Event("change", { bubbles: true }));
  return { activated: dispatched || alreadyActivated, binding, dispatched, fileCount };
})`;

const CAPTURE_PUBLIC_RESIDENT_DIAGNOSTICS = `(async expectedBinding => {
  const residentBinding = ${PUBLIC_RESIDENT_BINDING_SOURCE};
  const frame = document.querySelector("#app");
  const frameDocument = frame?.contentDocument ?? null;
  const frameWindow = frame?.contentWindow ?? null;
  const result = frameDocument?.querySelector("#result") ?? null;
  const runner = frameWindow?.lazuliCycleRunner ?? null;
  const binding = residentBinding();
  if (JSON.stringify(binding) !== JSON.stringify(expectedBinding)) {
    throw new Error("public resident document changed before diagnostics");
  }
  if (!(result instanceof frameWindow?.HTMLElement)) {
    throw new Error("public resident release has no diagnostics result element");
  }
  if (typeof runner?.snapshot !== "function") {
    throw new Error("public resident release has no diagnostics runner");
  }
  const report = await runner.snapshot();
  if (
    document.querySelector("#app") !== frame
    || frame.contentDocument !== frameDocument
    || frame.contentWindow !== frameWindow
    || frameDocument.querySelector("#result") !== result
  ) {
    throw new Error("public resident frame or result changed during diagnostics");
  }
  const terminalBinding = residentBinding();
  if (JSON.stringify(terminalBinding) !== JSON.stringify(expectedBinding)) {
    throw new Error("public resident document changed during diagnostics");
  }
  let published;
  try {
    published = JSON.parse(result.textContent.trim());
  } catch (_error) {
    throw new Error("public resident diagnostics result is not JSON");
  }
  if (JSON.stringify(published) !== JSON.stringify(report)) {
    throw new Error("public resident diagnostics result does not match the runner report");
  }
  return { binding: terminalBinding, report, resultMatched: true };
})`;

const PUBLIC_RELEASE_STATE = `(() => {
  const frame = document.querySelector("#app");
  const status = document.querySelector("#status");
  const frameDocument = frame?.contentDocument ?? null;
  const frameWindow = frame?.contentWindow ?? null;
  if (frameDocument === null || frameWindow === null) {
    return {
      compatibilityDebugAvailable: false,
      compositorCaptureAvailable: false,
      dataset: {},
      diagnosticsCaptureAvailable: false,
      diagnosticsCaptureCompletedRequestId: null,
      diagnosticsCaptureDisabled: null,
      diagnosticsCaptureFailedRequestId: null,
      diagnosticsCaptureFailure: null,
      diagnosticsCaptureRequestId: null,
      diagnosticsCaptureState: null,
      discStatus: null,
      frameHidden: frame?.hidden ?? null,
      frameReadyState: null,
      frameUrl: null,
      hasDiscInput: false,
      result: "",
      runnerAvailable: false,
      statusHidden: status?.hidden ?? null,
      surface: null,
      topReadyState: document.readyState,
      topUrl: location.href,
      viewportCaptureMode: document.body?.dataset?.viewportCapture ?? null,
    };
  }
  const compositor = frameWindow.lazuliCompositorCapture;
  const compatibilityDebug = frameWindow.lazuliCompatibilityDebug;
  const diagnosticsCapture = frameDocument.querySelector("#capture-diagnostics");
  return {
    compatibilityDebugAvailable:
      typeof compatibilityDebug?.selectScenario === "function",
    compositorCaptureAvailable: compositor !== null
      && typeof compositor === "object"
      && typeof compositor.pending === "function"
      && typeof compositor.acknowledge === "function",
    dataset: Object.fromEntries(Object.entries(frameDocument.body?.dataset ?? {})),
    diagnosticsCaptureAvailable:
      diagnosticsCapture instanceof frameWindow.HTMLButtonElement,
    diagnosticsCaptureCompletedRequestId:
      diagnosticsCapture?.dataset.completedRequestId ?? null,
    diagnosticsCaptureDisabled: diagnosticsCapture?.disabled ?? null,
    diagnosticsCaptureFailedRequestId:
      diagnosticsCapture?.dataset.failedRequestId ?? null,
    diagnosticsCaptureFailure: diagnosticsCapture?.dataset.failure ?? null,
    diagnosticsCaptureRequestId: diagnosticsCapture?.dataset.requestId ?? null,
    diagnosticsCaptureState: diagnosticsCapture?.dataset.captureState ?? null,
    discStatus: frameDocument.querySelector("#disc-status")?.textContent ?? null,
    frameHidden: frame.hidden,
    frameReadyState: frameDocument.readyState,
    frameUrl: frameWindow.location.href,
    hasDiscInput: frameDocument.querySelector("#disc-file") instanceof frameWindow.HTMLInputElement,
    result: frameDocument.querySelector("#result")?.textContent?.trim() ?? "",
    runnerAvailable: typeof frameWindow.lazuliCycleRunner?.snapshot === "function",
    statusHidden: status?.hidden ?? null,
    surface: frameDocument.querySelector(".shell")?.dataset.surface ?? null,
    topReadyState: document.readyState,
    topUrl: location.href,
    viewportCaptureMode: document.body?.dataset?.viewportCapture ?? null,
  };
})()`;

const PUBLIC_DISC_INPUT = `(() => {
  const frame = document.querySelector("#app");
  return frame?.contentDocument?.querySelector("#disc-file") ?? null;
})()`;

const ACTIVATE_PUBLIC_DISC = `(() => {
  const frame = document.querySelector("#app");
  const frameDocument = frame?.contentDocument ?? null;
  const frameWindow = frame?.contentWindow ?? null;
  const input = frameDocument?.querySelector("#disc-file") ?? null;
  if (!(input instanceof frameWindow?.HTMLInputElement)) {
    throw new Error("public release has no file input to activate");
  }
  const fileCount = input.files?.length ?? 0;
  if (fileCount !== 1) {
    throw new Error("assigned public disc count is " + fileCount + ", expected 1");
  }
  const statusBefore = frameDocument.body?.dataset?.status ?? null;
  const discStatusBefore = frameDocument.querySelector("#disc-status")?.textContent ?? null;
  const dispatched = (statusBefore === null || statusBefore === "waiting")
    && discStatusBefore === "open a disc";
  if (dispatched) input.dispatchEvent(new frameWindow.Event("change", { bubbles: true }));
  return { dispatched, fileCount };
})()`;

const CONFIGURE_PUBLIC_COMPATIBILITY_DEBUG = `(request => {
  const frame = document.querySelector("#app");
  const frameWindow = frame?.contentWindow ?? null;
  const control = frameWindow?.lazuliCompatibilityDebug ?? null;
  if (typeof control?.selectScenario !== "function") {
    throw new Error("public release has no compatibility debug control");
  }
  const selection = control.selectScenario(request.scenario);
  if (request.viewportCapture) {
    document.body.dataset.viewportCapture = "enabled";
  } else {
    delete document.body.dataset.viewportCapture;
  }
  return {
    scenario: selection?.scenario ?? null,
    viewportCaptureMode: document.body.dataset.viewportCapture ?? null,
  };
})`;

const REQUEST_PUBLIC_SNAPSHOT = `(() => {
  const frame = document.querySelector("#app");
  const frameDocument = frame?.contentDocument ?? null;
  const frameWindow = frame?.contentWindow ?? null;
  const button = frameDocument?.querySelector("#capture-diagnostics") ?? null;
  if (!(button instanceof frameWindow?.HTMLButtonElement) || button.disabled) return false;
  button.click();
  const requestId = Number(button.dataset.requestId);
  return {
    disabled: button.disabled,
    requestId: Number.isSafeInteger(requestId) ? requestId : null,
    state: button.dataset.captureState ?? null,
  };
})()`;

const PUBLIC_ACTIVE_RELEASE_OBSERVATION = `(async () => {
  const controlled = typeof navigator.serviceWorker === "object"
    && navigator.serviceWorker.controller !== null;
  try {
    const response = await fetch("/.gekko/active-release", { cache: "no-store" });
    return {
      body: await response.text(),
      controlled,
      error: null,
      pathname: location.pathname,
      status: response.status,
    };
  } catch (error) {
    return {
      body: null,
      controlled,
      error: String(error),
      pathname: location.pathname,
      status: null,
    };
  }
})()`;

export function publicDelay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function parsePublicReport(text) {
  if (typeof text !== "string" || !text.startsWith("{")) return null;
  try {
    const report = JSON.parse(text);
    return report !== null && typeof report === "object" && !Array.isArray(report)
      ? report
      : null;
  } catch {
    return null;
  }
}

function residentFailure(path, detail) {
  throw new PublicResidentProtocolError(path, detail);
}

function residentPending(path, detail) {
  throw new PublicResidentMilestonePendingError(path, detail);
}

function residentObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    residentFailure(path, "expected an object");
  }
  return value;
}

function residentExactKeys(value, keys, path) {
  const observed = Object.keys(residentObject(value, path)).sort();
  const expected = [...keys].sort();
  if (
    observed.length !== expected.length
    || observed.some((key, index) => key !== expected[index])
  ) {
    residentFailure(path, `keys must be ${expected.join(", ")}; got ${observed.join(", ")}`);
  }
  return value;
}

function residentJsonEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => residentJsonEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && residentJsonEqual(left[key], right[key])
    ));
}

function residentExactJson(value, expected, path) {
  if (!residentJsonEqual(value, expected)) {
    residentFailure(path, "does not match the frozen resident contract");
  }
  return value;
}

function residentCounter(value, path, { positive = false } = {}) {
  if (
    !Number.isSafeInteger(value)
    || value < (positive ? 1 : 0)
  ) {
    residentFailure(path, positive
      ? "expected a positive safe integer"
      : "expected a nonnegative safe integer");
  }
  return value;
}

function residentCanonicalDecimal(value, path) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    residentFailure(path, "expected a canonical unsigned decimal string");
  }
  return BigInt(value);
}

function residentBoolean(value, path) {
  if (typeof value !== "boolean") residentFailure(path, "expected a boolean");
  return value;
}

export function assertNoPublicResidentExceptions(
  value,
  path = "$.devtoolsExceptions",
) {
  if (!Array.isArray(value)) residentFailure(path, "expected an exception array");
  if (value.length !== 0) {
    residentFailure(path, `expected no exceptions; got ${JSON.stringify(value)}`);
  }
  return value;
}

function assertPublicResidentSessionExceptions(session) {
  return assertNoPublicResidentExceptions(session?.exceptions, "$.devtoolsExceptions");
}

export function validatePublicResidentDocumentBinding(
  value,
  {
    expectedBinding = null,
    expectedFrameUrl = null,
    path = "$.binding",
    publicUrl,
  },
) {
  residentExactKeys(value, [
    "frameDocumentTimeOrigin",
    "frameSource",
    "frameUrl",
    "topDocumentTimeOrigin",
    "topUrl",
  ], path);
  if (value.topUrl !== publicUrl) residentFailure(`${path}.topUrl`, `expected ${publicUrl}`);
  if (expectedFrameUrl !== null && value.frameUrl !== expectedFrameUrl) {
    residentFailure(`${path}.frameUrl`, `expected ${expectedFrameUrl}`);
  }
  if (value.frameSource !== value.frameUrl) {
    residentFailure(`${path}.frameSource`, "does not match the live iframe document URL");
  }
  let top;
  let frame;
  try {
    top = new URL(value.topUrl);
    frame = new URL(value.frameUrl);
  } catch {
    residentFailure(path, "contains an invalid document URL");
  }
  if (top.origin !== frame.origin) {
    residentFailure(`${path}.frameUrl`, "expected a same-origin resident frontend");
  }
  for (const name of ["topDocumentTimeOrigin", "frameDocumentTimeOrigin"]) {
    if (!Number.isFinite(value[name]) || value[name] <= 0) {
      residentFailure(`${path}.${name}`, "expected a positive document time origin");
    }
  }
  if (expectedBinding !== null && !residentJsonEqual(value, expectedBinding)) {
    residentFailure(path, "resident document identity changed");
  }
  return value;
}

function validatePublicResidentRenderer(value, path) {
  residentExactKeys(value, ["diagnostics", "hasPresentedXfb", "hostDiagnostics"], path);
  residentBoolean(value.hasPresentedXfb, `${path}.hasPresentedXfb`);
  residentObject(value.diagnostics, `${path}.diagnostics`);
  residentObject(value.hostDiagnostics, `${path}.hostDiagnostics`);
  residentCounter(value.diagnostics.presentXfbCalls, `${path}.diagnostics.presentXfbCalls`);
  return value;
}

function validatePublicResidentTotals(value, path) {
  residentExactKeys(value, [
    "rustSlices",
    "hostCallCapBoundaries",
    "coldInstallCapBoundaries",
    "hostCalls",
    "coldInstalls",
    "executedCycles",
    "executedInstructions",
    "zeroProgressSlices",
    "maximumConsecutiveZeroProgressSlices",
    "consecutiveZeroProgressSlices",
    "outcomeDetails",
  ], path);
  for (const name of [
    "rustSlices",
    "hostCallCapBoundaries",
    "coldInstallCapBoundaries",
    "hostCalls",
    "coldInstalls",
    "zeroProgressSlices",
    "maximumConsecutiveZeroProgressSlices",
    "consecutiveZeroProgressSlices",
  ]) {
    residentCounter(value[name], `${path}.${name}`);
  }
  if (value.maximumConsecutiveZeroProgressSlices > value.zeroProgressSlices) {
    residentFailure(
      `${path}.maximumConsecutiveZeroProgressSlices`,
      "exceeds the zero-progress slice total",
    );
  }
  if (value.consecutiveZeroProgressSlices > value.maximumConsecutiveZeroProgressSlices) {
    residentFailure(
      `${path}.consecutiveZeroProgressSlices`,
      "exceeds the maximum consecutive zero-progress total",
    );
  }
  if (value.zeroProgressSlices > value.rustSlices) {
    residentFailure(`${path}.zeroProgressSlices`, "exceeds the Rust slice total");
  }
  const cycles = residentCanonicalDecimal(value.executedCycles, `${path}.executedCycles`);
  const instructions = residentCanonicalDecimal(
    value.executedInstructions,
    `${path}.executedInstructions`,
  );
  const details = residentObject(value.outcomeDetails, `${path}.outcomeDetails`);
  let detailedSlices = 0;
  for (const [detail, count] of Object.entries(details)) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(detail) || BigInt(detail) > 0xffff_ffffn) {
      residentFailure(`${path}.outcomeDetails`, `invalid Rust outcome detail ${detail}`);
    }
    residentCounter(count, `${path}.outcomeDetails.${detail}`, { positive: true });
    detailedSlices += count;
    if (!Number.isSafeInteger(detailedSlices)) {
      residentFailure(`${path}.outcomeDetails`, "Rust outcome counts overflowed");
    }
  }
  if (detailedSlices !== value.rustSlices) {
    residentFailure(`${path}.outcomeDetails`, "does not account for every Rust slice");
  }
  if (cycles === 0n && instructions !== 0n) {
    residentFailure(path, "positive instructions cannot accompany zero executed cycles");
  }
  return { cycles, instructions };
}

function validatePublicResidentMachineDiagnostics(value, release, boot, path) {
  residentExactKeys(value, [
    "booted",
    "memoryPages",
    "totalBootReads",
    "totalDiReads",
    "totalRenderCalls",
    "totalColdInstalls",
    "pendingControllerSample",
    "totalControllerRetries",
    "tableSlots",
    "machineEvidence",
  ], path);
  if (value.booted !== true) residentFailure(`${path}.booted`, "expected committed boot state");
  if (
    !Number.isSafeInteger(value.memoryPages)
    || value.memoryPages < release.runtime.abi.memoryInitialPages
    || value.memoryPages > release.runtime.abi.memoryMaximumPages
  ) {
    residentFailure(`${path}.memoryPages`, "outside the authenticated runtime ABI range");
  }
  for (const name of [
    "totalBootReads",
    "totalDiReads",
    "totalRenderCalls",
    "totalColdInstalls",
    "totalControllerRetries",
  ]) {
    residentCounter(value[name], `${path}.${name}`);
  }
  if (value.totalBootReads < boot.reads) {
    residentFailure(`${path}.totalBootReads`, "is less than the committed boot read count");
  }
  residentBoolean(value.pendingControllerSample, `${path}.pendingControllerSample`);
  residentCounter(value.tableSlots, `${path}.tableSlots`, { positive: true });
  const evidencePath = `${path}.machineEvidence`;
  residentExactKeys(value.machineEvidence, ["available", "bytes", "encoding", "payload"], evidencePath);
  residentBoolean(value.machineEvidence.available, `${evidencePath}.available`);
  const expectedBytes = release.runtime.abi.machineEvidenceBytes;
  if (value.machineEvidence.bytes !== expectedBytes) {
    residentFailure(`${evidencePath}.bytes`, `expected authenticated ABI length ${expectedBytes}`);
  }
  if (value.machineEvidence.encoding !== "base64") {
    residentFailure(`${evidencePath}.encoding`, "expected base64 opaque evidence");
  }
  if (value.machineEvidence.available) {
    const expectedCharacters = Math.ceil(expectedBytes / 3) * 4;
    if (
      typeof value.machineEvidence.payload !== "string"
      || value.machineEvidence.payload.length !== expectedCharacters
      || !/^(?:[A-Za-z0-9+/]{4})*$/.test(value.machineEvidence.payload)
    ) {
      residentFailure(`${evidencePath}.payload`, "opaque evidence length or alphabet changed");
    }
  } else if (value.machineEvidence.payload !== null) {
    residentFailure(`${evidencePath}.payload`, "unavailable evidence must be null");
  }
  return value;
}

export function validatePublicResidentDiagnosticCapture(
  value,
  {
    expectedBinding,
    expectedFrameUrl,
    path = "$",
    publicUrl,
    release,
  },
) {
  validateCompactPublicActiveRelease(release, { path: `${path}.release` });
  residentExactKeys(value, ["binding", "report", "resultMatched"], path);
  validatePublicResidentDocumentBinding(value.binding, {
    expectedBinding,
    expectedFrameUrl,
    path: `${path}.binding`,
    publicUrl,
  });
  if (value.resultMatched !== true) {
    residentFailure(`${path}.resultMatched`, "runner report was not the same result element JSON");
  }
  const reportPath = `${path}.report`;
  const report = residentExactKeys(value.report, [
    "schema",
    "status",
    "policy",
    "runtime",
    "session",
    "renderer",
    "capabilityBoundary",
  ], reportPath);
  if (report.schema !== PUBLIC_RESIDENT_DIAGNOSTICS_SCHEMA) {
    residentFailure(`${reportPath}.schema`, `expected ${PUBLIC_RESIDENT_DIAGNOSTICS_SCHEMA}`);
  }
  residentExactJson(report.policy, PUBLIC_RESIDENT_POLICY, `${reportPath}.policy`);
  residentExactJson(report.runtime, release.runtime, `${reportPath}.runtime`);
  residentExactJson(report.capabilityBoundary, {
    rawDiscBytesOnly: true,
    opaqueRendererRequestsAndReceipts: true,
    opaqueMachineEvidence: true,
    javascriptDispatchTableSets: 0,
    javascriptGuestMemoryReads: 0,
  }, `${reportPath}.capabilityBoundary`);
  const renderer = validatePublicResidentRenderer(report.renderer, `${reportPath}.renderer`);

  if (report.session === null) {
    if (report.status !== "waiting") {
      residentFailure(`${reportPath}.status`, "sessionless diagnostics must be waiting");
    }
    residentPending(`${reportPath}.session`, "disc session has not started");
  }
  const sessionPath = `${reportPath}.session`;
  const session = residentExactKeys(report.session, [
    "state",
    "label",
    "boot",
    "totals",
    "diagnostics",
    "failure",
  ], sessionPath);
  if (typeof session.label !== "string" || !session.label.startsWith("local: ")) {
    residentFailure(`${sessionPath}.label`, "expected a local opaque disc label");
  }
  if (session.failure !== null) {
    residentFailure(`${sessionPath}.failure`, `resident session failed: ${String(session.failure)}`);
  }
  if (report.status !== session.state) {
    residentFailure(`${reportPath}.status`, "does not match the resident session state");
  }
  const progress = validatePublicResidentTotals(session.totals, `${sessionPath}.totals`);
  if (session.state === "created" || session.state === "booting") {
    residentPending(`${sessionPath}.state`, `resident session is ${session.state}`);
  }
  if (session.state !== "running" && session.state !== "paused") {
    residentFailure(`${sessionPath}.state`, `resident session is terminal (${String(session.state)})`);
  }
  const boot = residentExactKeys(session.boot, ["reads", "status"], `${sessionPath}.boot`);
  if (boot.status !== 3) residentFailure(`${sessionPath}.boot.status`, "boot did not commit");
  residentCounter(boot.reads, `${sessionPath}.boot.reads`, { positive: true });
  if (boot.reads > PUBLIC_RESIDENT_POLICY.maxBootReads) {
    residentFailure(`${sessionPath}.boot.reads`, "exceeded the frozen boot read cap");
  }
  const diagnostics = validatePublicResidentMachineDiagnostics(
    session.diagnostics,
    release,
    boot,
    `${sessionPath}.diagnostics`,
  );

  if (session.totals.rustSlices === 0) {
    residentPending(`${sessionPath}.totals.rustSlices`, "no Rust slice completed");
  }
  if (progress.cycles === 0n || progress.instructions === 0n) {
    residentPending(`${sessionPath}.totals`, "Rust execution has not made positive progress");
  }
  if (!diagnostics.machineEvidence.available) {
    residentPending(`${sessionPath}.diagnostics.machineEvidence`, "opaque evidence is unavailable");
  }
  if (!renderer.hasPresentedXfb) {
    residentPending(`${reportPath}.renderer.hasPresentedXfb`, "no XFB has been presented");
  }
  if (renderer.diagnostics.presentXfbCalls === 0) {
    residentFailure(
      `${reportPath}.renderer.diagnostics.presentXfbCalls`,
      "presented XFB has no presentation call",
    );
  }
  if (diagnostics.totalRenderCalls === 0) {
    residentFailure(`${sessionPath}.diagnostics.totalRenderCalls`, "presentation has no machine render call");
  }
  return value;
}

export async function publicPageTarget(endpoint) {
  const response = await fetch(new URL("/json/list", endpoint));
  if (!response.ok) throw new Error(`Chrome target list returned HTTP ${response.status}`);
  const targets = await response.json();
  const page = targets.find(target => target.type === "page" && target.webSocketDebuggerUrl);
  if (page === undefined) throw new Error("Chrome exposes no debuggable page target");
  return page;
}

export function expectedPublicFrameUrl(publicUrl, release) {
  const top = new URL(publicUrl);
  const frame = new URL(release.frontend.url, top);
  frame.search = "";
  frame.hash = "";
  return frame.href;
}

export async function publicReleaseState(session) {
  return session.evaluate(PUBLIC_RELEASE_STATE);
}

export async function publicResidentState(session) {
  assertPublicResidentSessionExceptions(session);
  const state = await session.evaluate(PUBLIC_RESIDENT_STATE);
  assertPublicResidentSessionExceptions(session);
  return state;
}

export async function waitForPublicResidentRelease(
  session,
  {
    deadline,
    expectedBinding = null,
    expectedFrameUrl = null,
    pollMs,
    publicUrl,
  },
) {
  let state = null;
  while (Date.now() < deadline) {
    state = await publicResidentState(session);
    const failedReport = parsePublicReport(state?.result ?? "");
    if (
      state?.dataset?.renderer === "unavailable"
      || state?.dataset?.status === "stopped"
      || failedReport?.status === "failed"
    ) {
      throw new Error(`public resident release failed during readiness: ${JSON.stringify(state)}`);
    }
    if (
      state?.topReadyState === "complete"
      && state.frameReadyState === "complete"
      && state.frameHidden === false
      && state.statusHidden === true
      && state.hasDiscInput
      && state.hasResult
      && state.runnerAvailable
      && state.surface === "release"
      && state.dataset?.renderer === "wgpu-webgpu"
      && state.dataset?.status === "waiting"
      && state.discStatus === "open a disc"
    ) {
      validatePublicResidentDocumentBinding(state.binding, {
        expectedBinding,
        expectedFrameUrl,
        path: "$.state.binding",
        publicUrl,
      });
      return state;
    }
    await publicDelay(pollMs);
  }
  throw new Error(`public resident release did not become ready: ${JSON.stringify(state)}`);
}

export async function assignPublicResidentDisc(
  session,
  discPath,
  {
    deadline,
    expectedBinding,
    expectedFrameUrl,
    pollMs,
    publicUrl,
  },
) {
  validatePublicResidentDocumentBinding(expectedBinding, {
    expectedBinding: null,
    expectedFrameUrl,
    path: "$.expectedBinding",
    publicUrl,
  });
  while (Date.now() < deadline) {
    assertPublicResidentSessionExceptions(session);
    const input = await session.send("Runtime.evaluate", {
      expression: `${PUBLIC_RESIDENT_DISC_INPUT}(${JSON.stringify(expectedBinding)})`,
      returnByValue: false,
    });
    if (input.exceptionDetails !== undefined) {
      throw new Error(
        `public resident disc input evaluation failed: ${JSON.stringify(input.exceptionDetails)}`,
      );
    }
    const objectId = input.result?.objectId;
    if (typeof objectId !== "string") {
      await publicDelay(pollMs);
      continue;
    }
    try {
      await session.send("DOM.setFileInputFiles", {
        files: [discPath],
        objectId,
      });
    } catch (error) {
      if (!isStaleDomReferenceError(error)) {
        throw new Error(`could not assign public resident disc image: ${error.message ?? String(error)}`);
      }
      await publicDelay(pollMs);
      continue;
    } finally {
      await session.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
    const activation = await session.evaluate(
      `${ACTIVATE_PUBLIC_RESIDENT_DISC}(${JSON.stringify(expectedBinding)})`,
    );
    assertPublicResidentSessionExceptions(session);
    residentExactKeys(
      activation,
      ["activated", "binding", "dispatched", "fileCount"],
      "$.activation",
    );
    validatePublicResidentDocumentBinding(activation.binding, {
      expectedBinding,
      expectedFrameUrl,
      path: "$.activation.binding",
      publicUrl,
    });
    if (
      activation.fileCount !== 1
      || activation.activated !== true
      || typeof activation.dispatched !== "boolean"
    ) {
      throw new Error(`public resident disc did not activate: ${JSON.stringify(activation)}`);
    }
    return activation;
  }
  throw new Error("public resident release file input did not accept the disc image");
}

export async function capturePublicResidentDiagnostics(
  session,
  {
    expectedBinding,
    expectedFrameUrl,
    publicUrl,
    release,
  },
) {
  assertPublicResidentSessionExceptions(session);
  const capture = await session.evaluate(
    `${CAPTURE_PUBLIC_RESIDENT_DIAGNOSTICS}(${JSON.stringify(expectedBinding)})`,
  );
  assertPublicResidentSessionExceptions(session);
  return validatePublicResidentDiagnosticCapture(capture, {
    expectedBinding,
    expectedFrameUrl,
    publicUrl,
    release,
  });
}

export async function waitForPublicResidentFirstXfb(
  session,
  {
    deadline,
    expectedBinding,
    expectedFrameUrl,
    pollMs,
    publicUrl,
    release,
  },
) {
  let pending = null;
  while (Date.now() < deadline) {
    try {
      return await capturePublicResidentDiagnostics(session, {
        expectedBinding,
        expectedFrameUrl,
        publicUrl,
        release,
      });
    } catch (error) {
      if (!(error instanceof PublicResidentMilestonePendingError)) throw error;
      pending = error;
    }
    await publicDelay(pollMs);
  }
  const suffix = pending === null ? "no resident diagnostics were captured" : pending.message;
  throw new Error(`public resident first-XFB milestone did not arrive: ${suffix}`);
}

function compactPublicResidentFrame(value) {
  return {
    frameId: value.id,
    loaderId: value.loaderId,
    url: value.url,
  };
}

function publicResidentChildFrames(frameTree) {
  const frames = [];
  for (const child of frameTree?.childFrames ?? []) {
    if (child?.frame !== undefined) frames.push(child.frame);
    frames.push(...publicResidentChildFrames(child));
  }
  return frames;
}

export async function observePublicResidentNavigation(
  session,
  {
    expectedFrameUrl,
    expectedTopLoaderId,
    publicUrl,
  },
) {
  assertPublicResidentSessionExceptions(session);
  const tree = await session.send("Page.getFrameTree");
  assertPublicResidentSessionExceptions(session);
  const top = tree.frameTree?.frame;
  if (
    typeof top?.id !== "string"
    || top.id.length === 0
    || typeof top.loaderId !== "string"
    || top.loaderId !== expectedTopLoaderId
    || top.url !== publicUrl
  ) {
    throw new Error(`public resident top-level loader is not pinned: ${JSON.stringify(top)}`);
  }
  const matches = publicResidentChildFrames(tree.frameTree)
    .filter(frame => frame?.url === expectedFrameUrl);
  if (
    matches.length !== 1
    || typeof matches[0]?.id !== "string"
    || matches[0].id.length === 0
    || typeof matches[0].loaderId !== "string"
    || matches[0].loaderId.length === 0
  ) {
    throw new Error(
      `public resident immutable frontend loader is not uniquely pinned: ${JSON.stringify(matches)}`,
    );
  }
  return {
    top: compactPublicResidentFrame(top),
    frame: compactPublicResidentFrame(matches[0]),
  };
}

export async function waitForPublicRelease(
  session,
  { deadline, expectedFrameUrl = null, pollMs, publicUrl },
) {
  let state = null;
  while (Date.now() < deadline) {
    state = await publicReleaseState(session);
    if (
      state.topUrl === publicUrl
      && state.topReadyState === "complete"
      && state.compatibilityDebugAvailable
      && state.diagnosticsCaptureAvailable
      && state.diagnosticsCaptureDisabled === true
      && state.diagnosticsCaptureState === "unavailable"
      && state.frameReadyState === "complete"
      && state.frameHidden === false
      && state.statusHidden === true
      && state.hasDiscInput
      && state.surface === "release"
      && state.dataset.renderer === "wgpu-webgpu"
      && (expectedFrameUrl === null || state.frameUrl === expectedFrameUrl)
    ) return state;
    await publicDelay(pollMs);
  }
  throw new Error(`public release did not become ready: ${JSON.stringify(state)}`);
}

export async function configurePublicCompatibilityDebug(
  session,
  { scenario, viewportCapture = false },
) {
  if (
    scenario !== "smb-ready-play"
    && scenario !== "smb-sustained-play"
  ) {
    throw new Error("public compatibility debug scenario is unsupported");
  }
  if (typeof viewportCapture !== "boolean") {
    throw new Error("public compatibility viewport capture flag must be boolean");
  }
  const request = { scenario, viewportCapture };
  const configured = await session.evaluate(
    `${CONFIGURE_PUBLIC_COMPATIBILITY_DEBUG}(${JSON.stringify(request)})`,
  );
  if (
    configured?.scenario !== scenario
    || configured?.viewportCaptureMode !== (viewportCapture ? "enabled" : null)
  ) {
    throw new Error(`public compatibility debug control failed: ${JSON.stringify(configured)}`);
  }
  return configured;
}

function isStaleDomReferenceError(error) {
  const message = error?.message ?? String(error);
  return STALE_DOM_REFERENCE_ERRORS.some(pattern => pattern.test(message));
}

export async function assignPublicDisc(
  session,
  discPath,
  { deadline, label = "disc image", pollMs },
) {
  while (Date.now() < deadline) {
    const input = await session.send("Runtime.evaluate", {
      expression: PUBLIC_DISC_INPUT,
      returnByValue: false,
    });
    const objectId = input.result?.objectId;
    if (typeof objectId !== "string") {
      await publicDelay(pollMs);
      continue;
    }
    try {
      await session.send("DOM.setFileInputFiles", {
        files: [discPath],
        objectId,
      });
    } catch (error) {
      if (!isStaleDomReferenceError(error)) {
        throw new Error(`could not assign public ${label}: ${error.message ?? String(error)}`);
      }
      await publicDelay(pollMs);
      continue;
    } finally {
      await session.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
    const activation = await session.evaluate(ACTIVATE_PUBLIC_DISC);
    if (activation?.fileCount === 1) return activation;
    await publicDelay(pollMs);
  }
  throw new Error(`public release file input did not accept the ${label}`);
}

export async function waitForPublicRunner(
  session,
  { deadline, pollMs, stoppedLabel = "disc" },
) {
  let state = null;
  while (Date.now() < deadline) {
    state = await publicReleaseState(session);
    const report = parsePublicReport(state.result);
    if (
      report?.status === "stopped"
      || (report?.error !== undefined && report.error !== null)
    ) {
      throw new Error(`public ${stoppedLabel} boot stopped: ${JSON.stringify(report)}`);
    }
    if (
      state.dataset.status === "running"
      && state.dataset.renderer === "wgpu-webgpu"
      && state.discStatus?.startsWith("local: ")
      && state.diagnosticsCaptureAvailable
      && state.diagnosticsCaptureDisabled === false
      && state.diagnosticsCaptureState === "ready"
      && state.runnerAvailable
    ) return state;
    await publicDelay(pollMs);
  }
  throw new Error(`public ${stoppedLabel} runner did not start: ${JSON.stringify(state)}`);
}

export async function requestPublicSnapshot(session) {
  const request = await session.evaluate(REQUEST_PUBLIC_SNAPSHOT);
  if (
    request?.disabled !== true
    || !Number.isSafeInteger(request.requestId)
    || request.requestId <= 0
    || request.state !== "pending"
  ) {
    throw new Error(`public diagnostics request failed: ${JSON.stringify(request)}`);
  }
  return request.requestId;
}

export async function waitForPublicSnapshot(session, { deadline, pollMs, requestId }) {
  if (!Number.isSafeInteger(requestId) || requestId <= 0) {
    throw new Error("public diagnostics request ID is invalid");
  }
  const requestIdText = String(requestId);
  let state = null;
  while (Date.now() < deadline) {
    state = await publicReleaseState(session);
    const report = parsePublicReport(state.result);
    if (
      state.diagnosticsCaptureState === "failed"
      && state.diagnosticsCaptureFailedRequestId === requestIdText
    ) {
      throw new Error(
        `public diagnostics request ${requestId} failed: `
          + `${state.diagnosticsCaptureFailure ?? "unknown capture failure"}`,
      );
    }
    if (
      report?.status === "stopped"
      || (report?.error !== undefined && report.error !== null)
    ) {
      throw new Error(
        `public diagnostics request ${requestId} stopped: ${JSON.stringify(report)}`,
      );
    }
    if (
      state.diagnosticsCaptureRequestId !== null
      && Number(state.diagnosticsCaptureRequestId) > requestId
    ) {
      throw new Error(`public diagnostics request ${requestId} was superseded`);
    }
    if (
      report?.stage === "snapshot"
      && report.diagnosticsRequestId === requestId
      && state.diagnosticsCaptureState === "complete"
      && state.diagnosticsCaptureCompletedRequestId === requestIdText
      && state.diagnosticsCaptureDisabled === false
    ) {
      return { report, state };
    }
    await publicDelay(pollMs);
  }
  throw new Error(`public snapshot did not arrive: ${JSON.stringify(state)}`);
}

export async function validateObservedPublicActiveRelease(
  observation,
  { expectCommit = null, expectReleaseId = null, publicUrl },
  expectedIdentity = null,
) {
  if (observation === null || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error("public active release observation is invalid");
  }
  if (!observation.controlled) {
    throw new Error("public page has no service-worker controller");
  }
  if (observation.error !== null) {
    throw new Error(`public active release observation failed: ${observation.error}`);
  }
  if (observation.status !== 200) {
    throw new Error(`public active release observer returned HTTP ${observation.status}`);
  }
  if (observation.pathname !== new URL(publicUrl).pathname) {
    throw new Error("public active release was observed from the wrong top-level path");
  }
  let manifest;
  try {
    manifest = JSON.parse(observation.body);
  } catch {
    throw new Error("public active release observer returned invalid JSON");
  }
  await validateRelease(manifest);
  const identity = compactPublicActiveRelease(manifest);
  validateCompactPublicActiveRelease(identity);
  if (expectCommit !== null && identity.commit !== expectCommit) {
    throw new Error(
      `public active release commit ${identity.commit} does not match ${expectCommit}`,
    );
  }
  if (expectReleaseId !== null && identity.releaseId !== expectReleaseId) {
    throw new Error(
      `public active release ID ${identity.releaseId} does not match ${expectReleaseId}`,
    );
  }
  if (
    expectedIdentity !== null
    && JSON.stringify(identity) !== JSON.stringify(expectedIdentity)
  ) {
    throw new Error(`public active release changed during observation: ${JSON.stringify({
      before: expectedIdentity,
      terminal: identity,
    })}`);
  }
  return identity;
}

export async function observePublicActiveRelease(
  session,
  options,
  expectedIdentity = null,
) {
  return validateObservedPublicActiveRelease(
    await session.evaluate(PUBLIC_ACTIVE_RELEASE_OBSERVATION),
    options,
    expectedIdentity,
  );
}

export async function configurePublicViewport(session) {
  await session.send("Page.bringToFront");
  await session.send("Emulation.setDeviceMetricsOverride", PUBLIC_VIEWPORT);
}

export async function clearPublicViewport(session) {
  await session.send("Emulation.clearDeviceMetricsOverride");
}
