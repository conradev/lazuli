#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { parseMailbox } from "./parse-mailbox.mjs";

function observationKey(entry) {
  return `${entry.caseId}:${entry.clipDisable}`;
}

export function compareMailboxes(referenceInput, candidateInput) {
  const reference = parseMailbox(referenceInput, { pixels: true });
  const candidate = parseMailbox(candidateInput, { pixels: true });
  const referenceByKey = new Map(
    reference.entries.map((entry) => [observationKey(entry), entry]),
  );
  const candidateByKey = new Map(
    candidate.entries.map((entry) => [observationKey(entry), entry]),
  );
  const keys = Array.from(
    new Set([...referenceByKey.keys(), ...candidateByKey.keys()]),
  ).sort((left, right) => {
    const [leftCase, leftMode] = left.split(":").map(Number);
    const [rightCase, rightMode] = right.split(":").map(Number);
    return leftCase - rightCase || leftMode - rightMode;
  });

  const observations = keys.map((key) => {
    const referenceEntry = referenceByKey.get(key);
    const candidateEntry = candidateByKey.get(key);
    if (referenceEntry === undefined || candidateEntry === undefined) {
      return {
        key,
        match: false,
        missing: referenceEntry === undefined ? "reference" : "candidate",
      };
    }
    const differingPixels = [];
    for (let pixel = 0; pixel < referenceEntry.rgba.length; pixel += 1) {
      if (referenceEntry.rgba[pixel] !== candidateEntry.rgba[pixel]) {
        differingPixels.push({
          x: pixel % reference.header.width,
          y: Math.floor(pixel / reference.header.width),
          reference: referenceEntry.rgba[pixel],
          candidate: candidateEntry.rgba[pixel],
        });
      }
    }
    const clipInputExact =
      JSON.stringify(referenceEntry.clipBits) ===
      JSON.stringify(candidateEntry.clipBits);
    return {
      key,
      caseId: referenceEntry.caseId,
      case: referenceEntry.case,
      clipDisable: referenceEntry.clipDisable,
      match:
        clipInputExact &&
        referenceEntry.rgbaFnv1a64 ===
          candidateEntry.rgbaFnv1a64 &&
        differingPixels.length === 0,
      clipInputExact,
      referenceRgbaFnv1a64: referenceEntry.rgbaFnv1a64,
      candidateRgbaFnv1a64: candidateEntry.rgbaFnv1a64,
      differingPixelCount: differingPixels.length,
      differingPixels,
    };
  });
  const mismatches = observations.filter((entry) => !entry.match);
  return {
    schema: "lazuli.gx-w-clipdisable-oracle-comparison/v1",
    pass:
      reference.complete &&
      reference.verified &&
      candidate.complete &&
      candidate.verified &&
      mismatches.length === 0,
    reference: {
      complete: reference.complete,
      verified: reference.verified,
      entriesFnv1a64: reference.header.entriesFnv1a64,
    },
    candidate: {
      complete: candidate.complete,
      verified: candidate.verified,
      entriesFnv1a64: candidate.header.entriesFnv1a64,
    },
    observationCount: observations.length,
    mismatchCount: mismatches.length,
    mismatches,
  };
}

function main(argv) {
  if (argv.length !== 2) {
    throw new Error(
      "usage: node tools/compare-mailboxes.mjs <hardware.bin> <browser.bin>",
    );
  }
  const report = compareMailboxes(
    fs.readFileSync(argv[0]),
    fs.readFileSync(argv[1]),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
