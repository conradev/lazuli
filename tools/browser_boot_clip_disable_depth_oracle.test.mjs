#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIP_DISABLE_DEPTH_BLACK_RGBA_FNV1A64,
  CLIP_DISABLE_DEPTH_HASH_GENERATION,
  CLIP_DISABLE_DEPTH_MODES,
  CLIP_DISABLE_DEPTH_PROBE_RGBA_FNV1A64,
  buildClipDisableDepthOraclePacket,
  buildClipDisableDepthProbePacket,
  clipDisableDepthCases,
  clipDisableDepthExpectation,
  clipDisableDepthMask,
  clipDisableDepthProbeCases,
  clipDisableDepthProbeExpectation,
  evaluateClipDisableDepth,
  evaluateClipDisableDepthProbe,
} from "./browser_boot_clip_disable_depth_oracle.mjs";
import {
  RASTER_ALWAYS_UPDATE,
  RASTER_BLEND_ADDITIVE_ONE_ONE,
  RASTER_EQUAL_NO_UPDATE,
} from "./browser_boot_raster_center_oracle.mjs";
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
  pushTevDrawCalls = 0,
  submitGxFrameCalls = 0,
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
    pushTevDrawCalls,
    submitGxFrameCalls,
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
    ["crossing-near", "uniform-near", "uniform-far"],
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
  assert.deepEqual(
    clipDisableDepthCases[2].exactClipPositions.map(
      (position) => position[2],
    ),
    [0.5, 0.5, 0.5],
  );
});

test("mode bits model clip bypass after optional trivial rejection", () => {
  const crossingVisible = [];
  const uniformNearVisible = [];
  const uniformFarVisible = [];
  for (const mode of CLIP_DISABLE_DEPTH_MODES) {
    const crossing = clipDisableDepthExpectation(
      "crossing-near",
      mode,
    );
    const uniformNear = clipDisableDepthExpectation(
      "uniform-near",
      mode,
    );
    const uniformFar = clipDisableDepthExpectation(
      "uniform-far",
      mode,
    );
    if (crossing.visible) crossingVisible.push(mode);
    if (uniformNear.visible) uniformNearVisible.push(mode);
    if (uniformFar.visible) uniformFarVisible.push(mode);
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
      uniformNear.expectedExactRasterEmptyDraws,
      uniformNear.visible ? 0 : 1,
    );
    assert.equal(
      uniformFar.expectedExactRasterEmptyDraws,
      uniformFar.visible ? 0 : 1,
    );
  }
  assert.deepEqual(crossingVisible, [1, 3, 5, 7]);
  assert.deepEqual(uniformNearVisible, [3, 7]);
  assert.deepEqual(uniformFarVisible, [3, 7]);
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

test("packet fixtures isolate mode, depth vector, and additive sentinel", () => {
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
    assert.equal(view(packet).getUint32(0x14, true), 1);
    assert.equal(
      view(packet).getUint32(
        varyingRasterPacketLayout.drawOffset + 0x14,
        true,
      ),
      RASTER_BLEND_ADDITIVE_ONE_ONE,
    );
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
  const uniformFar = buildClipDisableDepthOraclePacket(
    "uniform-far",
    7,
    CLIP_DISABLE_DEPTH_HASH_GENERATION,
  );
  assert.deepEqual(
    exactPositions(uniformFar),
    clipDisableDepthCases[2].exactClipPositions,
  );
  assert.notDeepEqual(uniformFar, uniform);
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

test("depth-write probes seed, clamp, compare, and retain a control column", () => {
  assert.deepEqual(
    clipDisableDepthProbeCases.map((entry) => [
      entry.id,
      entry.mode,
      entry.clampDepth24,
      entry.exactClipPositions.map((position) => position[2]),
    ]),
    [
      ["crossing-near-depth-write", 1, 0, [-1.5, -1, -1]],
      [
        "crossing-far-depth-write",
        1,
        0x00ffffff,
        [0.5, 0, 0],
      ],
    ],
  );
  for (const entry of clipDisableDepthProbeCases) {
    const packet = buildClipDisableDepthProbePacket(
      entry.id,
      CLIP_DISABLE_DEPTH_HASH_GENERATION,
    );
    const data = view(packet);
    const draw = varyingRasterPacketLayout.drawOffset;
    const exactDraw = draw + varyingRasterPacketLayout.drawBytes;
    const probeDraw = exactDraw + varyingRasterPacketLayout.drawBytes;
    const exact = packet.length -
      varyingRasterPacketLayout.exactChunkBytes;
    assert.equal(data.getUint16(0x04, true), 6);
    assert.equal(data.getUint32(0x14, true), 3);
    assert.equal(data.getUint16(draw + 0x02, true), 0);
    assert.equal(
      data.getUint16(exactDraw + 0x02, true),
      varyingRasterPacketLayout.drawFlag,
    );
    assert.equal(data.getUint16(probeDraw + 0x02, true), 0);
    assert.equal(
      data.getUint32(draw + 0x10, true),
      RASTER_ALWAYS_UPDATE,
    );
    assert.equal(
      data.getUint32(exactDraw + 0x10, true),
      RASTER_ALWAYS_UPDATE,
    );
    assert.equal(
      data.getUint32(probeDraw + 0x10, true),
      RASTER_EQUAL_NO_UPDATE,
    );
    assert.equal(data.getUint32(exact + 0x14, true), entry.mode);
    assert.equal(
      data.getUint32(exact + 0x0c, true),
      ((342 + 2) << 12) | (342 + 3),
    );
    assert.deepEqual(
      Array.from(
        { length: varyingRasterPacketLayout.vertexCount },
        (_unused, vertex) =>
          Array.from(
            { length: 4 },
            (_component, component) =>
              data.getFloat32(
                exact + 0x30 +
                  (vertex * 4 + component) * 4,
                true,
              ),
          ),
      ),
      entry.exactClipPositions,
    );
  }
  assert.throws(
    () => buildClipDisableDepthProbePacket("missing", 1),
    /unknown clip-disable depth probe/,
  );
  assert.throws(
    () =>
      buildClipDisableDepthProbePacket(
        "crossing-near-depth-write",
        -1,
      ),
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
  for (const entry of clipDisableDepthProbeCases) {
    const probe = clipDisableDepthProbeExpectation(entry.id);
    assert.equal(clipDisableDepthMask(probe.expectedRgba), 0x7777);
    assert.equal(
      fnv1a64Hex(probe.expectedRgba),
      CLIP_DISABLE_DEPTH_PROBE_RGBA_FNV1A64,
    );
  }
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
        pushTevDrawCalls: mode,
        submitGxFrameCalls: mode,
      });
      const after = diagnostics({
        managedCoverageDraws:
          mode + expected.expectedManagedCoverage.draws,
        managedCoverageTriangles:
          mode + expected.expectedManagedCoverage.triangles,
        exactRasterEmptyDraws:
          mode + expected.expectedExactRasterEmptyDraws,
        pushTevDrawCalls: mode + 1,
        submitGxFrameCalls: mode + 1,
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
        pushTevDrawCalls: 1,
        submitGxFrameCalls: 1,
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
        pushTevDrawCalls: 1,
        submitGxFrameCalls: 1,
      }),
      { width: 4, height: 4, rgba: wrong },
    ).pass,
    false,
    "a pixel mismatch cannot pass",
  );
  assert.equal(
    evaluateClipDisableDepth(
      "crossing-near",
      1,
      before,
      diagnostics({
        managedCoverageDraws: 1,
        managedCoverageTriangles: 1,
        pushTevDrawCalls: 2,
        submitGxFrameCalls: 1,
      }),
      readback(expected),
    ).pass,
    false,
    "a duplicate transported draw cannot pass",
  );
});

test("depth-probe evaluator requires one managed clamp and three packet draws", () => {
  for (const entry of clipDisableDepthProbeCases) {
    const expected = clipDisableDepthProbeExpectation(entry.id);
    const result = evaluateClipDisableDepthProbe(
      entry.id,
      diagnostics(),
      diagnostics({
        managedCoverageDraws: 1,
        managedCoverageTriangles: 1,
        pushTevDrawCalls: 3,
        submitGxFrameCalls: 1,
      }),
      readback(expected),
    );
    assert.equal(result.pass, true, entry.id);
    assert.equal(result.actualMask, 0x7777);
    assert.equal(result.pushTevDrawCallsExact, true);
    assert.equal(result.submitGxFrameCallsExact, true);
  }
  const entry = clipDisableDepthProbeCases[1];
  const expected = clipDisableDepthProbeExpectation(entry.id);
  const falsePositive = Uint8Array.from(expected.expectedRgba);
  for (let row = 0; row < 4; row += 1) {
    falsePositive.set([0, 255, 0, 255], (row * 4 + 3) * 4);
  }
  assert.equal(
    evaluateClipDisableDepthProbe(
      entry.id,
      diagnostics(),
      diagnostics({
        managedCoverageDraws: 1,
        managedCoverageTriangles: 1,
        pushTevDrawCalls: 3,
        submitGxFrameCalls: 1,
      }),
      { width: 4, height: 4, rgba: falsePositive },
    ).pass,
    false,
    "an unseeded far-depth false positive cannot pass its control column",
  );
});
