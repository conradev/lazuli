#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIP_DISABLE_DEPTH_BLACK_RGBA_FNV1A64,
  CLIP_DISABLE_DEPTH_HASH_GENERATION,
  CLIP_DISABLE_DEPTH_MODES,
  buildClipDisableDepthOraclePacket,
  clipDisableDepthCases,
  clipDisableDepthExpectation,
  clipDisableDepthMask,
  evaluateClipDisableDepth,
} from "./browser_boot_clip_disable_depth_oracle.mjs";
import {
  fnv1a64Hex,
  varyingRasterOracleCases,
  varyingRasterPacketLayout,
} from "./browser_boot_varying_raster_oracle.mjs";

const visibleCase = varyingRasterOracleCases.find(
  (entry) => entry.id === "raster0",
);

function view(bytes) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
}

function exactPositions(packet) {
  const data = view(packet);
  return Array.from(
    { length: varyingRasterPacketLayout.vertexCount },
    (_unused, vertex) =>
      Array.from(
        { length: 4 },
        (_component, component) =>
          data.getFloat32(
            varyingRasterPacketLayout.exactChunkOffset +
              0x30 +
              (vertex * 4 + component) * 4,
            true,
          ),
      ),
  );
}

function diagnostics({
  rejected = 0,
  exactPreparation = 0,
  unsupportedClipDisable7 = 0,
  managedCoverageDraws = 0,
  managedCoverageTriangles = 0,
  exactRasterEmptyDraws = 0,
} = {}) {
  return {
    exactRequiredRejectedDraws: rejected,
    exactRequiredRejectionReasons: {
      exactPreparation,
    },
    exactRequiredPreparationRejectionReasons: {
      unsupportedClipDisable7,
    },
    managedCoverageDraws,
    managedCoverageTriangles,
    exactRasterEmptyDraws,
  };
}

function readback(expected) {
  return {
    width: 4,
    height: 4,
    rgba: Uint8Array.from(expected.expectedRgba),
  };
}

test("depth vectors pin the hardware-tested positive-W cases", () => {
  assert.deepEqual(CLIP_DISABLE_DEPTH_MODES, [
    0, 1, 2, 3, 4, 5, 6, 7,
  ]);
  assert.deepEqual(
    clipDisableDepthCases.map((entry) => entry.id),
    ["crossing-near", "uniform-near"],
  );
  for (const entry of clipDisableDepthCases) {
    assert.ok(
      entry.exactClipPositions
        .flat()
        .every(Number.isFinite),
    );
    assert.ok(
      entry.exactClipPositions.every(
        (position) => position[3] > 0,
      ),
    );
    assert.ok(
      entry.exactClipPositions.every(
        (position) =>
          position[0] >= -position[3] &&
          position[0] <= position[3] &&
          position[1] >= -position[3] &&
          position[1] <= position[3],
      ),
      "the depth vector must not depend on unresolved X/Y guardband behavior",
    );
  }
  assert.deepEqual(
    clipDisableDepthCases[0].exactClipPositions.map(
      (position) => position[2],
    ),
    [-1.5, -1, -1],
  );
  assert.deepEqual(
    clipDisableDepthCases[1].exactClipPositions.map(
      (position) => position[2],
    ),
    [-1.5, -1.5, -1.5],
  );
});

test("mode bits model clip bypass after optional trivial rejection", () => {
  const crossingVisible = [];
  const uniformVisible = [];
  for (const mode of CLIP_DISABLE_DEPTH_MODES) {
    const crossing = clipDisableDepthExpectation(
      "crossing-near",
      mode,
    );
    const uniform = clipDisableDepthExpectation(
      "uniform-near",
      mode,
    );
    if (crossing.visible) crossingVisible.push(mode);
    if (uniform.visible) uniformVisible.push(mode);
    assert.equal(
      crossing.clippingDetectionDisabled,
      (mode & 1) !== 0,
    );
    assert.equal(
      crossing.trivialRejectionDisabled,
      (mode & 2) !== 0,
    );
    assert.equal(
      crossing.cpolyClippingAccelerationDisabled,
      (mode & 4) !== 0,
    );
    assert.equal(
      crossing.expectedManagedCoverage.triangles,
      crossing.visible ? 1 : 0,
    );
    assert.equal(
      uniform.expectedExactRasterEmptyDraws,
      uniform.visible ? 0 : 1,
    );
  }
  assert.deepEqual(crossingVisible, [1, 3, 5, 7]);
  assert.deepEqual(uniformVisible, [3, 7]);
  for (const [caseId, mode] of [
    ["missing", 0],
    ["crossing-near", -1],
    ["uniform-near", 8],
  ]) {
    assert.throws(
      () => clipDisableDepthExpectation(caseId, mode),
      /unknown clip-disable depth case|mode must be an integer/,
    );
  }
});

test("packet fixtures isolate the raw mode and near-depth vectors", () => {
  const exact = varyingRasterPacketLayout.exactChunkOffset;
  const crossingPackets = CLIP_DISABLE_DEPTH_MODES.map((mode) =>
    buildClipDisableDepthOraclePacket(
      "crossing-near",
      mode,
      CLIP_DISABLE_DEPTH_HASH_GENERATION,
    )
  );
  for (const [mode, packet] of crossingPackets.entries()) {
    assert.equal(packet.length, varyingRasterPacketLayout.packetBytes);
    assert.equal(view(packet).getUint16(0x04, true), 6);
    assert.equal(
      view(packet).getUint32(exact + 0x14, true),
      mode,
    );
    assert.deepEqual(
      exactPositions(packet),
      clipDisableDepthCases[0].exactClipPositions,
    );
    const restored = packet.slice();
    view(restored).setUint32(exact + 0x14, 0, true);
    assert.deepEqual(restored, crossingPackets[0]);
  }
  const uniform = buildClipDisableDepthOraclePacket(
    "uniform-near",
    7,
    CLIP_DISABLE_DEPTH_HASH_GENERATION,
  );
  assert.deepEqual(
    exactPositions(uniform),
    clipDisableDepthCases[1].exactClipPositions,
  );
  assert.notDeepEqual(uniform, crossingPackets[7]);
  assert.deepEqual(
    buildClipDisableDepthOraclePacket(
      "crossing-near",
      1,
      CLIP_DISABLE_DEPTH_HASH_GENERATION,
    ),
    buildClipDisableDepthOraclePacket(
      "crossing-near",
      1,
      CLIP_DISABLE_DEPTH_HASH_GENERATION,
    ),
  );
  assert.throws(
    () => buildClipDisableDepthOraclePacket("crossing-near", 0, -1),
    /generation must be a non-negative safe integer/,
  );
});

test("visible and empty 4x4 contracts have exact masks and hashes", () => {
  const visible = clipDisableDepthExpectation(
    "crossing-near",
    1,
  );
  const empty = clipDisableDepthExpectation(
    "crossing-near",
    0,
  );
  assert.equal(visibleCase.expectedRgba.length, 64);
  assert.equal(clipDisableDepthMask(visible.expectedRgba), 0xffff);
  assert.equal(clipDisableDepthMask(empty.expectedRgba), 0);
  assert.equal(
    fnv1a64Hex(visible.expectedRgba),
    visibleCase.expectedRgbaFnv1a64,
  );
  assert.equal(
    fnv1a64Hex(empty.expectedRgba),
    CLIP_DISABLE_DEPTH_BLACK_RGBA_FNV1A64,
  );
  assert.throws(
    () => clipDisableDepthMask(new Uint8Array(4)),
    /one 4x4 RGBA surface/,
  );
});

test("evaluator requires pixels, managed routing, empty proof, and zero rejection", () => {
  for (const caseId of clipDisableDepthCases.map(
    (entry) => entry.id,
  )) {
    for (const mode of CLIP_DISABLE_DEPTH_MODES) {
      const expected = clipDisableDepthExpectation(caseId, mode);
      const before = diagnostics({
        managedCoverageDraws: mode,
        managedCoverageTriangles: mode,
        exactRasterEmptyDraws: mode,
      });
      const after = diagnostics({
        managedCoverageDraws:
          mode + expected.expectedManagedCoverage.draws,
        managedCoverageTriangles:
          mode + expected.expectedManagedCoverage.triangles,
        exactRasterEmptyDraws:
          mode + expected.expectedExactRasterEmptyDraws,
      });
      const result = evaluateClipDisableDepth(
        caseId,
        mode,
        before,
        after,
        readback(expected),
      );
      assert.equal(result.pass, true, `${caseId} mode ${mode}`);
      assert.equal(result.visible, expected.visible);
      assert.equal(result.telemetryZero, true);
      assert.equal(result.managedCoverageExact, true);
      assert.equal(result.exactRasterEmptyExact, true);
      assert.equal(result.maskExact, true);
      assert.equal(result.hashExact, true);
    }
  }

  const expected = clipDisableDepthExpectation("crossing-near", 1);
  const before = diagnostics();
  assert.equal(
    evaluateClipDisableDepth(
      "crossing-near",
      1,
      before,
      diagnostics({ managedCoverageDraws: 1 }),
      readback(expected),
    ).pass,
    false,
    "a native or partial managed route cannot pass",
  );
  assert.equal(
    evaluateClipDisableDepth(
      "crossing-near",
      1,
      before,
      diagnostics({
        rejected: 1,
        exactPreparation: 1,
        managedCoverageDraws: 1,
        managedCoverageTriangles: 1,
      }),
      readback(expected),
    ).pass,
    false,
    "suppression telemetry cannot pass",
  );
  const wrong = Uint8Array.from(expected.expectedRgba);
  wrong[0] ^= 1;
  assert.equal(
    evaluateClipDisableDepth(
      "crossing-near",
      1,
      before,
      diagnostics({
        managedCoverageDraws: 1,
        managedCoverageTriangles: 1,
      }),
      { width: 4, height: 4, rgba: wrong },
    ).pass,
    false,
    "a pixel mismatch cannot pass",
  );
});
