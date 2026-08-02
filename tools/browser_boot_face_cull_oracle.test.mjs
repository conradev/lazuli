#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFaceCullOraclePacket,
  evaluateFaceCullOracleCase,
  faceCullOracleCases,
  faceCullOracleXfb,
} from "./browser_boot_face_cull_oracle.mjs";
import {
  projectionNullOracleCase,
  projectionNullPacketLayout,
} from "./browser_boot_projection_null_oracle.mjs";

function diagnostics({
  aggregate = 0,
  exactPreparation = 0,
  uncertifiedFaceCull = 0,
  renderPipelinesCreated = 0,
} = {}) {
  return {
    exactRequiredRejectedDraws: aggregate,
    exactRequiredRejectionReasons: {
      exactPreparation,
      sampler: 0,
    },
    exactRequiredPreparationRejectionReasons: {
      unsupportedClipDisable7: 0,
      uncertifiedFaceCull,
    },
    renderPipelinesCreated,
  };
}

function readback(rgba) {
  return {
    width: faceCullOracleXfb.width,
    height: faceCullOracleXfb.height,
    rgba: Uint8Array.from(rgba),
  };
}

test("face-cull packets pair each raw mode with matching native winding", () => {
  assert.deepEqual(
    faceCullOracleCases.map((entry) => [
      entry.id,
      entry.cullMode,
      entry.exactClipRequired,
      entry.reverseNativeWinding,
    ]),
    [
      ["required-back", 1, true, false],
      ["required-front", 2, true, true],
      ["optional-back", 1, false, false],
      ["optional-front", 2, false, true],
    ],
  );

  for (const entry of faceCullOracleCases) {
    const packet = buildFaceCullOraclePacket(entry.id, 7);
    const draw = projectionNullPacketLayout.drawOffset;
    const exact = projectionNullPacketLayout.exactChunkOffset;
    const view = new DataView(
      packet.buffer,
      packet.byteOffset,
      packet.byteLength,
    );
    assert.equal(packet[draw + 0x01], entry.cullMode);
    assert.equal(
      view.getUint32(exact + 0x04, true),
      entry.cullMode << 14,
    );
    assert.equal(
      view.getUint16(draw + 0x02, true),
      entry.exactClipRequired ? 6 : 2,
    );
  }
  assert.throws(
    () => buildFaceCullOraclePacket("missing", 7),
    /unknown face-cull oracle case/,
  );
});

test("required face-cull exact input is suppressed with its leaf reason", () => {
  for (const id of ["required-back", "required-front"]) {
    const result = evaluateFaceCullOracleCase(
      id,
      diagnostics(),
      diagnostics({
        aggregate: 1,
        exactPreparation: 1,
        uncertifiedFaceCull: 1,
      }),
      readback(faceCullOracleCases[0].expectedRgba),
    );
    assert.equal(result.pass, true);
    assert.equal(result.telemetryExact, true);
    assert.equal(result.routeExact, true);
    assert.equal(result.surfaceExact, true);
    assert.equal(result.renderPipelinesCreated, 0);
  }
});

test("optional face-cull exact input delegates to a visible native pipeline", () => {
  for (const id of ["optional-back", "optional-front"]) {
    const result = evaluateFaceCullOracleCase(
      id,
      diagnostics(),
      diagnostics({ renderPipelinesCreated: 1 }),
      readback(projectionNullOracleCase.expectedRgba),
    );
    assert.equal(result.pass, true);
    assert.equal(result.telemetryExact, true);
    assert.equal(result.routeExact, true);
    assert.equal(result.surfaceExact, true);
    assert.equal(result.renderPipelinesCreated, 1);
  }
});

test("face-cull evaluator rejects wrong telemetry, routes, and surfaces", () => {
  assert.equal(
    evaluateFaceCullOracleCase(
      "required-back",
      diagnostics(),
      diagnostics({
        aggregate: 1,
        exactPreparation: 1,
        uncertifiedFaceCull: 1,
        renderPipelinesCreated: 1,
      }),
      readback(faceCullOracleCases[0].expectedRgba),
    ).pass,
    false,
  );
  assert.equal(
    evaluateFaceCullOracleCase(
      "optional-back",
      diagnostics(),
      diagnostics({ renderPipelinesCreated: 1 }),
      readback(faceCullOracleCases[0].expectedRgba),
    ).pass,
    false,
  );
});
