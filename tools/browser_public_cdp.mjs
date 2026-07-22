// SPDX-License-Identifier: GPL-3.0-only

import { validateRelease } from "../web/release.mjs";

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

const STALE_DOM_REFERENCE_ERRORS = [
  /(?:could not find|no) node with given id/i,
  /cannot find context with specified id/i,
  /document (?:was )?(?:updated|replaced)/i,
  /node with given id does not belong to the document/i,
];

const PUBLIC_RELEASE_STATE = `(() => {
  const frame = document.querySelector("#app");
  const status = document.querySelector("#status");
  const frameDocument = frame?.contentDocument ?? null;
  const frameWindow = frame?.contentWindow ?? null;
  if (frameDocument === null || frameWindow === null) {
    return {
      compositorCaptureAvailable: false,
      dataset: {},
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
  return {
    compositorCaptureAvailable: compositor !== null
      && typeof compositor === "object"
      && typeof compositor.pending === "function"
      && typeof compositor.acknowledge === "function",
    dataset: Object.fromEntries(Object.entries(frameDocument.body?.dataset ?? {})),
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

const REQUEST_PUBLIC_SNAPSHOT = `(() => {
  const frame = document.querySelector("#app");
  const frameDocument = frame?.contentDocument ?? null;
  const runner = frame?.contentWindow?.lazuliCycleRunner ?? null;
  if (typeof runner?.snapshot !== "function") return false;
  const output = frameDocument?.querySelector("#result") ?? null;
  if (output !== null) output.textContent = "";
  runner.snapshot();
  return true;
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

function compactAsset(asset) {
  return { url: asset.url, sha256: asset.sha256, bytes: asset.bytes };
}

export function compactPublicActiveRelease(release) {
  return {
    schema: release.schema,
    releaseId: release.releaseId,
    commit: release.source.commit,
    frontend: compactAsset(release.frontend),
    renderer: {
      javascript: compactAsset(release.renderer.javascript),
      wasm: compactAsset(release.renderer.wasm),
    },
    backend: compactAsset(release.backend),
  };
}

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
  frame.search = top.search;
  frame.hash = "";
  return frame.href;
}

export async function publicReleaseState(session) {
  return session.evaluate(PUBLIC_RELEASE_STATE);
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
    if (report?.status === "stopped" || report?.error !== undefined) {
      throw new Error(`public ${stoppedLabel} boot stopped: ${JSON.stringify(report)}`);
    }
    if (
      state.dataset.status === "running"
      && state.dataset.renderer === "wgpu-webgpu"
      && state.discStatus?.startsWith("local: ")
      && state.runnerAvailable
    ) return state;
    await publicDelay(pollMs);
  }
  throw new Error(`public ${stoppedLabel} runner did not start: ${JSON.stringify(state)}`);
}

export async function requestPublicSnapshot(session) {
  return session.evaluate(REQUEST_PUBLIC_SNAPSHOT);
}

export async function waitForPublicSnapshot(session, { deadline, pollMs }) {
  let state = null;
  while (Date.now() < deadline) {
    state = await publicReleaseState(session);
    const report = parsePublicReport(state.result);
    if (report !== null) return { report, state };
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
