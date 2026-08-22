// SPDX-License-Identifier: GPL-3.0-only

import { resolve } from "node:path";

const DISC_FILE_SELECTOR = "#disc-file";
const STALE_DOM_REFERENCE_ERRORS = [
  /(?:could not find|no) node with given id/i,
  /cannot find context with specified id/i,
  /document (?:was )?(?:updated|replaced)/i,
  /node with given id does not belong to the document/i,
];

function isStaleDomReferenceError(error) {
  const message = error?.message ?? String(error);
  return STALE_DOM_REFERENCE_ERRORS.some(pattern => pattern.test(message));
}

const ACTIVATE_ASSIGNED_DISC = `(() => {
  const input = document.querySelector("#disc-file");
  if (!(input instanceof HTMLInputElement) || input.type !== "file") {
    throw new Error("fresh document has no file input to activate");
  }
  const fileCount = input.files?.length ?? 0;
  if (fileCount !== 1) {
    throw new Error("assigned disc count is " + fileCount + ", expected 1");
  }
  const statusBefore = document.body?.dataset?.status ?? null;
  const discStatusBefore = document.querySelector("#disc-status")?.textContent ?? null;
  const dispatched = (statusBefore === null || statusBefore === "waiting")
    && discStatusBefore === "open a disc";
  if (dispatched) input.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    discStatus: document.querySelector("#disc-status")?.textContent ?? null,
    dispatched,
    fileCount,
    status: document.body?.dataset?.status ?? null,
  };
})()`;

async function assignedDiscActivation(session, discPath) {
  try {
    const response = await session.send("Runtime.evaluate", {
      awaitPromise: true,
      expression: ACTIVATE_ASSIGNED_DISC,
      returnByValue: true,
    });
    if (response.exceptionDetails !== undefined) {
      throw new Error(JSON.stringify(response.exceptionDetails));
    }
    return response.result?.value;
  } catch (error) {
    throw new Error(
      `could not activate --disc ${discPath} from ${DISC_FILE_SELECTOR}: ${error.message ?? String(error)}`,
    );
  }
}

export function resolveDiscPath(path, cwd = process.cwd()) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("--disc must name an ISO or CISO file");
  }
  return resolve(cwd, path);
}

export async function attachDiscAfterFreshNavigation(
  session,
  {
    deadline,
    discPath,
    navigationLoaderId,
    pollMs,
    runUrl,
  },
  {
    delay,
    isExpectedNavigation,
    now = Date.now,
    observePage,
    pageState,
  },
) {
  let lastFrameLoaderId = null;
  let lastStaleDomError = null;
  let lastState = null;
  let navigationConfirmed = false;

  while (now() < deadline) {
    const observation = await observePage(session, {
      deadline,
      includeFrameTree: true,
    }, { now, pageState });
    lastState = observation.state;
    lastFrameLoaderId = observation.frameLoaderId;
    if (!isExpectedNavigation(
      lastState,
      runUrl,
      navigationLoaderId,
      lastFrameLoaderId,
    )) {
      await delay(pollMs);
      continue;
    }

    navigationConfirmed = true;
    if (lastState.readyState !== "interactive" && lastState.readyState !== "complete") {
      await delay(pollMs);
      continue;
    }

    let domMethod = "DOM.enable";
    try {
      await session.send(domMethod);
      domMethod = "DOM.getDocument";
      const document = await session.send(domMethod, {
        depth: 0,
        pierce: true,
      });
      const rootNodeId = document.root?.nodeId;
      if (!Number.isInteger(rootNodeId) || rootNodeId <= 0) {
        throw new Error(
          `fresh document has no DOM root for ${DISC_FILE_SELECTOR}`,
        );
      }
      domMethod = "DOM.querySelector";
      const match = await session.send(domMethod, {
        nodeId: rootNodeId,
        selector: DISC_FILE_SELECTOR,
      });
      if (!Number.isInteger(match.nodeId) || match.nodeId <= 0) {
        throw new Error(
          `fresh document ${runUrl} does not contain ${DISC_FILE_SELECTOR}`,
        );
      }
      domMethod = "DOM.setFileInputFiles";
      await session.send("DOM.setFileInputFiles", {
        files: [discPath],
        nodeId: match.nodeId,
      });
    } catch (error) {
      if (isStaleDomReferenceError(error)) {
        lastStaleDomError = error.message ?? String(error);
        await delay(pollMs);
        continue;
      }
      if (domMethod !== "DOM.setFileInputFiles") throw error;
      throw new Error(
        `could not assign --disc ${discPath} to ${DISC_FILE_SELECTOR}: ${error.message ?? String(error)}`,
      );
    }
    let activation = await assignedDiscActivation(session, discPath);
    while (true) {
      if (
        activation !== null
        && typeof activation === "object"
        && activation.fileCount === 1
        && typeof activation.discStatus === "string"
        && activation.discStatus.startsWith("local: ")
        && typeof activation.status === "string"
        && activation.status !== "waiting"
      ) {
        return lastState;
      }
      if (activation?.fileCount !== 1 || now() >= deadline) break;
      await delay(pollMs);
      activation = await assignedDiscActivation(session, discPath);
    }
    throw new Error(
      `assigned --disc did not start the fresh document: ${JSON.stringify(activation ?? null)}`,
    );
  }

  if (navigationConfirmed) {
    if (lastStaleDomError !== null) {
      throw new Error(
        `fresh document changed before assigning --disc to ${DISC_FILE_SELECTOR}: ${lastStaleDomError}`,
      );
    }
    throw new Error(
      `fresh document did not become ready before assigning --disc to ${DISC_FILE_SELECTOR}`,
    );
  }
  throw new Error(
    `fresh navigation was not confirmed before assigning --disc to ${DISC_FILE_SELECTOR}: ${JSON.stringify({
      expectedLoaderId: navigationLoaderId,
      expectedUrl: runUrl,
      lastFrameLoaderId,
      lastUrl: lastState?.url ?? null,
    })}`,
  );
}
