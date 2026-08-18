// SPDX-License-Identifier: GPL-3.0-only

import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { DevToolsSession } from "./browser_boot_headless_cdp.mjs";
import { identifyLocalDiscImage } from "./browser_boot_disc_identity.mjs";
import {
  assertNoPublicResidentExceptions,
  assignPublicResidentDisc,
  expectedPublicFrameUrl,
  observePublicActiveRelease,
  observePublicResidentNavigation,
  publicPageTarget,
  validateCompactPublicActiveRelease,
  validatePublicResidentDiagnosticCapture,
  validatePublicResidentDocumentBinding,
  waitForPublicResidentFirstXfb,
  waitForPublicResidentRelease,
} from "./browser_public_cdp.mjs";

export const PUBLIC_RESIDENT_SMOKE_SCHEMA = "lazuli-public-resident-smoke-v1";
export const PUBLIC_RESIDENT_SMOKE_DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;

class PublicResidentSmokeEvidenceError extends Error {
  constructor(path, detail) {
    super(`invalid public resident smoke evidence at ${path}: ${detail}`);
    this.name = "PublicResidentSmokeEvidenceError";
    this.path = path;
    this.detail = detail;
  }
}

function fail(path, detail) {
  throw new PublicResidentSmokeEvidenceError(path, detail);
}

function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value;
}

function exactKeys(value, keys, path) {
  const actual = Object.keys(object(value, path)).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    fail(path, `keys must be ${expected.join(", ")}; got ${actual.join(", ")}`);
  }
  return value;
}

function jsonEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && jsonEqual(left[key], right[key])
    ));
}

function exactJson(value, expected, path, detail) {
  if (!jsonEqual(value, expected)) fail(path, detail);
  return value;
}

function hash(value, path, characters) {
  const pattern = characters === 40 ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(path, `expected a lowercase ${characters === 40 ? "commit" : "SHA-256"} digest`);
  }
  return value;
}

export function configuredPublicResidentUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--url must be an absolute URL");
  }
  const loopback = new Set(["127.0.0.1", "[::1]", "localhost"]).has(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("--url must be an exact queryless HTTPS origin root or HTTP loopback root");
  }
  return url.href;
}

function configuredDevToolsEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--endpoint must be an absolute loopback HTTP URL");
  }
  if (
    url.protocol !== "http:"
    || !new Set(["127.0.0.1", "[::1]", "localhost"]).has(url.hostname)
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("--endpoint must be an exact loopback HTTP origin root");
  }
  return url.href;
}

export function parsePublicResidentSmokeArguments(argv) {
  const options = {
    disc: null,
    endpoint: "http://127.0.0.1:9222/",
    expectCommit: null,
    expectReleaseId: null,
    output: null,
    pollMs: 250,
    timeoutMs: PUBLIC_RESIDENT_SMOKE_DEFAULT_TIMEOUT_MS,
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
      case "--expect-commit": options.expectCommit = value(); break;
      case "--expect-release-id": options.expectReleaseId = value(); break;
      case "--output": options.output = value(); break;
      case "--poll-ms": options.pollMs = Number(value()); break;
      case "--timeout-ms": options.timeoutMs = Number(value()); break;
      case "--url": options.url = value(); break;
      default: throw new Error(`unknown argument ${argument}`);
    }
  }
  if (options.disc === null) throw new Error("--disc must name a local ISO or CISO");
  if (options.url === null) throw new Error("--url must name the deployed origin root");
  if (!/^[0-9a-f]{40}$/.test(options.expectCommit ?? "")) {
    throw new Error("--expect-commit is required and must be a lowercase commit ID");
  }
  if (!/^[0-9a-f]{64}$/.test(options.expectReleaseId ?? "")) {
    throw new Error("--expect-release-id is required and must be a lowercase SHA-256 digest");
  }
  if (!Number.isInteger(options.pollMs) || options.pollMs < 10) {
    throw new Error("--poll-ms must be an integer >= 10");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < options.pollMs) {
    throw new Error("--timeout-ms must be an integer >= --poll-ms");
  }
  options.disc = resolve(options.disc);
  options.output = options.output === null ? null : resolve(options.output);
  if (options.output === options.disc) {
    throw new Error("--output must not replace the local disc image");
  }
  options.endpoint = configuredDevToolsEndpoint(options.endpoint);
  options.publicUrl = configuredPublicResidentUrl(options.url);
  return options;
}

function validateDiscImage(value, path) {
  exactKeys(value, ["algorithm", "format", "sha256"], path);
  if (value.algorithm !== "sha256") fail(`${path}.algorithm`, "expected sha256");
  if (value.format !== "iso" && value.format !== "ciso") {
    fail(`${path}.format`, "expected iso or ciso");
  }
  hash(value.sha256, `${path}.sha256`, 64);
  return value;
}

function validateFrameIdentity(value, expectedUrl, path) {
  exactKeys(value, ["frameId", "loaderId", "url"], path);
  for (const name of ["frameId", "loaderId"]) {
    if (typeof value[name] !== "string" || value[name].length === 0) {
      fail(`${path}.${name}`, "expected a non-empty DevTools identity");
    }
  }
  if (value.url !== expectedUrl) fail(`${path}.url`, `expected ${expectedUrl}`);
  return value;
}

function validateNavigation(value, publicUrl, path) {
  exactKeys(value, ["after", "before", "expectedFrameUrl", "expectedTopLoaderId"], path);
  if (typeof value.expectedTopLoaderId !== "string" || value.expectedTopLoaderId.length === 0) {
    fail(`${path}.expectedTopLoaderId`, "expected a pinned top-level loader");
  }
  let frameUrl;
  try {
    frameUrl = new URL(value.expectedFrameUrl);
  } catch {
    fail(`${path}.expectedFrameUrl`, "expected an absolute immutable frontend URL");
  }
  if (frameUrl.origin !== new URL(publicUrl).origin) {
    fail(`${path}.expectedFrameUrl`, "expected a same-origin immutable frontend");
  }
  for (const name of ["before", "after"]) {
    exactKeys(value[name], ["frame", "top"], `${path}.${name}`);
    validateFrameIdentity(value[name].top, publicUrl, `${path}.${name}.top`);
    validateFrameIdentity(value[name].frame, value.expectedFrameUrl, `${path}.${name}.frame`);
    if (value[name].top.loaderId !== value.expectedTopLoaderId) {
      fail(`${path}.${name}.top.loaderId`, "does not match the pinned navigation loader");
    }
  }
  exactJson(value.after, value.before, `${path}.after`, "document loaders changed during smoke");
  return value;
}

export function validatePublicResidentSmokeEvidence(value) {
  exactKeys(value, [
    "schema",
    "devtoolsExceptions",
    "diagnostics",
    "discImage",
    "document",
    "expected",
    "navigation",
    "publicUrl",
    "release",
    "terminalRelease",
  ], "$");
  if (value.schema !== PUBLIC_RESIDENT_SMOKE_SCHEMA) {
    fail("$.schema", `expected ${PUBLIC_RESIDENT_SMOKE_SCHEMA}`);
  }
  exactKeys(value.expected, ["commit", "releaseId"], "$.expected");
  hash(value.expected.commit, "$.expected.commit", 40);
  hash(value.expected.releaseId, "$.expected.releaseId", 64);
  let publicUrl;
  try {
    publicUrl = configuredPublicResidentUrl(value.publicUrl);
  } catch (error) {
    fail("$.publicUrl", error.message ?? String(error));
  }
  if (publicUrl !== value.publicUrl) fail("$.publicUrl", "is not canonical");
  validateDiscImage(value.discImage, "$.discImage");
  validateCompactPublicActiveRelease(value.release, {
    expectedCommit: value.expected.commit,
    expectedReleaseId: value.expected.releaseId,
    path: "$.release",
  });
  exactJson(
    value.terminalRelease,
    value.release,
    "$.terminalRelease",
    "active schema-4 identity changed during smoke",
  );
  validateCompactPublicActiveRelease(value.terminalRelease, {
    expectedCommit: value.expected.commit,
    expectedReleaseId: value.expected.releaseId,
    path: "$.terminalRelease",
  });
  const expectedFrameUrl = expectedPublicFrameUrl(value.publicUrl, value.release);
  validateNavigation(value.navigation, value.publicUrl, "$.navigation");
  if (value.navigation.expectedFrameUrl !== expectedFrameUrl) {
    fail("$.navigation.expectedFrameUrl", "does not match the authenticated frontend hash");
  }
  exactKeys(value.document, ["diagnostics", "ready", "resultMatched"], "$.document");
  validatePublicResidentDocumentBinding(value.document.ready, {
    expectedFrameUrl,
    path: "$.document.ready",
    publicUrl: value.publicUrl,
  });
  validatePublicResidentDocumentBinding(value.document.diagnostics, {
    expectedBinding: value.document.ready,
    expectedFrameUrl,
    path: "$.document.diagnostics",
    publicUrl: value.publicUrl,
  });
  if (value.document.resultMatched !== true) {
    fail("$.document.resultMatched", "runner report did not bind to the visible result");
  }
  validatePublicResidentDiagnosticCapture({
    binding: value.document.diagnostics,
    report: value.diagnostics,
    resultMatched: value.document.resultMatched,
  }, {
    expectedBinding: value.document.ready,
    expectedFrameUrl,
    path: "$.residentCapture",
    publicUrl: value.publicUrl,
    release: value.release,
  });
  assertNoPublicResidentExceptions(value.devtoolsExceptions, "$.devtoolsExceptions");
  return value;
}

export async function persistPublicResidentSmokeEvidence(output, evidence) {
  validatePublicResidentSmokeEvidence(evidence);
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  if (output === null) {
    process.stdout.write(text);
    return;
  }
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, output);
  process.stdout.write(`${output}\n`);
}

export async function capturePublicResidentSmoke(session, options, discImage) {
  validateDiscImage(discImage, "$.discImage");
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  await session.send("DOM.enable");
  if (!Array.isArray(session.exceptions)) {
    throw new Error("DevTools session has no exception log");
  }
  session.exceptions.splice(0);
  const navigation = await session.send("Page.navigate", { url: options.publicUrl });
  if (navigation.errorText !== undefined) {
    throw new Error(`Page.navigate failed: ${navigation.errorText}`);
  }
  if (typeof navigation.loaderId !== "string" || navigation.loaderId.length === 0) {
    throw new Error("Page.navigate did not create a top-level document loader");
  }
  await session.send("Page.bringToFront");
  const deadline = Date.now() + options.timeoutMs;
  const initial = await waitForPublicResidentRelease(session, {
    deadline,
    pollMs: options.pollMs,
    publicUrl: options.publicUrl,
  });
  const release = await observePublicActiveRelease(session, options);
  const expectedFrameUrl = expectedPublicFrameUrl(options.publicUrl, release);
  const ready = await waitForPublicResidentRelease(session, {
    deadline,
    expectedBinding: initial.binding,
    expectedFrameUrl,
    pollMs: options.pollMs,
    publicUrl: options.publicUrl,
  });
  const navigationBefore = await observePublicResidentNavigation(session, {
    expectedFrameUrl,
    expectedTopLoaderId: navigation.loaderId,
    publicUrl: options.publicUrl,
  });
  await assignPublicResidentDisc(session, options.disc, {
    deadline,
    expectedBinding: ready.binding,
    expectedFrameUrl,
    pollMs: options.pollMs,
    publicUrl: options.publicUrl,
  });
  const capture = await waitForPublicResidentFirstXfb(session, {
    deadline,
    expectedBinding: ready.binding,
    expectedFrameUrl,
    pollMs: options.pollMs,
    publicUrl: options.publicUrl,
    release,
  });
  const terminalRelease = await observePublicActiveRelease(session, options, release);
  const navigationAfter = await observePublicResidentNavigation(session, {
    expectedFrameUrl,
    expectedTopLoaderId: navigation.loaderId,
    publicUrl: options.publicUrl,
  });
  const evidence = {
    schema: PUBLIC_RESIDENT_SMOKE_SCHEMA,
    expected: {
      commit: options.expectCommit,
      releaseId: options.expectReleaseId,
    },
    publicUrl: options.publicUrl,
    discImage,
    release,
    terminalRelease,
    navigation: {
      expectedTopLoaderId: navigation.loaderId,
      expectedFrameUrl,
      before: navigationBefore,
      after: navigationAfter,
    },
    document: {
      ready: ready.binding,
      diagnostics: capture.binding,
      resultMatched: capture.resultMatched,
    },
    diagnostics: capture.report,
    devtoolsExceptions: [...session.exceptions],
  };
  return validatePublicResidentSmokeEvidence(evidence);
}

export async function runPublicResidentSmoke(options) {
  const discImage = await identifyLocalDiscImage(options.disc);
  const target = await publicPageTarget(options.endpoint);
  const session = new DevToolsSession(target.webSocketDebuggerUrl);
  await session.connect();
  try {
    const evidence = await capturePublicResidentSmoke(session, options, discImage);
    await persistPublicResidentSmokeEvidence(options.output, evidence);
    return evidence;
  } finally {
    session.close();
  }
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const options = parsePublicResidentSmokeArguments(process.argv.slice(2));
  runPublicResidentSmoke(options).catch(error => {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  });
}
