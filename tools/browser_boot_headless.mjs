#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import { rename, writeFile } from "node:fs/promises";

function parseArguments(argv) {
  const options = {
    endpoint: "http://127.0.0.1:9222",
    extendCycles: null,
    extendDispatches: undefined,
    pollMs: 250,
    pulseMs: 500,
    pulses: [],
    renderEvery: null,
    reuse: false,
    timeoutMs: 300_000,
    output: null,
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
      case "--endpoint":
        options.endpoint = value();
        break;
      case "--extend-cycles":
        options.extendCycles = Number(value());
        break;
      case "--extend-dispatches":
        options.extendDispatches = Number(value());
        break;
      case "--output":
        options.output = value();
        break;
      case "--poll-ms":
        options.pollMs = Number(value());
        break;
      case "--pulse": {
        const [name, delayText] = value().split(":", 2);
        const delayMs = delayText === undefined ? 0 : Number(delayText);
        options.pulses.push({ delayMs, name });
        break;
      }
      case "--pulse-ms":
        options.pulseMs = Number(value());
        break;
      case "--reuse":
        options.reuse = true;
        break;
      case "--render-every":
        options.renderEvery = Number(value());
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(value());
        break;
      case "--url":
        options.url = value();
        break;
      default:
        throw new Error(`unknown argument ${argument}`);
    }
  }
  if (!options.reuse && options.url === null) throw new Error("--url is required without --reuse");
  if (options.reuse && options.extendCycles === null) {
    throw new Error("--reuse requires --extend-cycles");
  }
  if (
    options.extendCycles !== null
    && (!Number.isInteger(options.extendCycles) || options.extendCycles <= 0)
  ) {
    throw new Error("--extend-cycles must be a positive integer");
  }
  if (
    options.extendDispatches !== undefined
    && (!Number.isInteger(options.extendDispatches) || options.extendDispatches <= 0)
  ) {
    throw new Error("--extend-dispatches must be a positive integer");
  }
  if (!Number.isInteger(options.pulseMs) || options.pulseMs <= 0) {
    throw new Error("--pulse-ms must be a positive integer");
  }
  if (
    options.renderEvery !== null
    && (!Number.isInteger(options.renderEvery)
      || options.renderEvery < 1
      || options.renderEvery > 1000)
  ) {
    throw new Error("--render-every must be an integer from 1 through 1000");
  }
  const validPulses = new Set(["a", "b", "down", "left", "right", "start", "up"]);
  for (const pulse of options.pulses) {
    if (!validPulses.has(pulse.name)) {
      throw new Error(`unsupported controller pulse ${pulse.name}`);
    }
    if (!Number.isInteger(pulse.delayMs) || pulse.delayMs < 0) {
      throw new Error(`controller pulse delay must be a non-negative integer: ${pulse.delayMs}`);
    }
  }
  if (!Number.isInteger(options.pollMs) || options.pollMs < 10) {
    throw new Error("--poll-ms must be an integer >= 10");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < options.pollMs) {
    throw new Error("--timeout-ms must be an integer >= --poll-ms");
  }
  return options;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class DevToolsSession {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
    this.socket = new WebSocket(url);
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

async function pageState(session) {
  return session.evaluate(`(() => {
    const result = document.querySelector("#result")?.textContent?.trim() ?? "";
    return {
      dataset: Object.fromEntries(Object.entries(document.body?.dataset ?? {})),
      readyState: document.readyState,
      result,
      runnerAvailable: typeof globalThis.lazuliCycleRunner === "object",
      runnerStatus: document.querySelector("#runner-status")?.textContent ?? "",
      title: document.title,
      url: location.href,
    };
  })()`);
}

async function waitForRunner(session, deadline, pollMs) {
  let state = null;
  while (Date.now() < deadline) {
    state = await pageState(session);
    if (state.runnerAvailable) return state;
    await delay(pollMs);
  }
  throw new Error(`existing page has no cycle runner: ${JSON.stringify(state)}`);
}

async function extendExistingRun(session, options, deadline) {
  const state = await waitForRunner(session, deadline, options.pollMs);
  const previous = parseReport(state.result);
  const action = {
    extendCycles: options.extendCycles,
    extendDispatches: options.extendDispatches,
    pulseMs: options.pulseMs,
    pulses: options.pulses,
    renderEvery: options.renderEvery,
  };
  await session.evaluate(`(() => {
    const action = ${JSON.stringify(action)};
    const method = {
      a: "pulseA",
      b: "pulseB",
      down: "pulseDown",
      left: "pulseLeft",
      right: "pulseRight",
      start: "pulseStart",
      up: "pulseUp",
    };
    const output = document.querySelector("#result");
    if (output !== null) output.textContent = "";
    if (action.renderEvery !== null) {
      globalThis.lazuliCycleRunner.setRenderEvery(action.renderEvery);
    }
    for (const pulse of action.pulses) {
      setTimeout(() => {
        globalThis.lazuliController[method[pulse.name]](action.pulseMs);
      }, pulse.delayMs);
    }
    globalThis.lazuliCycleRunner.extendCycles(
      action.extendCycles,
      action.extendDispatches,
    );
  })()`);
  return {
    action,
    previous: previous === null ? null : {
      cycles: previous.cycles,
      dispatches: previous.dispatches,
      instructions: previous.instructions,
      pc: previous.pc,
      stage: previous.stage,
      status: previous.status,
    },
    url: state.url,
  };
}

async function persist(output, report) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output === null) {
    process.stdout.write(text);
    return;
  }
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, output);
  process.stdout.write(`${output}\n`);
}

function parseReport(text) {
  if (!text.startsWith("{")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const target = await pageTarget(options.endpoint);
  const session = new DevToolsSession(target.webSocketDebuggerUrl);
  await session.connect();
  try {
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    const deadline = Date.now() + options.timeoutMs;
    let reuseCapture = null;
    if (options.reuse) {
      reuseCapture = await extendExistingRun(session, options, deadline);
    } else {
      await session.send("Page.navigate", { url: options.url });
    }

    let state = null;
    while (Date.now() < deadline) {
      state = await pageState(session);
      const report = parseReport(state.result);
      if (report !== null) {
        report.headlessCapture = {
          dataset: state.dataset,
          devtoolsExceptions: session.exceptions,
          pageTitle: state.title,
          reuse: reuseCapture,
          url: state.url,
        };
        await persist(options.output, report);
        return;
      }
      await delay(options.pollMs);
    }

    state = await pageState(session);
    if (state.runnerAvailable) {
      await session.evaluate("globalThis.lazuliCycleRunner.snapshot()");
      const snapshotDeadline = Date.now() + 5_000;
      while (Date.now() < snapshotDeadline) {
        await delay(options.pollMs);
        state = await pageState(session);
        const report = parseReport(state.result);
        if (report !== null) {
          report.headlessCapture = {
            dataset: state.dataset,
            devtoolsExceptions: session.exceptions,
            pageTitle: state.title,
            reuse: reuseCapture,
            timedOut: true,
            url: state.url,
          };
          await persist(options.output, report);
          process.exitCode = 124;
          return;
        }
      }
    }
    throw new Error(
      `browser boot timed out without a report: ${JSON.stringify(state)}`
    );
  } finally {
    session.close();
  }
}

main().catch(error => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
