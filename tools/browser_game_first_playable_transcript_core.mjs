// SPDX-License-Identifier: GPL-3.0-only

import {
  canonicalStringify,
  checkpointSha256,
} from "./browser_boot_checkpoint_core.mjs";
import {
  validateGameCompatibilityCorpus,
} from "./browser_game_compatibility_corpus.mjs";
import {
  verifyGameCompatibilitySnapshot,
  verifyGameCompatibilityWindow,
} from "./browser_game_compatibility_oracle.mjs";

export const GAME_FIRST_PLAYABLE_TRANSCRIPT_SCHEMA =
  "lazuli-game-first-playable-transcript-v1";

export const GAME_FIRST_PLAYABLE_BUTTONS = Object.freeze({
  a: 0x0100,
  b: 0x0200,
  down: 0x0004,
  left: 0x0001,
  right: 0x0002,
  start: 0x1000,
  up: 0x0008,
});

const PUBLICATION_FIELDS = Object.freeze([
  "source",
  "pollIndex",
  "scheduledCycle",
  "observedCycle",
  "buttons",
  "sequence",
]);
const PREVIOUS_REPORT_FIELDS = Object.freeze([
  "cycles",
  "dispatches",
  "instructions",
  "pc",
  "stage",
  "status",
]);
const DISC_SOURCE_IDENTITY_FIELDS = Object.freeze([
  "kind",
  "url",
  "size",
  "format",
  "logicalSize",
  "blockSize",
  "presentBlocks",
]);
const PRIVATE_HOSTS = new Set(["127.0.0.1", "localhost"]);
const VISUAL_CHANGE_PATH = "/rendering/selectedXfb/rgbSha256";

export class GameFirstPlayableTranscriptError extends Error {
  constructor(path, message) {
    super(`invalid game first-playable evidence at ${path}: ${message}`);
    this.name = "GameFirstPlayableTranscriptError";
    this.path = path;
  }
}

function transcriptFailure(path, message) {
  throw new GameFirstPlayableTranscriptError(path, message);
}

function requiredObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    transcriptFailure(path, "expected an object");
  }
  return value;
}

function requireExactKeys(value, fields, path) {
  requiredObject(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    transcriptFailure(
      `${path}.[keys]`,
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
  return value;
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    transcriptFailure(path, "expected a non-empty string");
  }
  return value;
}

function requiredNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    transcriptFailure(path, "expected a non-negative safe integer");
  }
  return value;
}

function requiredPositiveInteger(value, path) {
  const integer = requiredNonNegativeInteger(value, path);
  if (integer === 0) transcriptFailure(path, "expected a positive integer");
  return integer;
}

function requireExact(value, expected, path) {
  if (value !== expected) {
    transcriptFailure(
      path,
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function gameForKey(corpus, key) {
  validateGameCompatibilityCorpus(corpus);
  requiredString(key, "$.gameKey");
  const game = corpus.games.find(candidate => candidate.key === key);
  if (game === undefined) {
    transcriptFailure("$.gameKey", `unknown corpus game ${JSON.stringify(key)}`);
  }
  return game;
}

export function gameFirstPlayableButtonMask(name) {
  requiredString(name, "$.button");
  const mask = GAME_FIRST_PLAYABLE_BUTTONS[name];
  if (mask === undefined) {
    transcriptFailure("$.button", `unsupported controller button ${JSON.stringify(name)}`);
  }
  return mask;
}

function requirePrivateUrl(value, path) {
  let url;
  try {
    url = new URL(value);
  } catch {
    transcriptFailure(path, "expected an absolute private URL");
  }
  if (
    url.protocol !== "http:"
    || !PRIVATE_HOSTS.has(url.hostname)
    || url.username !== ""
    || url.password !== ""
  ) {
    transcriptFailure(path, "expected an HTTP loopback URL");
  }
  return url.href;
}

function captureForReport(report, path) {
  requiredObject(report, path);
  const capture = requiredObject(report.headlessCapture, `${path}.headlessCapture`);
  requiredObject(capture.dataset, `${path}.headlessCapture.dataset`);
  if (!Array.isArray(capture.devtoolsExceptions)) {
    transcriptFailure(
      `${path}.headlessCapture.devtoolsExceptions`,
      "expected an array",
    );
  }
  requirePrivateUrl(capture.url, `${path}.headlessCapture.url`);
  return capture;
}

function discImageFromPreCapture(capture, game) {
  const image = requireExactKeys(
    capture.discImage,
    ["algorithm", "format", "sha256"],
    "$.preReport.headlessCapture.discImage",
  );
  requireExact(image.algorithm, "sha256", "$.preReport.headlessCapture.discImage.algorithm");
  requireExact(
    image.format,
    game.image.format,
    "$.preReport.headlessCapture.discImage.format",
  );
  requireExact(
    image.sha256,
    game.image.sha256,
    "$.preReport.headlessCapture.discImage.sha256",
  );
  return image;
}

function privateEnvironment(capture, discImage) {
  return {
    surface: "local-debug",
    dataset: capture.dataset,
    devtoolsExceptions: capture.devtoolsExceptions,
    discImage,
  };
}

function requireSameOptionalRelease(preCapture, postCapture) {
  const preRelease = preCapture.release;
  const postRelease = postCapture.release;
  if (preRelease === undefined && postRelease === undefined) return;
  if (preRelease === undefined || postRelease === undefined) {
    transcriptFailure(
      "$.postReport.headlessCapture.release",
      "release evidence changed across the reused worker",
    );
  }
  if (canonicalStringify(preRelease) !== canonicalStringify(postRelease)) {
    transcriptFailure(
      "$.postReport.headlessCapture.release",
      "active release changed across the reused worker",
    );
  }
}

function discSourceIdentity(report, path) {
  const source = requiredObject(report.disc?.source, path);
  requiredString(source.kind, `${path}.kind`);
  const identity = {};
  for (const field of DISC_SOURCE_IDENTITY_FIELDS) {
    if (Object.hasOwn(source, field)) identity[field] = source[field];
  }
  return identity;
}

function requireReuseContinuity(preReport, postReport, button, preCapture, postCapture) {
  const reuse = requiredObject(
    postCapture.reuse,
    "$.postReport.headlessCapture.reuse",
  );
  requireExact(
    requiredString(reuse.url, "$.postReport.headlessCapture.reuse.url"),
    preCapture.url,
    "$.postReport.headlessCapture.reuse.url",
  );
  requireExact(
    postCapture.url,
    preCapture.url,
    "$.postReport.headlessCapture.url",
  );

  const previous = requireExactKeys(
    reuse.previous,
    PREVIOUS_REPORT_FIELDS,
    "$.postReport.headlessCapture.reuse.previous",
  );
  for (const field of PREVIOUS_REPORT_FIELDS) {
    requireExact(
      previous[field],
      preReport[field],
      `$.postReport.headlessCapture.reuse.previous.${field}`,
    );
  }

  const action = requiredObject(
    reuse.action,
    "$.postReport.headlessCapture.reuse.action",
  );
  requiredPositiveInteger(
    action.extendCycles,
    "$.postReport.headlessCapture.reuse.action.extendCycles",
  );
  requiredPositiveInteger(
    action.pulseMs,
    "$.postReport.headlessCapture.reuse.action.pulseMs",
  );
  if (!Array.isArray(action.pulses) || action.pulses.length !== 1) {
    transcriptFailure(
      "$.postReport.headlessCapture.reuse.action.pulses",
      "expected exactly one controller pulse",
    );
  }
  const pulse = requireExactKeys(
    action.pulses[0],
    ["delayMs", "name"],
    "$.postReport.headlessCapture.reuse.action.pulses[0]",
  );
  requireExact(
    pulse.name,
    button,
    "$.postReport.headlessCapture.reuse.action.pulses[0].name",
  );
  requiredNonNegativeInteger(
    pulse.delayMs,
    "$.postReport.headlessCapture.reuse.action.pulses[0].delayMs",
  );

  requireSameOptionalRelease(preCapture, postCapture);
  if (
    canonicalStringify(discSourceIdentity(preReport, "$.preReport.disc.source"))
    !== canonicalStringify(discSourceIdentity(postReport, "$.postReport.disc.source"))
  ) {
    transcriptFailure(
      "$.postReport.disc.source",
      "disc source changed across the reused worker",
    );
  }
}

function projectPublication(postReport, preReport, expectedButton) {
  const controller = requiredObject(
    postReport.controller,
    "$.postReport.controller",
  );
  const publication = requireExactKeys(
    controller.lastActiveHostPublication,
    PUBLICATION_FIELDS,
    "$.postReport.controller.lastActiveHostPublication",
  );
  if (publication.source !== "periodic" && publication.source !== "direct") {
    transcriptFailure(
      "$.postReport.controller.lastActiveHostPublication.source",
      "expected periodic or direct",
    );
  }
  const pollIndex = requiredPositiveInteger(
    publication.pollIndex,
    "$.postReport.controller.lastActiveHostPublication.pollIndex",
  );
  const scheduledCycle = requiredNonNegativeInteger(
    publication.scheduledCycle,
    "$.postReport.controller.lastActiveHostPublication.scheduledCycle",
  );
  const observedCycle = requiredNonNegativeInteger(
    publication.observedCycle,
    "$.postReport.controller.lastActiveHostPublication.observedCycle",
  );
  const buttons = requiredPositiveInteger(
    publication.buttons,
    "$.postReport.controller.lastActiveHostPublication.buttons",
  );
  const sequence = requiredPositiveInteger(
    publication.sequence,
    "$.postReport.controller.lastActiveHostPublication.sequence",
  );
  requireExact(
    buttons,
    expectedButton,
    "$.postReport.controller.lastActiveHostPublication.buttons",
  );
  if (scheduledCycle > observedCycle) {
    transcriptFailure(
      "$.postReport.controller.lastActiveHostPublication.observedCycle",
      "expected a value no smaller than scheduledCycle",
    );
  }

  const preCycles = requiredPositiveInteger(preReport.cycles, "$.preReport.cycles");
  const postCycles = requiredPositiveInteger(postReport.cycles, "$.postReport.cycles");
  if (scheduledCycle < preCycles || observedCycle > postCycles) {
    transcriptFailure(
      "$.postReport.controller.lastActiveHostPublication",
      `expected publication within cycles ${preCycles} through ${postCycles}`,
    );
  }

  const preController = requiredObject(preReport.controller, "$.preReport.controller");
  const prePollIndex = requiredNonNegativeInteger(
    preController.pollIndex,
    "$.preReport.controller.pollIndex",
  );
  const postPollIndex = requiredNonNegativeInteger(
    controller.pollIndex,
    "$.postReport.controller.pollIndex",
  );
  if (pollIndex <= prePollIndex || pollIndex > postPollIndex) {
    transcriptFailure(
      "$.postReport.controller.lastActiveHostPublication.pollIndex",
      `expected a value from ${prePollIndex + 1} through ${postPollIndex}`,
    );
  }
  const preSequence = requiredNonNegativeInteger(
    preController.appliedSequence,
    "$.preReport.controller.appliedSequence",
  );
  const postSequence = requiredNonNegativeInteger(
    controller.appliedSequence,
    "$.postReport.controller.appliedSequence",
  );
  if (sequence <= preSequence || sequence > postSequence) {
    transcriptFailure(
      "$.postReport.controller.lastActiveHostPublication.sequence",
      `expected a value from ${preSequence + 1} through ${postSequence}`,
    );
  }

  return Object.freeze({
    source: publication.source,
    pollIndex,
    scheduledCycle,
    observedCycle,
    buttons,
    sequence,
  });
}

function presentationProjection(report, path, progress) {
  const vi = requiredObject(
    report.mmioState?.viInterruptModel,
    `${path}.mmioState.viInterruptModel`,
  );
  const cycle = requiredPositiveInteger(
    vi.lastHostPresentationCycle,
    `${path}.mmioState.viInterruptModel.lastHostPresentationCycle`,
  );
  if (cycle > report.cycles) {
    transcriptFailure(
      `${path}.mmioState.viInterruptModel.lastHostPresentationCycle`,
      `expected a value no greater than report cycles ${report.cycles}`,
    );
  }
  return Object.freeze({
    cycle,
    rgbSha256: progress.rgbSha256,
    serial: requiredPositiveInteger(
      vi.lastHostPresentationSerial,
      `${path}.mmioState.viInterruptModel.lastHostPresentationSerial`,
    ),
  });
}

function reportProjection(report, path, verified) {
  const controller = requiredObject(report.controller, `${path}.controller`);
  return Object.freeze({
    controller: Object.freeze({
      appliedSequence: requiredNonNegativeInteger(
        controller.appliedSequence,
        `${path}.controller.appliedSequence`,
      ),
      pollIndex: requiredNonNegativeInteger(
        controller.pollIndex,
        `${path}.controller.pollIndex`,
      ),
    }),
    cycles: requiredPositiveInteger(report.cycles, `${path}.cycles`),
    presentation: presentationProjection(report, path, verified.progress),
    progress: verified.progress,
    sha256: checkpointSha256(report),
  });
}

function firstDifference(expected, actual, path = "$") {
  if (Object.is(expected, actual)) return null;
  const expectedObject = expected !== null && typeof expected === "object";
  const actualObject = actual !== null && typeof actual === "object";
  if (!expectedObject || !actualObject || Array.isArray(expected) !== Array.isArray(actual)) {
    return path;
  }
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (
    expectedKeys.length !== actualKeys.length
    || expectedKeys.some((key, index) => key !== actualKeys[index])
  ) return `${path}.[keys]`;
  for (const key of expectedKeys) {
    const difference = firstDifference(
      expected[key],
      actual[key],
      Array.isArray(expected)
        ? `${path}[${key}]`
        : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
          ? `${path}.${key}`
          : `${path}[${JSON.stringify(key)}]`,
    );
    if (difference !== null) return difference;
  }
  return null;
}

export function deriveGameFirstPlayableTranscriptCore({
  button,
  corpus,
  gameKey,
  guestProjector = null,
  postReport,
  preReport,
}) {
  const game = gameForKey(corpus, gameKey);
  const mask = gameFirstPlayableButtonMask(button);
  if (typeof guestProjector !== "function") {
    transcriptFailure(
      "$.guestProjector",
      "first-playable evidence requires a guest-consumption projector",
    );
  }
  const preCapture = captureForReport(preReport, "$.preReport");
  const postCapture = captureForReport(postReport, "$.postReport");
  const discImage = discImageFromPreCapture(preCapture, game);
  requireReuseContinuity(
    preReport,
    postReport,
    button,
    preCapture,
    postCapture,
  );
  requireExact(preReport.scenario, null, "$.preReport.scenario");
  requireExact(postReport.scenario, null, "$.postReport.scenario");

  const preSnapshot = {
    environment: privateEnvironment(preCapture, discImage),
    report: preReport,
  };
  const postSnapshot = {
    environment: privateEnvironment(postCapture, discImage),
    report: postReport,
  };
  const preVerified = verifyGameCompatibilitySnapshot({
    ...preSnapshot,
    game,
  });
  const postVerified = verifyGameCompatibilitySnapshot({
    ...postSnapshot,
    game,
  });
  const window = verifyGameCompatibilityWindow({
    game,
    snapshots: [preSnapshot, postSnapshot],
    sustainedViFields: corpus.evidence.sustainedViFields,
  });
  const publication = projectPublication(postReport, preReport, mask);
  const pre = reportProjection(preReport, "$.preReport", preVerified);
  const post = reportProjection(postReport, "$.postReport", postVerified);
  const guestConsumption = guestProjector({
    button,
    game,
    postReport,
    preReport,
    publication,
  });
  if (guestConsumption === null) {
    transcriptFailure(
      "$.gameKey",
      `no guest-consumption projector is available for ${JSON.stringify(game.key)}`,
    );
  }
  requiredObject(guestConsumption, "$.guestConsumption");
  const guestConsumptionCycle = requiredNonNegativeInteger(
    guestConsumption.cycle,
    "$.guestConsumption.cycle",
  );
  if (post.presentation.serial <= pre.presentation.serial) {
    transcriptFailure(
      "$.postReport.mmioState.viInterruptModel.lastHostPresentationSerial",
      `expected a value greater than ${pre.presentation.serial}`,
    );
  }
  if (post.presentation.cycle < publication.observedCycle) {
    transcriptFailure(
      "$.postReport.mmioState.viInterruptModel.lastHostPresentationCycle",
      `expected a presentation at or after input cycle ${publication.observedCycle}`,
    );
  }
  if (post.presentation.cycle < guestConsumptionCycle) {
    transcriptFailure(
      "$.postReport.mmioState.viInterruptModel.lastHostPresentationCycle",
      `expected a presentation at or after guest input latch cycle ${guestConsumptionCycle}`,
    );
  }
  if (post.presentation.rgbSha256 === pre.presentation.rgbSha256) {
    transcriptFailure(
      "$.postReport.rendering.selectedXfb.rgbSha256",
      "expected a visual state change after the controller publication",
    );
  }

  return Object.freeze({
    schema: GAME_FIRST_PLAYABLE_TRANSCRIPT_SCHEMA,
    game: Object.freeze({
      key: game.key,
      disc: Object.freeze({ ...game.disc }),
      image: Object.freeze({ ...game.image }),
      milestone: Object.freeze({ ...game.milestone }),
    }),
    surface: "local-debug",
    reports: Object.freeze({ pre, post }),
    input: Object.freeze({
      name: button,
      mask,
      publication,
      mode: "guest-consumed",
      guestConsumption,
    }),
    change: Object.freeze({
      kind: "visual",
      path: VISUAL_CHANGE_PATH,
      before: pre.presentation.rgbSha256,
      after: post.presentation.rgbSha256,
      observedCycle: post.presentation.cycle,
    }),
    window,
  });
}

export function verifyGameFirstPlayableTranscriptCore({
  button,
  corpus,
  gameKey,
  guestProjector = null,
  postReport,
  preReport,
  transcript,
}) {
  requiredObject(transcript, "$.transcript");
  const derived = deriveGameFirstPlayableTranscriptCore({
    button,
    corpus,
    gameKey,
    guestProjector,
    postReport,
    preReport,
  });
  const difference = firstDifference(derived, transcript);
  if (difference !== null) {
    transcriptFailure(
      `$.transcript${difference.slice(1)}`,
      "stored transcript does not match the supplied reports",
    );
  }
  return transcript;
}
