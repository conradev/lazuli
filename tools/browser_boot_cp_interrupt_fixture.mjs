// SPDX-License-Identifier: GPL-3.0-only

import { readFileSync } from "node:fs";

import {
  configureCp,
  makeContext,
} from "./browser_boot_gx_transport_fixture.mjs";

export { makeContext };

export const browserBootSource = readFileSync(new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
), "utf8");

export function configureInterruptingCp(context, {
  base = 0x100,
  end = 0x160,
  distance = 0,
  control = 0,
  highWatermark = 0x100,
  lowWatermark = 0,
  readPointer = base,
  writePointer = readPointer,
  breakpoint = 0,
} = {}) {
  configureCp(context, { base, end, pointer: readPointer, distance, control });
  Object.assign(context.cpFifoState, {
    highWatermark,
    lowWatermark,
    readPointer,
    writePointer,
    breakpoint,
  });
}

export function readPiCause(context) {
  return context.view.getUint32(context.mmio + 0x3000, false);
}

export function writePiCauseStorage(context, value) {
  context.view.setUint32(context.mmio + 0x3000, value >>> 0, false);
}

export function writePiMask(context, value) {
  context.view.setUint32(context.mmio + 0x3004, value >>> 0, false);
}
