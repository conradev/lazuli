// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const DISC_IDENTITY_PREFIX_BYTES = 0x20;
const GAMECUBE_ISO_MAGIC = 0xc233_9f3d;

function discImageFormat(prefix, path) {
  if (prefix.length >= 4 && prefix.subarray(0, 4).toString("ascii") === "CISO") {
    return "ciso";
  }
  if (
    prefix.length >= DISC_IDENTITY_PREFIX_BYTES
    && prefix.readUInt32BE(0x1c) === GAMECUBE_ISO_MAGIC
  ) {
    return "iso";
  }
  throw new Error(`unsupported --disc image format: ${path}`);
}

export async function identifyLocalDiscImage(path) {
  const hash = createHash("sha256");
  let prefix = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    if (prefix.length < DISC_IDENTITY_PREFIX_BYTES) {
      const needed = DISC_IDENTITY_PREFIX_BYTES - prefix.length;
      prefix = Buffer.concat([prefix, chunk.subarray(0, needed)]);
    }
  }
  const format = discImageFormat(prefix, path);
  return Object.freeze({
    algorithm: "sha256",
    format,
    sha256: hash.digest("hex"),
  });
}
