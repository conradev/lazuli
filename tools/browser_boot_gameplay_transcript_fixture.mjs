// SPDX-License-Identifier: GPL-3.0-only

import {
  SMB_READY_PLAY_GAMEPLAY_PLAN,
} from "./browser_boot_gameplay_transcript.mjs";

function witness(cycle, seed, planned) {
  const state = {
    cycle,
    pad: { held: 0, pressed: 0, released: 0 },
    gameModeRequest: -1,
    gameMode: seed >= 10 ? 2 : seed >= 4 ? 1 : 0,
    gameSubmodeRequest: -1,
    gameSubmode: seed >= 12 ? 51 : seed >= 4 ? 32 : 20,
    warningState: seed === 0 ? 2 : 0,
    warningDialogPhase: seed === 0 ? 0xff : 0,
    warningDialogFlags: seed === 0 ? 0x2260 : 0,
    submodeTimer: seed * 17,
    difficulty: 0,
    flags: seed === 2 ? 0x2000 : seed >= 10 ? 0x0101 : 0,
    titleChoice: 0,
    menuSelection: 0,
    playerCount: 1,
    gameType: 0,
    currentPlayer: 0,
    characterSelection0: 0,
    textBoxState: seed < 4 ? 10 : 0,
    textBoxTimer: seed < 4 ? 61 : 0,
    selectorCurrent: seed >= 5 && seed <= 9 ? [8, 10, 16, 18, 22][seed - 5] : 0,
    selectorRequest: -1,
    selectorChoice: 0,
    characterLocked0: seed >= 10 ? 1 : 0,
    infoFlags: 0,
    infoTimer: seed * 29,
    attempts: seed >= 10 ? 1 : 0,
    floor: seed >= 10 ? 1 : 0,
    pauseStatus: 0,
    inputLockStatus: 0,
    demoSkipTimer: seed === 2 ? 26 : 0,
    demoResourcesReady: 1,
    gameVersion: 0,
    viPresentationCount: 100 + seed,
    viLastPresentationCycle: cycle - 3,
    viLastPresentationCopyIndex: 80 + seed,
    gxXfbCopyCount: 81 + seed,
    xfbCaptured: true,
    rendererFramesAcknowledged: 200 + seed,
  };
  for (const [field, value] of Object.entries(planned.witness)) {
    state[field] = field === "pad" ? { ...value } : value;
  }
  return state;
}

function phase(sequence, buttons, firstPoll, firstCycle) {
  const publications = Array.from(
    { length: SMB_READY_PLAY_GAMEPLAY_PLAN.input.publicationsPerPhase },
    (_unused, index) => ({
      source: SMB_READY_PLAY_GAMEPLAY_PLAN.input.source,
      pollIndex: firstPoll + index,
      scheduledCycle: firstCycle + index * 10,
      observedCycle: firstCycle + index * 10 + 2,
      buttons,
      sequence,
    }),
  );
  return {
    sequence,
    polls: publications.length,
    publications,
    firstPollIndex: publications[0].pollIndex,
    lastPollIndex: publications.at(-1).pollIndex,
    firstScheduledCycle: publications[0].scheduledCycle,
    lastScheduledCycle: publications.at(-1).scheduledCycle,
    firstObservedCycle: publications[0].observedCycle,
    lastObservedCycle: publications.at(-1).observedCycle,
  };
}

export function gameplayReport() {
  let cycle = 0;
  let pollIndex = 0;
  let sequence = 1;
  const steps = [];
  for (const [index, planned] of SMB_READY_PLAY_GAMEPLAY_PLAN.steps.entries()) {
    if (planned.type === "observe") {
      cycle += 50;
      pollIndex += 2;
      steps.push({
        id: planned.id,
        type: "observe",
        observedCycle: cycle,
        observedPollIndex: pollIndex,
        state: witness(cycle, index, planned),
      });
      continue;
    }

    const readyCycle = cycle + 100;
    const readyPollIndex = pollIndex + 4;
    const press = phase(sequence, planned.button, readyPollIndex + 1, readyCycle + 10);
    const release = phase(
      sequence + 1,
      0,
      press.lastPollIndex + 1,
      press.lastScheduledCycle + 10,
    );
    const guest = {
      pressedCycle: press.firstObservedCycle + 1,
      releasedCycle: release.firstObservedCycle + 1,
      neutralCycle: release.lastObservedCycle + 1,
    };
    cycle = guest.neutralCycle + 1;
    pollIndex = release.lastPollIndex;
    steps.push({
      id: planned.id,
      type: "input",
      button: planned.button,
      readyCycle,
      readyPollIndex,
      readyState: witness(readyCycle, index, planned),
      press,
      release,
      guest,
      completedCycle: cycle,
      completedPollIndex: pollIndex,
    });
    sequence += 2;
  }

  return {
    status: "paused",
    stage: "scenario-complete",
    title: "Super Monkey Ball (GMBE8P Rev.00)",
    cycles: cycle,
    disc: {
      identifier: "GMBE8P",
      revision: 0,
      source: {
        kind: "local-file",
        name: "Super Monkey Ball (USA).ciso",
        cache: { hits: 17, misses: 9 },
      },
    },
    scenario: {
      id: "smb-ready-play",
      gameIdentifier: "GMBE8P",
      status: "complete",
      hardCycleLimit: 30_000_000_000,
      startCycle: 0,
      completedCycle: cycle,
      failure: null,
      stepIndex: steps.length,
      currentStep: null,
      pollIndex,
      lastState: structuredClone(steps.at(-1).state),
      steps,
    },
    controller: {
      sequence: 2,
      appliedSequence: 18,
      pollIndex,
      pendingButtons: 0,
      queuedStates: 0,
      queueCapacity: 64,
      queueHighWater: 0,
      queueCoalesces: 1,
      queueOverflows: 0,
      lastPolledButtons: 0,
      lastPolledSequence: 18,
    },
    execution: {
      scheduler: {
        sliceMs: 12,
        rendererSync: { posted: 400, acknowledged: 400, failed: 0 },
      },
    },
    rendering: { backend: "wgpu-webgpu" },
    headlessCapture: {
      url: "http://127.0.0.1:8766/?scenario=smb-ready-play",
      runtime: "Fixture Browser/1.0",
    },
  };
}

function projectedWitness(state) {
  return {
    pad: {
      held: state.pad.held,
      pressed: state.pad.pressed,
      released: state.pad.released,
    },
    gameModeRequest: state.gameModeRequest,
    gameMode: state.gameMode,
    gameSubmodeRequest: state.gameSubmodeRequest,
    gameSubmode: state.gameSubmode,
    warningState: state.warningState,
    warningDialogPhase: state.warningDialogPhase,
    warningDialogFlags: state.warningDialogFlags,
    submodeTimer: state.submodeTimer,
    difficulty: state.difficulty,
    flags: state.flags,
    titleChoice: state.titleChoice,
    menuSelection: state.menuSelection,
    playerCount: state.playerCount,
    gameType: state.gameType,
    currentPlayer: state.currentPlayer,
    characterSelection0: state.characterSelection0,
    textBoxState: state.textBoxState,
    textBoxTimer: state.textBoxTimer,
    selectorCurrent: state.selectorCurrent,
    selectorRequest: state.selectorRequest,
    selectorChoice: state.selectorChoice,
    characterLocked0: state.characterLocked0,
    infoFlags: state.infoFlags,
    infoTimer: state.infoTimer,
    attempts: state.attempts,
    floor: state.floor,
    pauseStatus: state.pauseStatus,
    inputLockStatus: state.inputLockStatus,
    demoSkipTimer: state.demoSkipTimer,
    demoResourcesReady: state.demoResourcesReady,
    gameVersion: state.gameVersion,
  };
}

function projectedPublications(publications) {
  return publications.map(publication => ({
    source: publication.source,
    pollIndex: publication.pollIndex,
    scheduledCycle: publication.scheduledCycle,
    observedCycle: publication.observedCycle,
    buttons: publication.buttons,
    sequence: publication.sequence,
  }));
}

export function gameplayTranscript() {
  const report = gameplayReport();
  return {
    schema: "lazuli-browser-gameplay-transcript-v1",
    game: {
      identifier: report.disc.identifier,
      revision: report.disc.revision,
    },
    scenario: {
      id: report.scenario.id,
      status: report.scenario.status,
      hardCycleLimit: report.scenario.hardCycleLimit,
      startCycle: report.scenario.startCycle,
      completedCycle: report.scenario.completedCycle,
    },
    controller: {
      pollIndex: report.controller.pollIndex,
      appliedSequence: report.controller.appliedSequence,
      lastPolledSequence: report.controller.lastPolledSequence,
      lastPolledButtons: report.controller.lastPolledButtons,
      pendingButtons: report.controller.pendingButtons,
      queuedStates: report.controller.queuedStates,
      queueOverflows: report.controller.queueOverflows,
    },
    steps: report.scenario.steps.map(step => step.type === "input"
      ? {
          id: step.id,
          type: step.type,
          button: step.button,
          ready: {
            cycle: step.readyCycle,
            pollIndex: step.readyPollIndex,
            witness: projectedWitness(step.readyState),
          },
          press: {
            sequence: step.press.sequence,
            publications: projectedPublications(step.press.publications),
          },
          release: {
            sequence: step.release.sequence,
            publications: projectedPublications(step.release.publications),
          },
          guest: {
            pressedCycle: step.guest.pressedCycle,
            releasedCycle: step.guest.releasedCycle,
            neutralCycle: step.guest.neutralCycle,
          },
          completed: {
            cycle: step.completedCycle,
            pollIndex: step.completedPollIndex,
          },
        }
      : {
          id: step.id,
          type: step.type,
          observed: {
            cycle: step.observedCycle,
            pollIndex: step.observedPollIndex,
            witness: projectedWitness(step.state),
          },
        }),
  };
}

export function gameplayReportsForConsensus() {
  return Array.from({ length: 3 }, (_unused, index) => {
    const report = gameplayReport();
    report.disc.source.name = `/host-${index}/Super Monkey Ball (USA).ciso`;
    report.disc.source.cache.hits += index * 100;
    report.controller.sequence += index * 10;
    report.controller.queueCoalesces += index;
    report.execution.scheduler.sliceMs += index;
    report.headlessCapture.url = `http://localhost:${9000 + index}/?scenario=smb-ready-play`;
    report.headlessCapture.runtime = `Fixture Browser/${index + 1}.0`;
    return report;
  });
}
