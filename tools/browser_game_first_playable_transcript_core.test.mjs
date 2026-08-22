#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import { checkpointSha256 } from "./browser_boot_checkpoint_core.mjs";
import { readGameCompatibilityCorpus } from "./browser_game_compatibility_corpus.mjs";
import {
  GAME_FIRST_PLAYABLE_TRANSCRIPT_SCHEMA,
  deriveGameFirstPlayableTranscriptCore,
  verifyGameFirstPlayableTranscriptCore,
} from "./browser_game_first_playable_transcript_core.mjs";

import {
  makeGameFirstPlayableReportPair,
} from "./browser_game_first_playable_test_fixture.mjs";

test("first-playable transcripts use the v2 compatibility contract", () => {
  assert.equal(
    GAME_FIRST_PLAYABLE_TRANSCRIPT_SCHEMA,
    "lazuli-game-first-playable-transcript-v2",
  );
});

function projectFixtureGuestConsumption({ button, game, publication }) {
  return Object.freeze({
    kind: "fixture-guest-consumption-v1",
    button,
    cycle: publication.observedCycle,
    game: game.key,
  });
}

function publicSnapshot(game, report) {
  const capture = report.headlessCapture;
  delete report.headlessCapture;
  report.disc.source = { kind: "local-file" };
  return {
    environment: {
      surface: "public-root",
      dataset: structuredClone(capture.dataset),
      devtoolsExceptions: [],
      discImage: {
        algorithm: "sha256",
        format: game.image.format,
        sha256: game.image.sha256,
      },
    },
    report,
  };
}

test("generic core derives directly from public-root pre/post snapshots", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games[1];
  const reports = makeGameFirstPlayableReportPair(game, "left");
  const preSnapshot = publicSnapshot(game, reports.preReport);
  const postSnapshot = publicSnapshot(game, reports.postReport);
  const transcript = deriveGameFirstPlayableTranscriptCore({
    button: "left",
    corpus,
    gameKey: game.key,
    guestProjector: projectFixtureGuestConsumption,
    preSnapshot,
    postSnapshot,
  });

  assert.equal(transcript.surface, "public-root");
  assert.equal(transcript.input.name, "left");
  assert.equal(transcript.input.mode, "guest-consumed");
  assert.equal(Object.hasOwn(preSnapshot.report, "headlessCapture"), false);
  assert.equal(Object.hasOwn(postSnapshot.report, "headlessCapture"), false);
  assert.strictEqual(
    verifyGameFirstPlayableTranscriptCore({
      button: "left",
      corpus,
      gameKey: game.key,
      guestProjector: projectFixtureGuestConsumption,
      preSnapshot,
      postSnapshot,
      transcript,
    }),
    transcript,
  );
});

test("public-root snapshot mode rejects incomplete, mixed, and drifting evidence", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games[1];
  const makeSnapshots = () => {
    const reports = makeGameFirstPlayableReportPair(game, "left");
    return {
      reports,
      preSnapshot: publicSnapshot(game, reports.preReport),
      postSnapshot: publicSnapshot(game, reports.postReport),
    };
  };

  {
    const { preSnapshot } = makeSnapshots();
    assert.throws(
      () => deriveGameFirstPlayableTranscriptCore({
        button: "left",
        corpus,
        gameKey: game.key,
        guestProjector: projectFixtureGuestConsumption,
        preSnapshot,
      }),
      /expected both preSnapshot and postSnapshot/,
    );
  }
  {
    const { postSnapshot, preSnapshot, reports } = makeSnapshots();
    assert.throws(
      () => deriveGameFirstPlayableTranscriptCore({
        button: "left",
        corpus,
        gameKey: game.key,
        guestProjector: projectFixtureGuestConsumption,
        preReport: reports.preReport,
        preSnapshot,
        postSnapshot,
      }),
      /exactly one complete pre\/post report pair or public-root snapshot pair/,
    );
  }
  {
    const { postSnapshot, preSnapshot } = makeSnapshots();
    preSnapshot.report.disc.source.size = 1;
    postSnapshot.report.disc.source.size = 2;
    assert.throws(
      () => deriveGameFirstPlayableTranscriptCore({
        button: "left",
        corpus,
        gameKey: game.key,
        guestProjector: projectFixtureGuestConsumption,
        preSnapshot,
        postSnapshot,
      }),
      /disc source changed across the observed worker run/,
    );
  }
  {
    const { postSnapshot, preSnapshot } = makeSnapshots();
    postSnapshot.environment.dataset.renderer = "canvas-2d";
    assert.throws(
      () => deriveGameFirstPlayableTranscriptCore({
        button: "left",
        corpus,
        gameKey: game.key,
        guestProjector: projectFixtureGuestConsumption,
        preSnapshot,
        postSnapshot,
      }),
      /dataset\.renderer.*wgpu-webgpu/,
    );
  }
});

test("generic core accepts per-game guest-consumption projectors", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const expectedIdentifiers = new Set([
    "GZWE01",
    "GLME01",
    "GZLE01",
    "GALE01",
    "GFZE01",
    "GM8E01",
    "GSWE64",
  ]);
  assert.equal(corpus.games.length, 7);
  assert.deepEqual(
    new Set(corpus.games.map(game => game.disc.identifier)),
    expectedIdentifiers,
  );

  for (const game of corpus.games) {
    const reports = makeGameFirstPlayableReportPair(game);
    const transcript = deriveGameFirstPlayableTranscriptCore({
      button: "a",
      corpus,
      gameKey: game.key,
      guestProjector: projectFixtureGuestConsumption,
      ...reports,
    });
    assert.equal(transcript.schema, GAME_FIRST_PLAYABLE_TRANSCRIPT_SCHEMA);
    assert.equal(transcript.game.key, game.key);
    assert.deepEqual(transcript.game.disc, game.disc);
    assert.deepEqual(transcript.game.image, game.image);
    assert.deepEqual(transcript.game.milestone, game.milestone);
    assert.equal(transcript.surface, "local-debug");
    assert.equal(transcript.input.mask, 0x0100);
    assert.equal(transcript.input.mode, "guest-consumed");
    assert.deepEqual(transcript.input.guestConsumption, {
      kind: "fixture-guest-consumption-v1",
      button: "a",
      cycle: reports.postReport.controller.lastActiveHostPublication.observedCycle,
      game: game.key,
    });
    assert.deepEqual(
      transcript.input.publication,
      reports.postReport.controller.lastActiveHostPublication,
    );
    assert.equal(transcript.change.kind, "visual");
    assert.notEqual(transcript.change.before, transcript.change.after);
    assert.ok(transcript.window.delta.viFields >= corpus.evidence.sustainedViFields);
    assert.ok(
      transcript.window.delta.hostPresentations
        >= corpus.evidence.viewportFrames,
    );
    assert.ok(
      transcript.window.delta.presentationSerial
        >= corpus.evidence.viewportFrames,
    );
    assert.equal(
      transcript.reports.pre.sha256,
      checkpointSha256(reports.preReport),
    );
    assert.equal(
      transcript.reports.post.sha256,
      checkpointSha256(reports.postReport),
    );
    assert.strictEqual(
      verifyGameFirstPlayableTranscriptCore({
        button: "a",
        corpus,
        gameKey: game.key,
        guestProjector: projectFixtureGuestConsumption,
        transcript,
        ...reports,
      }),
      transcript,
    );
  }
});

test("generic core rejects absent or null guest-consumption projectors", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games[1];
  const reports = makeGameFirstPlayableReportPair(game);
  assert.throws(
    () => deriveGameFirstPlayableTranscriptCore({
      button: "a",
      corpus,
      gameKey: game.key,
      ...reports,
    }),
    /requires a guest-consumption projector/,
  );
  assert.throws(
    () => deriveGameFirstPlayableTranscriptCore({
      button: "a",
      corpus,
      gameKey: game.key,
      guestProjector: () => null,
      ...reports,
    }),
    /no guest-consumption projector is available/,
  );
  assert.throws(
    () => deriveGameFirstPlayableTranscriptCore({
      button: "a",
      corpus,
      gameKey: game.key,
      guestProjector: () => ({}),
      ...reports,
    }),
    /guestConsumption\.cycle/,
  );
});

test("generic core retains exact direct directional provenance", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games[1];
  const reports = makeGameFirstPlayableReportPair(game, "left");
  reports.postReport.controller.lastActiveHostPublication.source = "direct";
  reports.postReport.controller.lastActiveHostPublication.scheduledCycle =
    reports.preReport.cycles;
  reports.postReport.controller.lastActiveHostPublication.observedCycle =
    reports.preReport.cycles;
  const transcript = deriveGameFirstPlayableTranscriptCore({
    button: "left",
    corpus,
    gameKey: game.key,
    guestProjector: projectFixtureGuestConsumption,
    ...reports,
  });
  assert.deepEqual(transcript.input, {
    name: "left",
    mask: 0x0001,
    publication: {
      ...reports.postReport.controller.lastActiveHostPublication,
    },
    mode: "guest-consumed",
    guestConsumption: {
      kind: "fixture-guest-consumption-v1",
      button: "left",
      cycle: reports.postReport.controller.lastActiveHostPublication.observedCycle,
      game: game.key,
    },
  });
});

test("generic publication, continuity, and visual causality fail closed", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games[1];
  const cases = [
    {
      name: "missing publication",
      mutate({ postReport }) {
        postReport.controller.lastActiveHostPublication = null;
      },
      pattern: /lastActiveHostPublication.*expected an object/,
    },
    {
      name: "publication extension",
      mutate({ postReport }) {
        postReport.controller.lastActiveHostPublication.channel = 0;
      },
      pattern: /lastActiveHostPublication\.\[keys\]/,
    },
    {
      name: "scenario publication",
      mutate({ postReport }) {
        postReport.controller.lastActiveHostPublication.source = "scenario";
      },
      pattern: /expected periodic or direct/,
    },
    {
      name: "wrong button",
      mutate({ postReport }) {
        postReport.controller.lastActiveHostPublication.buttons = 0x0200;
      },
      pattern: /lastActiveHostPublication\.buttons/,
    },
    {
      name: "pre-existing publication",
      mutate({ postReport, preReport }) {
        postReport.controller.lastActiveHostPublication.scheduledCycle =
          preReport.cycles - 1;
      },
      pattern: /expected publication within cycles/,
    },
    {
      name: "future publication",
      mutate({ postReport }) {
        postReport.controller.lastActiveHostPublication.observedCycle =
          postReport.cycles + 1;
      },
      pattern: /expected publication within cycles/,
    },
    {
      name: "stale sequence",
      mutate({ postReport, preReport }) {
        postReport.controller.lastActiveHostPublication.sequence =
          preReport.controller.appliedSequence;
      },
      pattern: /lastActiveHostPublication\.sequence/,
    },
    {
      name: "stale poll",
      mutate({ postReport, preReport }) {
        postReport.controller.lastActiveHostPublication.pollIndex =
          preReport.controller.pollIndex;
      },
      pattern: /lastActiveHostPublication\.pollIndex/,
    },
    {
      name: "previous report mismatch",
      mutate({ postReport }) {
        postReport.headlessCapture.reuse.previous.cycles += 1;
      },
      pattern: /reuse\.previous\.cycles/,
    },
    {
      name: "worker URL mismatch",
      mutate({ postReport }) {
        postReport.headlessCapture.url =
          "http://127.0.0.1:8765/index.html?headlessRun=other";
      },
      pattern: /headlessCapture\.url/,
    },
    {
      name: "disc source mismatch",
      mutate({ postReport }) {
        postReport.disc.source.url = "http://localhost:8765/disc";
      },
      pattern: /disc source changed/,
    },
    {
      name: "wrong captured pulse",
      mutate({ postReport }) {
        postReport.headlessCapture.reuse.action.pulses[0].name = "b";
      },
      pattern: /action\.pulses\[0\]\.name/,
    },
    {
      name: "automated scenario",
      mutate({ postReport }) {
        postReport.scenario = { id: "automated" };
      },
      pattern: /postReport\.scenario/,
    },
    {
      name: "presentation before input",
      mutate({ postReport }) {
        postReport.mmioState.viInterruptModel.lastHostPresentationCycle =
          postReport.controller.lastActiveHostPublication.observedCycle - 1;
      },
      pattern: /lastHostPresentationCycle/,
    },
    {
      name: "no visual change",
      mutate({ postReport, preReport }) {
        postReport.rendering.selectedXfb.rgbSha256 =
          preReport.rendering.selectedXfb.rgbSha256;
      },
      pattern: /two distinct|visual state change/,
    },
    {
      name: "renderer fallback",
      mutate({ postReport }) {
        postReport.rendering.backend = "canvas-2d";
      },
      pattern: /wgpu-webgpu/,
    },
  ];

  for (const { mutate, name, pattern } of cases) {
    const reports = makeGameFirstPlayableReportPair(game);
    mutate(reports);
    assert.throws(
      () => deriveGameFirstPlayableTranscriptCore({
        button: "a",
        corpus,
        gameKey: game.key,
        guestProjector: projectFixtureGuestConsumption,
        ...reports,
      }),
      pattern,
      name,
    );
  }
});

test("generic stored transcripts bind both complete reports", async () => {
  const corpus = await readGameCompatibilityCorpus();
  const game = corpus.games[1];
  const reports = makeGameFirstPlayableReportPair(game);
  const transcript = deriveGameFirstPlayableTranscriptCore({
    button: "a",
    corpus,
    gameKey: game.key,
    guestProjector: projectFixtureGuestConsumption,
    ...reports,
  });
  const changed = structuredClone(transcript);
  changed.change.after = "f".repeat(64);
  assert.throws(
    () => verifyGameFirstPlayableTranscriptCore({
      button: "a",
      corpus,
      gameKey: game.key,
      guestProjector: projectFixtureGuestConsumption,
      transcript: changed,
      ...reports,
    }),
    /transcript\.change\.after/,
  );

  const changedReport = structuredClone(reports.postReport);
  changedReport.headlessCapture.pageTitle = "Changed host-only title";
  assert.notEqual(checkpointSha256(changedReport), transcript.reports.post.sha256);
  assert.throws(
    () => verifyGameFirstPlayableTranscriptCore({
      button: "a",
      corpus,
      gameKey: game.key,
      guestProjector: projectFixtureGuestConsumption,
      postReport: changedReport,
      preReport: reports.preReport,
      transcript,
    }),
    /transcript\.reports\.post\.sha256/,
  );
});
