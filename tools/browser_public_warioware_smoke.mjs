#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

const EVIDENCE_SCHEMA = "lazuli-public-warioware-smoke-v1";
const PUBLIC_SCENARIO = "smb-ready-play";
const WARIOWARE_DISC_IDENTIFIER = "GZWE01";

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
