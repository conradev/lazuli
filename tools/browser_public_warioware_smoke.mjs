#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  createUncompressedDevToolsSocket,
} from "./browser_boot_devtools_socket.mjs";
import { identifyLocalDiscImage } from "./browser_boot_disc_identity.mjs";

const EVIDENCE_SCHEMA = "lazuli-public-warioware-smoke-v1";
const PUBLIC_SCENARIO = "smb-ready-play";
const WARIOWARE_DISC_IDENTIFIER = "GZWE01";
const STALE_DOM_REFERENCE_ERRORS = [
  /(?:could not find|no) node with given id/i,
  /cannot find context with specified id/i,
  /document (?:was )?(?:updated|replaced)/i,
  /node with given id does not belong to the document/i,
];

const PUBLIC_RELEASE_STATE = `(() => {
  const frame = document.querySelector("#app");
  const frameDocument = frame?.contentDocument ?? null;
  const frameWindow = frame?.contentWindow ?? null;
  if (frameDocument === null || frameWindow === null) {
    return {
      dataset: {},
      discStatus: null,
      frameReadyState: null,
      frameUrl: null,
      hasDiscInput: false,
      result: "",
      runnerAvailable: false,
      surface: null,
      topUrl: location.href,
    };
  }
  return {
    dataset: Object.fromEntries(Object.entries(frameDocument.body?.dataset ?? {})),
    discStatus: frameDocument.querySelector("#disc-status")?.textContent ?? null,
    frameReadyState: frameDocument.readyState,
    frameUrl: frameWindow.location.href,
    hasDiscInput: frameDocument.querySelector("#disc-file") instanceof frameWindow.HTMLInputElement,
    result: frameDocument.querySelector("#result")?.textContent?.trim() ?? "",
    runnerAvailable: typeof frameWindow.lazuliCycleRunner?.snapshot === "function",
    surface: frameDocument.querySelector(".shell")?.dataset.surface ?? null,
    topUrl: location.href,
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

function evidenceFailure(path, message) {
  throw new Error(`invalid public WarioWare smoke evidence at ${path}: ${message}`);
}

function requiredObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    evidenceFailure(path, "expected an object");
  }
  return value;
}

function scenarioFromUrl(value, path) {
  try {
    return new URL(value).searchParams.get("scenario");
  } catch {
    evidenceFailure(path, "expected an absolute URL");
  }
}

export function validatePublicWarioWareSmokeEvidence(evidence) {
  requiredObject(evidence, "$");
  if (evidence.schema !== EVIDENCE_SCHEMA) {
    evidenceFailure("$.schema", `expected ${EVIDENCE_SCHEMA}`);
  }
  if (scenarioFromUrl(evidence.publicUrl, "$.publicUrl") !== PUBLIC_SCENARIO) {
    evidenceFailure("$.publicUrl", `expected stale ${PUBLIC_SCENARIO} scenario`);
  }
  if (scenarioFromUrl(evidence.frameUrl, "$.frameUrl") !== PUBLIC_SCENARIO) {
    evidenceFailure("$.frameUrl", `expected forwarded ${PUBLIC_SCENARIO} scenario`);
  }
  if (evidence.surface !== "release") {
    evidenceFailure("$.surface", "expected release");
  }
  const dataset = requiredObject(evidence.dataset, "$.dataset");
  if (dataset.status !== "running") {
    evidenceFailure("$.dataset.status", "expected running");
  }
  if (dataset.renderer !== "wgpu-webgpu") {
    evidenceFailure("$.dataset.renderer", "expected wgpu-webgpu");
  }
  if (!Array.isArray(evidence.devtoolsExceptions)) {
    evidenceFailure("$.devtoolsExceptions", "expected an array");
  }
  if (evidence.devtoolsExceptions.length !== 0) {
    evidenceFailure("$.devtoolsExceptions[0]", "expected no DevTools exceptions");
  }
  const discImage = requiredObject(evidence.discImage, "$.discImage");
  if (
    discImage.algorithm !== "sha256"
    || discImage.format !== "ciso"
    || !/^[0-9a-f]{64}$/.test(discImage.sha256)
  ) {
    evidenceFailure("$.discImage", "expected an identified local CISO");
  }

  const report = requiredObject(evidence.report, "$.report");
  if (report.status !== "running" || report.stage !== "snapshot") {
    evidenceFailure("$.report", "expected running snapshot evidence");
  }
  if (report.error !== undefined && report.error !== null) {
    evidenceFailure("$.report.error", "expected no terminal error");
  }
  if (report.scenario !== null) {
    evidenceFailure("$.report.scenario", "expected the stale SMB scenario to be discarded");
  }
  const disc = requiredObject(report.disc, "$.report.disc");
  if (disc.identifier !== WARIOWARE_DISC_IDENTIFIER) {
    evidenceFailure("$.report.disc.identifier", `expected ${WARIOWARE_DISC_IDENTIFIER}`);
  }
  if (disc.revision !== 0) {
    evidenceFailure("$.report.disc.revision", "expected USA revision 0");
  }
  if (disc.source?.kind !== "local-file") {
    evidenceFailure("$.report.disc.source.kind", "expected local-file");
  }
  const rendering = requiredObject(report.rendering, "$.report.rendering");
  if (rendering.backend !== "wgpu-webgpu") {
    evidenceFailure("$.report.rendering.backend", "expected wgpu-webgpu");
  }
  if (rendering.error !== undefined && rendering.error !== null) {
    evidenceFailure("$.report.rendering.error", "expected no renderer error");
  }
  for (const name of ["cycles", "dispatches", "instructions"]) {
    if (!Number.isSafeInteger(report[name]) || report[name] <= 0) {
      evidenceFailure(`$.report.${name}`, "expected positive execution progress");
    }
  }
  return evidence;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function parseReport(text) {
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

function isStaleDomReferenceError(error) {
  const message = error?.message ?? String(error);
  return STALE_DOM_REFERENCE_ERRORS.some(pattern => pattern.test(message));
}

class DevToolsSession {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
    this.socket = createUncompressedDevToolsSocket(url);
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (pending === undefined) return;
        this.pending.delete(message.id);
        if (message.error !== undefined) {
          pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        } else {
          pending.resolve(message.result ?? {});
        }
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        this.exceptions.push(message.params?.exceptionDetails ?? message.params ?? message);
      }
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Chrome DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, reject, resolve });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
    });
    if (response.exceptionDetails !== undefined) {
      throw new Error(`Runtime.evaluate failed: ${JSON.stringify(response.exceptionDetails)}`);
    }
    return response.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function pageTarget(endpoint) {
  const response = await fetch(new URL("/json/list", endpoint));
  if (!response.ok) throw new Error(`Chrome target list returned HTTP ${response.status}`);
  const targets = await response.json();
  const page = targets.find(target => target.type === "page" && target.webSocketDebuggerUrl);
  if (page === undefined) throw new Error("Chrome exposes no debuggable page target");
  return page;
}

async function publicReleaseState(session) {
  return session.evaluate(PUBLIC_RELEASE_STATE);
}

async function waitForPublicRelease(session, publicUrl, deadline, pollMs) {
  let state = null;
  while (Date.now() < deadline) {
    state = await publicReleaseState(session);
    if (
      state.topUrl === publicUrl
      && state.frameReadyState === "complete"
      && state.hasDiscInput
      && state.surface === "release"
      && state.dataset.renderer === "wgpu-webgpu"
    ) return state;
    await delay(pollMs);
  }
  throw new Error(`public release did not become ready: ${JSON.stringify(state)}`);
}

async function assignPublicDisc(session, discPath, deadline, pollMs) {
  while (Date.now() < deadline) {
    const input = await session.send("Runtime.evaluate", {
      expression: PUBLIC_DISC_INPUT,
      returnByValue: false,
    });
    const objectId = input.result?.objectId;
    if (typeof objectId !== "string") {
      await delay(pollMs);
      continue;
    }
    try {
      await session.send("DOM.setFileInputFiles", {
        files: [discPath],
        objectId,
      });
    } catch (error) {
      if (!isStaleDomReferenceError(error)) {
        throw new Error(`could not assign public WarioWare CISO: ${error.message ?? String(error)}`);
      }
      await delay(pollMs);
      continue;
    } finally {
      await session.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
    const activation = await session.evaluate(ACTIVATE_PUBLIC_DISC);
    if (activation?.fileCount === 1) return activation;
    await delay(pollMs);
  }
  throw new Error("public release file input did not accept the WarioWare CISO");
}

async function waitForWarioWareRunner(session, deadline, pollMs) {
  let state = null;
  while (Date.now() < deadline) {
    state = await publicReleaseState(session);
    const report = parseReport(state.result);
    if (report?.status === "stopped" || report?.error !== undefined) {
      throw new Error(`public WarioWare boot stopped: ${JSON.stringify(report)}`);
    }
    if (
      state.dataset.status === "running"
      && state.dataset.renderer === "wgpu-webgpu"
      && state.discStatus?.startsWith("local: ")
      && state.runnerAvailable
    ) return state;
    await delay(pollMs);
  }
  throw new Error(`public WarioWare runner did not start: ${JSON.stringify(state)}`);
}

async function waitForSnapshot(session, deadline, pollMs) {
  let state = null;
  while (Date.now() < deadline) {
    state = await publicReleaseState(session);
    const report = parseReport(state.result);
    if (report !== null) return { report, state };
    await delay(pollMs);
  }
  throw new Error(`public WarioWare snapshot did not arrive: ${JSON.stringify(state)}`);
}

function parseArguments(argv) {
  const options = {
    disc: null,
    endpoint: "http://127.0.0.1:9222",
    output: null,
    pollMs: 250,
    settleMs: 5_000,
    timeoutMs: 120_000,
    url: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value after ${argument}`);
      return argv[index];
    };
    switch (argument) {
      case "--disc": options.disc = value(); break;
      case "--endpoint": options.endpoint = value(); break;
      case "--output": options.output = value(); break;
      case "--poll-ms": options.pollMs = Number(value()); break;
      case "--settle-ms": options.settleMs = Number(value()); break;
      case "--timeout-ms": options.timeoutMs = Number(value()); break;
      case "--url": options.url = value(); break;
      default: throw new Error(`unknown argument ${argument}`);
    }
  }
  if (options.disc === null) throw new Error("--disc must name the local WarioWare CISO");
  if (options.url === null) throw new Error("--url must name the public Gekko surface");
  if (!Number.isInteger(options.pollMs) || options.pollMs < 10) {
    throw new Error("--poll-ms must be an integer >= 10");
  }
  if (!Number.isInteger(options.settleMs) || options.settleMs < 0) {
    throw new Error("--settle-ms must be a non-negative integer");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < options.pollMs) {
    throw new Error("--timeout-ms must be an integer >= --poll-ms");
  }
  options.disc = resolve(options.disc);
  const url = new URL(options.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--url must use http or https");
  }
  url.search = `?scenario=${PUBLIC_SCENARIO}`;
  url.hash = "";
  options.publicUrl = url.href;
  return options;
}

async function persistEvidence(output, evidence) {
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  if (output === null) {
    process.stdout.write(text);
    return;
  }
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, output);
  process.stdout.write(`${output}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const discImage = await identifyLocalDiscImage(options.disc);
  const target = await pageTarget(options.endpoint);
  const session = new DevToolsSession(target.webSocketDebuggerUrl);
  await session.connect();
  try {
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    await session.send("DOM.enable");
    const navigation = await session.send("Page.navigate", { url: options.publicUrl });
    if (navigation.errorText !== undefined) {
      throw new Error(`Page.navigate failed: ${navigation.errorText}`);
    }
    const deadline = Date.now() + options.timeoutMs;
    await waitForPublicRelease(session, options.publicUrl, deadline, options.pollMs);
    await assignPublicDisc(session, options.disc, deadline, options.pollMs);
    await waitForWarioWareRunner(session, deadline, options.pollMs);
    if (Date.now() + options.settleMs >= deadline) {
      throw new Error("public WarioWare smoke deadline expired before its settle interval");
    }
    await delay(options.settleMs);
    if (await session.evaluate(REQUEST_PUBLIC_SNAPSHOT) !== true) {
      throw new Error("public WarioWare cycle runner cannot publish a snapshot");
    }
    const { report, state } = await waitForSnapshot(
      session,
      deadline,
      options.pollMs,
    );
    const evidence = validatePublicWarioWareSmokeEvidence({
      schema: EVIDENCE_SCHEMA,
      dataset: state.dataset,
      devtoolsExceptions: session.exceptions,
      discImage,
      discStatus: state.discStatus,
      frameUrl: state.frameUrl,
      publicUrl: options.publicUrl,
      report,
      surface: state.surface,
    });
    await persistEvidence(options.output, evidence);
  } finally {
    session.close();
  }
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
