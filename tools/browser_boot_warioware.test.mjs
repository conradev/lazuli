#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../crates/ppcwasmjit/examples/browser_boot.rs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${name}`);
}

function makeContext(identifier = "GZWE01") {
  const memory = new ArrayBuffer(0x1800000);
  const view = new DataView(memory);
  const context = {
    Number,
    boot: { identifier, discId: 0, version: 0 },
    controllerAppliedSequence: 0,
    serialLastActiveHostPublication: null,
    wariowareLastActiveGameplayInput: null,
    wariowareNextMicrogameOverride: {
      requested: false,
      eligible: false,
      applied: false,
      cycle: null,
      pc: null,
      original: null,
      forced: null,
      player: null,
      caller: null,
      lr: null,
      selectorCycle: null,
      selectorPc: null,
      selectorLr: null,
    },
    view,
    ramPointer(address, length) {
      const physical = address & 0x1fffffff;
      return physical <= memory.byteLength - length ? physical : null;
    },
    inspectSuperMonkeyBallGameState() {
      return identifier === "GMBE8P" ? { game: "smb" } : null;
    },
    inspectLuigisMansionGameState() {
      return null;
    },
    inspectWindWakerGameState() {
      return identifier === "GZLE01" ? { game: "wind" } : null;
    },
    inspectMeleeGameState() {
      return null;
    },
  };
  vm.createContext(context);
  vm.runInContext([
    "guestU32",
    "guestU16",
    "guestS32",
    "hex32",
    "snapshotWarioWareNextMicrogameOverride",
    "inspectWarioWareGameState",
    "sampleWarioWareGameplayInput",
    "inspectGuestGameState",
  ].map(extractFunction).join("\n\n"), context, {
    filename: "browser_boot.warioware.js",
  });
  return context;
}

const wariowareNextMicrogameSetterPc = 0x80046050;
const wariowareNextMicrogameActivationPc = 0x80046174;
const wariowareNextMicrogameActivationCallers = [
  {
    lr: 0x8106c584,
    objectLoad: 0x80770000,
    ownerLoad: 0x80970000,
  },
  {
    lr: 0x81076564,
    objectLoad: 0x807c0000,
    ownerLoad: 0x809c0000,
  },
];
const wariowareFilteredNextMicrogameSelectorPc = 0x80046c44;
const wariowareNextMicrogameSelectorPc = 0x80046d20;
const wariowareNextMicrogameSetterSignature = [
  0x9421ffe0,
  0x7c0802a6,
  0x2c04270f,
  0x90010024,
  0x93e1001c,
  0x93c10018,
];
const wariowareNextMicrogameActivationSignature = [
  0x9421ffe0,
  0x7c0802a6,
  0x90010024,
  0x93e1001c,
  0x7c7f1b78,
  0x2c1f270f,
];
const wariowareNextMicrogameSelectorSignature = [
  0x9421fff0,
  0x7c0802a6,
  0x3c608027,
  0x90010014,
  0x8403861c,
  0x2c000000,
];
const wariowareFilteredNextMicrogameSelectorSignature = [
  0x9421fff0,
  0x7c0802a6,
  0x3c808027,
  0x90010014,
  0x38000000,
  0x93e1000c,
];
const wariowareSelectorPaths = {
  unfiltered: {
    selectorPc: wariowareNextMicrogameSelectorPc,
    selectorLr: 0x8101d75c,
    setterLr: 0x8101d76c,
  },
  filteredDirect: {
    selectorPc: wariowareFilteredNextMicrogameSelectorPc,
    selectorLr: 0x8101d6d0,
    setterLr: 0x8101d6e0,
  },
  filteredBridged: {
    selectorPc: wariowareFilteredNextMicrogameSelectorPc,
    selectorLr: 0x8101d750,
    setterLr: 0x8101d76c,
  },
};
const relativeBranch = (from, to, link = true) =>
  (0x48000000 | Number(link) | ((to - from) & 0x03fffffc)) >>> 0;
function installWarioWareActivationCaller(
  instructions,
  activationLr,
  objectLoad,
  ownerLoad,
) {
  for (const [address, word] of [
    [activationLr - 0x1c, 0x38000000],
    [activationLr - 0x18, 0x480002c4],
    [activationLr - 0x0c, objectLoad],
    [activationLr - 0x08, 0x80630050],
    [
      activationLr - 0x04,
      relativeBranch(
        activationLr - 0x04,
        wariowareNextMicrogameActivationPc,
      ),
    ],
    [activationLr, ownerLoad],
    [activationLr + 0x04, 0x9064004c],
    [activationLr + 0x08, ownerLoad],
    [activationLr + 0x0c, 0x8004004c],
    [activationLr + 0x10, 0x28000000],
    [activationLr + 0x14, 0x4182ffe0],
  ]) {
    instructions.set(address, word);
  }
}
const overrideFunctionNames = [
  "exactWarioWareRevisionZero",
  "createWarioWareNextMicrogameOverride",
  "warioWareNextMicrogameOverridePending",
  "warioWareNextMicrogameOverrideRegionSafe",
  "warioWareNextMicrogameSetterSignatureMatches",
  "warioWareNextMicrogameActivationSignatureMatches",
  "warioWareNextMicrogameSelectorSignatureMatches",
  "isUint32",
  "relativeBranchTarget",
  "observeWarioWareNextMicrogameSelection",
  "warioWareNextMicrogameCallerMatches",
  "warioWareNextMicrogameActivationCallerMatches",
  "applyWarioWareNextMicrogameOverride",
  "snapshotWarioWareNextMicrogameOverride",
  "hex32",
];

function overrideContext(boot = {
  identifier: "GZWE01",
  discId: 0,
  version: 0,
}, pathName = "unfiltered") {
  const path = wariowareSelectorPaths[pathName];
  assert.notEqual(path, undefined, `unknown WarioWare selector path ${pathName}`);
  const registers = new Uint32Array(32);
  const instructions = new Map(
    [
      ...wariowareNextMicrogameSetterSignature.map((word, index) => [
        wariowareNextMicrogameSetterPc + index * 4,
        word,
      ]),
      ...wariowareNextMicrogameActivationSignature.map((word, index) => [
        wariowareNextMicrogameActivationPc + index * 4,
        word,
      ]),
      ...wariowareNextMicrogameSelectorSignature.map((word, index) => [
        wariowareNextMicrogameSelectorPc + index * 4,
        word,
      ]),
      ...wariowareFilteredNextMicrogameSelectorSignature.map((word, index) => [
        wariowareFilteredNextMicrogameSelectorPc + index * 4,
        word,
      ]),
    ],
  );
  const { selectorPc, selectorLr, setterLr } = path;
  instructions.set(selectorLr - 4, relativeBranch(
    selectorLr - 4,
    selectorPc,
  ));
  instructions.set(selectorLr, 0x907b278c);
  if (pathName === "unfiltered") {
    instructions.set(selectorLr + 4, 0x809b278c);
    instructions.set(selectorLr + 8, 0x38600000);
  } else if (pathName === "filteredDirect") {
    instructions.set(selectorLr - 8, 0x38602000);
    instructions.set(selectorLr + 4, 0x38600000);
    instructions.set(selectorLr + 8, 0x809b278c);
  } else {
    instructions.set(selectorLr - 8, 0x38602000);
    instructions.set(
      selectorLr + 4,
      relativeBranch(selectorLr + 4, selectorLr + 0x10, false),
    );
    instructions.set(selectorLr + 0x10, 0x809b278c);
    instructions.set(selectorLr + 0x14, 0x38600000);
  }
  instructions.set(setterLr - 4, relativeBranch(
    setterLr - 4,
    wariowareNextMicrogameSetterPc,
  ));
  for (
    const { lr: activationLr, objectLoad, ownerLoad }
    of wariowareNextMicrogameActivationCallers
  ) {
    installWarioWareActivationCaller(
      instructions,
      activationLr,
      objectLoad,
      ownerLoad,
    );
  }
  const context = {
    Map,
    Number,
    URLSearchParams,
    boot,
    cycles: 123_456,
    linkRegister: selectorLr,
    registers,
    instructions,
    wariowareNextMicrogameQueryName: "wariowareNextMicrogame",
    wariowareNextMicrogameQueryValue: "0x63",
    wariowareNextMicrogameSetterPc,
    wariowareNextMicrogameActivationPc,
    wariowareNextMicrogameActivationCallers,
    wariowareFilteredNextMicrogameSelectorPc,
    wariowareNextMicrogameSelectorPc,
    wariowareRepellionMicrogameId: 0x63,
    wariowareMaximumRetailMicrogameId: 0x117,
    wariowareNextMicrogameSetterSignature,
    wariowareNextMicrogameActivationSignature,
    wariowareFilteredNextMicrogameSelectorSignature,
    wariowareNextMicrogameSelectorSignature,
    readGpr(index) {
      return registers[index];
    },
    writeGpr(index, value) {
      registers[index] = value >>> 0;
    },
    readLr() {
      return context.linkRegister;
    },
    probeInstructionWord(address) {
      return instructions.get(address) ?? null;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    overrideFunctionNames.map(extractFunction).join("\n\n"),
    context,
    { filename: "browser_boot.warioware-override.js" },
  );
  context.selectorLr = selectorLr;
  context.selectorPc = selectorPc;
  context.setterLr = setterLr;
  context.pathName = pathName;
  return context;
}

test("WarioWare next-microgame request accepts only the exact debug opt-in", () => {
  const context = overrideContext();
  const selected = JSON.parse(JSON.stringify(
    context.createWarioWareNextMicrogameOverride(
      new URLSearchParams("?wariowareNextMicrogame=0x63&cycles=10"),
    ),
  ));
  assert.deepEqual(selected, {
    requested: true,
    eligible: true,
    applied: false,
    cycle: null,
    pc: null,
    original: null,
    forced: 0x63,
    player: null,
    caller: null,
    lr: null,
    selectorCycle: null,
    selectorPc: null,
    selectorLr: null,
  });

  for (const query of [
    "",
    "?wariowareNextMicrogame=99",
    "?wariowareNextMicrogame=0X63",
    "?wariowareNextMicrogame=0x63&wariowareNextMicrogame=0x63",
  ]) {
    const rejected = context.createWarioWareNextMicrogameOverride(
      new URLSearchParams(query),
    );
    assert.equal(rejected.requested, false, query);
    assert.equal(rejected.eligible, false, query);
    assert.equal(rejected.forced, null, query);
  }
});

test("WarioWare next-microgame override is exact-disc, exact-revision, and one-shot", () => {
  const context = overrideContext();
  const request = () => context.createWarioWareNextMicrogameOverride(
    new URLSearchParams("?wariowareNextMicrogame=0x63"),
  );
  const override = request();
  context.registers[3] = 0;
  context.registers[4] = 0x4b;

  context.linkRegister = context.setterLr;
  assert.equal(
    context.applyWarioWareNextMicrogameOverride(
      wariowareNextMicrogameSetterPc,
      override,
    ),
    false,
    "a setter call without the preceding selector observation must be untouched",
  );
  assert.equal(context.registers[4], 0x4b);

  context.linkRegister = context.selectorLr;
  assert.equal(
    context.observeWarioWareNextMicrogameSelection(
      wariowareNextMicrogameSelectorPc,
      override,
    ),
    true,
  );
  assert.equal(
    context.applyWarioWareNextMicrogameOverride(
      wariowareNextMicrogameSetterPc - 4,
      override,
    ),
    false,
  );
  assert.equal(context.registers[4], 0x4b);
  context.linkRegister = context.setterLr;
  assert.equal(
    context.applyWarioWareNextMicrogameOverride(
      wariowareNextMicrogameSetterPc,
      override,
    ),
    true,
  );
  assert.equal(context.registers[3], 0, "the player register must be preserved");
  assert.equal(context.registers[4], 0x63);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.snapshotWarioWareNextMicrogameOverride(override),
    )),
    {
      requested: true,
      eligible: true,
      applied: true,
      cycle: 123_456,
      pc: "0x80046050",
      original: 0x4b,
      forced: 0x63,
      player: 0,
      caller: "0x8101d768",
      lr: "0x8101d76c",
      selectorCycle: 123_456,
      selectorPc: "0x80046d20",
      selectorLr: "0x8101d75c",
    },
  );

  context.registers[4] = 0x52;
  assert.equal(
    context.applyWarioWareNextMicrogameOverride(
      wariowareNextMicrogameSetterPc,
      override,
    ),
    false,
  );
  assert.equal(context.registers[4], 0x52, "a later selector call must be untouched");
});

test("WarioWare next-microgame override authenticates every retail selector path", () => {
  for (const pathName of Object.keys(wariowareSelectorPaths)) {
    const context = overrideContext(undefined, pathName);
    const override = context.createWarioWareNextMicrogameOverride(
      new URLSearchParams("?wariowareNextMicrogame=0x63"),
    );
    context.registers[3] = 0;
    context.registers[4] = 0x4b;
    context.linkRegister = context.selectorLr;
    assert.equal(
      context.observeWarioWareNextMicrogameSelection(
        context.selectorPc,
        override,
      ),
      true,
      pathName,
    );
    context.linkRegister = context.setterLr;
    assert.equal(
      context.applyWarioWareNextMicrogameOverride(
        wariowareNextMicrogameSetterPc,
        override,
      ),
      true,
      pathName,
    );
    assert.equal(context.registers[4], 0x63, pathName);
    assert.equal(override.selectorPc, context.selectorPc, pathName);
    assert.equal(override.selectorLr, context.selectorLr, pathName);
    assert.equal(override.lr, context.setterLr, pathName);
    assert.equal(override.caller, context.setterLr - 4, pathName);
  }
});

test("WarioWare next-microgame override authenticates both delayed Wario activation loops", () => {
  for (
    const { lr: activationLr }
    of wariowareNextMicrogameActivationCallers
  ) {
    const context = overrideContext();
    const override = context.createWarioWareNextMicrogameOverride(
      new URLSearchParams("?wariowareNextMicrogame=0x63"),
    );
    context.registers[3] = 0x21;
    context.registers[4] = 0xfeed;
    context.linkRegister = activationLr;

    assert.equal(
      context.applyWarioWareNextMicrogameOverride(
        wariowareNextMicrogameActivationPc,
        override,
      ),
      true,
    );
    assert.equal(context.registers[3], 0x63);
    assert.equal(context.registers[4], 0xfeed);
    assert.deepEqual(
      JSON.parse(JSON.stringify(
        context.snapshotWarioWareNextMicrogameOverride(override),
      )),
      {
        requested: true,
        eligible: true,
        applied: true,
        cycle: 123_456,
        pc: "0x80046174",
        original: 0x21,
        forced: 0x63,
        player: 0,
        caller: `0x${(activationLr - 4).toString(16)}`,
        lr: `0x${activationLr.toString(16)}`,
        selectorCycle: null,
        selectorPc: null,
        selectorLr: null,
      },
    );

    context.registers[3] = 0x2a;
    assert.equal(
      context.applyWarioWareNextMicrogameOverride(
        wariowareNextMicrogameActivationPc,
        override,
      ),
      false,
    );
    assert.equal(context.registers[3], 0x2a);
  }

  const context = overrideContext();
  const override = context.createWarioWareNextMicrogameOverride(
    new URLSearchParams("?wariowareNextMicrogame=0x63"),
  );
  context.registers[3] = 0x21;
  context.linkRegister = wariowareNextMicrogameActivationCallers[0].lr;
  assert.equal(
    context.applyWarioWareNextMicrogameOverride(
      wariowareNextMicrogameActivationPc,
      override,
    ),
    true,
  );
  context.registers[3] = 0x2a;
  context.linkRegister = wariowareNextMicrogameActivationCallers[1].lr;
  assert.equal(
    context.applyWarioWareNextMicrogameOverride(
      wariowareNextMicrogameActivationPc,
      override,
    ),
    false,
  );
  assert.equal(context.registers[3], 0x2a);
});

test("WarioWare delayed activation authentication follows the relocated REL caller", () => {
  const context = overrideContext();
  const override = context.createWarioWareNextMicrogameOverride(
    new URLSearchParams("?wariowareNextMicrogame=0x63"),
  );
  const relocatedLr = 0x806fc584;
  const caller = wariowareNextMicrogameActivationCallers[0];
  installWarioWareActivationCaller(
    context.instructions,
    relocatedLr,
    caller.objectLoad,
    caller.ownerLoad,
  );
  context.registers[3] = 0x21;
  context.linkRegister = relocatedLr;

  assert.equal(
    context.applyWarioWareNextMicrogameOverride(
      wariowareNextMicrogameActivationPc,
      override,
    ),
    true,
  );
  assert.equal(context.registers[3], 0x63);
  assert.equal(override.lr, relocatedLr);
  assert.equal(override.caller, relocatedLr - 4);
});

test("WarioWare delayed activation override rejects every caller or binary drift", () => {
  const callerOffsets = [
    -0x1c,
    -0x18,
    -0x0c,
    -0x08,
    -0x04,
    0,
    0x04,
    0x08,
    0x0c,
    0x10,
    0x14,
  ];
  for (
    const { lr: activationLr }
    of wariowareNextMicrogameActivationCallers
  ) {
    for (const offset of callerOffsets) {
      const context = overrideContext();
      const override = context.createWarioWareNextMicrogameOverride(
        new URLSearchParams("?wariowareNextMicrogame=0x63"),
      );
      context.registers[3] = 0x21;
      context.linkRegister = activationLr;
      context.instructions.set(
        activationLr + offset,
        0x60000000,
      );
      assert.equal(
        context.applyWarioWareNextMicrogameOverride(
          wariowareNextMicrogameActivationPc,
          override,
        ),
        false,
        `caller 0x${activationLr.toString(16)} drift at ${offset}`,
      );
      assert.equal(context.registers[3], 0x21);
      assert.equal(override.applied, false);
    }
  }

  {
    const context = overrideContext();
    const override = context.createWarioWareNextMicrogameOverride(
      new URLSearchParams("?wariowareNextMicrogame=0x63"),
    );
    context.registers[3] = 0x21;
    context.linkRegister = wariowareNextMicrogameActivationCallers[0].lr + 4;
    assert.equal(
      context.applyWarioWareNextMicrogameOverride(
        wariowareNextMicrogameActivationPc,
        override,
      ),
      false,
    );
    assert.equal(context.registers[3], 0x21);
  }

  {
    const context = overrideContext();
    const override = context.createWarioWareNextMicrogameOverride(
      new URLSearchParams("?wariowareNextMicrogame=0x63"),
    );
    const unrelatedActivationLr = 0x8106bfb4;
    for (const [address, word] of [
      [unrelatedActivationLr - 0x1c, 0x38a00000],
      [unrelatedActivationLr - 0x18, 0x480002d4],
      [unrelatedActivationLr - 0x0c, 0x807c0000],
      [unrelatedActivationLr - 0x08, 0x80630050],
      [unrelatedActivationLr - 0x04, 0x4afda1c5],
      [unrelatedActivationLr, 0x809c0000],
      [unrelatedActivationLr + 0x04, 0x9064004c],
      [unrelatedActivationLr + 0x08, 0x809c0000],
      [unrelatedActivationLr + 0x0c, 0x8004004c],
      [unrelatedActivationLr + 0x10, 0x28000000],
      [unrelatedActivationLr + 0x14, 0x4182ffe0],
    ]) {
      context.instructions.set(address, word);
    }
    context.registers[3] = 0x21;
    context.linkRegister = unrelatedActivationLr;
    assert.equal(
      context.applyWarioWareNextMicrogameOverride(
        wariowareNextMicrogameActivationPc,
        override,
      ),
      false,
    );
    assert.equal(context.registers[3], 0x21);
    assert.equal(override.applied, false);
  }

  {
    const context = overrideContext();
    const override = context.createWarioWareNextMicrogameOverride(
      new URLSearchParams("?wariowareNextMicrogame=0x63"),
    );
    context.registers[3] = 0x21;
    context.linkRegister = wariowareNextMicrogameActivationCallers[0].lr;
    context.instructions.set(
      wariowareNextMicrogameActivationPc + 8,
      0x60000000,
    );
    assert.equal(
      context.applyWarioWareNextMicrogameOverride(
        wariowareNextMicrogameActivationPc,
        override,
      ),
      false,
    );
    assert.equal(context.registers[3], 0x21);
  }

  for (const boot of [
    { identifier: "GZWE01", discId: 0, version: 1 },
    { identifier: "GZWE01", discId: 1, version: 0 },
    { identifier: "GMBE8P", discId: 0, version: 0 },
  ]) {
    const context = overrideContext(boot);
    const override = context.createWarioWareNextMicrogameOverride(
      new URLSearchParams("?wariowareNextMicrogame=0x63"),
    );
    context.registers[3] = 0x21;
    context.linkRegister = wariowareNextMicrogameActivationCallers[0].lr;
    assert.equal(
      context.applyWarioWareNextMicrogameOverride(
        wariowareNextMicrogameActivationPc,
        override,
      ),
      false,
    );
    assert.equal(context.registers[3], 0x21);
  }

  for (const invalidId of [0x118, 0x2706, 0x270f]) {
    const context = overrideContext();
    const override = context.createWarioWareNextMicrogameOverride(
      new URLSearchParams("?wariowareNextMicrogame=0x63"),
    );
    context.registers[3] = invalidId;
    context.linkRegister = wariowareNextMicrogameActivationCallers[0].lr;
    assert.equal(
      context.applyWarioWareNextMicrogameOverride(
        wariowareNextMicrogameActivationPc,
        override,
      ),
      false,
    );
    assert.equal(context.registers[3], invalidId);
  }
});

test("WarioWare next-microgame override rejects drift in every retail caller shape", () => {
  const driftOffsets = {
    unfiltered: 4,
    filteredDirect: -8,
    filteredBridged: 4,
  };
  for (const pathName of Object.keys(wariowareSelectorPaths)) {
    const context = overrideContext(undefined, pathName);
    const override = context.createWarioWareNextMicrogameOverride(
      new URLSearchParams("?wariowareNextMicrogame=0x63"),
    );
    const driftAddress = context.selectorLr + driftOffsets[pathName];
    context.instructions.set(driftAddress, 0x60000000);
    context.linkRegister = context.selectorLr;
    assert.equal(
      context.observeWarioWareNextMicrogameSelection(
        context.selectorPc,
        override,
      ),
      false,
      pathName,
    );
    assert.equal(override.selectorPc, null, pathName);
    assert.equal(override.selectorLr, null, pathName);
  }
});

test("WarioWare next-microgame override fails closed on variants and signature drift", () => {
  {
    const context = overrideContext();
    const override = context.createWarioWareNextMicrogameOverride(
      new URLSearchParams(""),
    );
    context.registers[3] = 0;
    context.registers[4] = 0x4b;
    context.linkRegister = context.selectorLr;
    assert.equal(
      context.observeWarioWareNextMicrogameSelection(
        wariowareNextMicrogameSelectorPc,
        override,
      ),
      false,
    );
    context.linkRegister = context.setterLr;
    assert.equal(
      context.applyWarioWareNextMicrogameOverride(
        wariowareNextMicrogameSetterPc,
        override,
      ),
      false,
    );
    assert.equal(context.registers[4], 0x4b);
  }

  for (const boot of [
    { identifier: "GZWE01", discId: 0, version: 1 },
    { identifier: "GZWE01", discId: 1, version: 0 },
    { identifier: "GMBE8P", discId: 0, version: 0 },
  ]) {
    const context = overrideContext(boot);
    const override = context.createWarioWareNextMicrogameOverride(
      new URLSearchParams("?wariowareNextMicrogame=0x63"),
    );
    context.registers[3] = 0;
    context.registers[4] = 0x4b;
    assert.equal(override.requested, true);
    assert.equal(override.eligible, false);
    assert.equal(
      context.applyWarioWareNextMicrogameOverride(
        wariowareNextMicrogameSetterPc,
        override,
      ),
      false,
    );
    assert.equal(context.registers[4], 0x4b);
  }

  const drifted = overrideContext();
  const override = drifted.createWarioWareNextMicrogameOverride(
    new URLSearchParams("?wariowareNextMicrogame=0x63"),
  );
  drifted.registers[3] = 0;
  drifted.registers[4] = 0x4b;
  drifted.linkRegister = drifted.selectorLr;
  assert.equal(
    drifted.observeWarioWareNextMicrogameSelection(
      wariowareNextMicrogameSelectorPc,
      override,
    ),
    true,
  );
  drifted.linkRegister = drifted.setterLr;
  drifted.instructions.set(wariowareNextMicrogameSetterPc + 8, 0x60000000);
  assert.equal(
    drifted.applyWarioWareNextMicrogameOverride(
      wariowareNextMicrogameSetterPc,
      override,
    ),
    false,
  );
  assert.equal(drifted.registers[4], 0x4b);
  assert.equal(override.applied, false);

  drifted.instructions.set(
    wariowareNextMicrogameSetterPc + 8,
    wariowareNextMicrogameSetterSignature[2],
  );
  drifted.registers[3] = 1;
  assert.equal(
    drifted.applyWarioWareNextMicrogameOverride(
      wariowareNextMicrogameSetterPc,
      override,
    ),
    false,
  );
  assert.equal(override.applied, false);

  drifted.registers[3] = 0;
  for (const invalidId of [0x118, 0x2706, 0x270f]) {
    drifted.registers[4] = invalidId;
    assert.equal(
      drifted.applyWarioWareNextMicrogameOverride(
        wariowareNextMicrogameSetterPc,
        override,
      ),
      false,
      `non-retail or sentinel ID ${invalidId.toString(16)} must be untouched`,
    );
    assert.equal(drifted.registers[4], invalidId);
    assert.equal(override.applied, false);
  }

  drifted.registers[4] = 0x4b;
  drifted.linkRegister += 4;
  assert.equal(
    drifted.applyWarioWareNextMicrogameOverride(
      wariowareNextMicrogameSetterPc,
      override,
    ),
    false,
    "the selector and setter LRs must form the exact relocated caller chain",
  );
  assert.equal(drifted.registers[4], 0x4b);
});

test("WarioWare next-microgame override rejects malformed runtime observations", () => {
  const context = overrideContext();
  const override = context.createWarioWareNextMicrogameOverride(
    new URLSearchParams("?wariowareNextMicrogame=0x63"),
  );
  context.linkRegister = null;
  assert.equal(
    context.observeWarioWareNextMicrogameSelection(
      wariowareNextMicrogameSelectorPc,
      override,
    ),
    false,
  );
  assert.equal(override.selectorLr, null);

  context.linkRegister = context.selectorLr;
  const callerStore = context.instructions.get(context.selectorLr);
  context.instructions.set(context.selectorLr, 0x60000000);
  assert.equal(
    context.observeWarioWareNextMicrogameSelection(
      wariowareNextMicrogameSelectorPc,
      override,
    ),
    false,
    "an unrelated selector caller must not arm region suppression",
  );
  assert.equal(override.selectorLr, null);
  context.instructions.set(context.selectorLr, callerStore);
  assert.equal(
    context.observeWarioWareNextMicrogameSelection(
      wariowareNextMicrogameSelectorPc,
      override,
    ),
    true,
  );
  context.linkRegister = context.setterLr;
  assert.equal(
    context.applyWarioWareNextMicrogameOverride(
      wariowareNextMicrogameSetterPc,
      override,
      () => null,
    ),
    false,
  );
  assert.equal(override.applied, false);
});

test("WarioWare next-microgame override fences regions for its entire pending window", () => {
  const context = overrideContext();
  const override = context.createWarioWareNextMicrogameOverride(
    new URLSearchParams("?wariowareNextMicrogame=0x63"),
  );

  assert.equal(context.warioWareNextMicrogameOverridePending(override), true);
  context.linkRegister = context.selectorLr;
  assert.equal(
    context.observeWarioWareNextMicrogameSelection(
      wariowareNextMicrogameSelectorPc,
      override,
    ),
    true,
  );
  assert.equal(context.warioWareNextMicrogameOverridePending(override), true);

  context.registers[3] = 0;
  context.registers[4] = 0x4b;
  context.linkRegister = context.setterLr;
  assert.equal(
    context.applyWarioWareNextMicrogameOverride(
      wariowareNextMicrogameSetterPc,
      override,
    ),
    true,
  );
  assert.equal(context.warioWareNextMicrogameOverridePending(override), false);
});

test("WarioWare next-microgame override fences active retail microgames and selector-bearing regions", () => {
  const context = overrideContext();
  const override = context.createWarioWareNextMicrogameOverride(
    new URLSearchParams("?wariowareNextMicrogame=0x63"),
  );
  const benignRegion = { pcs: [0x80001000, 0x80002000] };

  assert.equal(
    context.warioWareNextMicrogameOverrideRegionSafe(
      { pcs: [0x80001000, wariowareNextMicrogameSelectorPc] },
      override,
    ),
    false,
  );
  assert.equal(
    context.warioWareNextMicrogameOverrideRegionSafe(
      { pcs: [0x80001000, wariowareFilteredNextMicrogameSelectorPc] },
      override,
    ),
    false,
  );
  assert.equal(
    context.warioWareNextMicrogameOverrideRegionSafe(
      { pcs: [wariowareNextMicrogameSetterPc, 0x80002000] },
      override,
    ),
    false,
  );
  assert.equal(
    context.warioWareNextMicrogameOverrideRegionSafe(
      { pcs: [0x80001000, wariowareNextMicrogameActivationPc] },
      override,
    ),
    false,
  );
  assert.equal(
    context.warioWareNextMicrogameOverrideRegionSafe(
      benignRegion,
      override,
    ),
    true,
  );
  for (const activeMicrogameId of [1, 0x63, 0x117]) {
    assert.equal(
      context.warioWareNextMicrogameOverrideRegionSafe(
        benignRegion,
        override,
        activeMicrogameId,
      ),
      false,
      `retail microgame ${activeMicrogameId} must fence linked regions`,
    );
  }
  for (
    const inactiveMicrogameId
    of [null, 0, 0x118, 0x2706, 0x270f, -1, 1.5, NaN, "1"]
  ) {
    assert.equal(
      context.warioWareNextMicrogameOverrideRegionSafe(
        benignRegion,
        override,
        inactiveMicrogameId,
      ),
      true,
      `non-retail microgame ${String(inactiveMicrogameId)} must preserve benign regions`,
    );
  }
  assert.equal(
    context.warioWareNextMicrogameOverrideRegionSafe({}, override),
    false,
  );
  assert.equal(
    context.warioWareNextMicrogameOverrideRegionSafe({ pcs: [] }, override),
    false,
  );
  assert.equal(
    context.warioWareNextMicrogameOverrideRegionSafe(
      { pcs: [0x80001000, undefined] },
      override,
    ),
    false,
  );
  assert.equal(
    context.warioWareNextMicrogameOverrideRegionSafe(
      { pcs: [0x80001000, , 0x80002000] },
      override,
    ),
    false,
  );
  assert.equal(
    context.warioWareNextMicrogameOverrideRegionSafe(
      { pcs: [0x80001000, 0x80001000] },
      override,
    ),
    false,
  );

  override.applied = true;
  assert.equal(
    context.warioWareNextMicrogameOverrideRegionSafe(
      { pcs: [wariowareNextMicrogameSelectorPc] },
      override,
      0x63,
    ),
    true,
  );
  assert.equal(
    context.warioWareNextMicrogameOverrideRegionSafe({}, override),
    true,
  );

  const ineligible = context.createWarioWareNextMicrogameOverride(
    new URLSearchParams("?wariowareNextMicrogame=0x63"),
    { identifier: "GZWE01", discId: 0, version: 1 },
  );
  assert.equal(
    context.warioWareNextMicrogameOverrideRegionSafe(
      { pcs: [wariowareNextMicrogameSelectorPc] },
      ineligible,
      0x63,
    ),
    true,
  );
});

test("WarioWare next-microgame request remains debug-runner-only", () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(extractFunction("runnerSearchForSurface"), context);
  const request = "?wariowareNextMicrogame=0x63";

  assert.equal(context.runnerSearchForSurface(true, request), request);
  assert.equal(context.runnerSearchForSurface(false, request), "");
  assert.equal(
    context.runnerSearchForSurface(
      false,
      request,
      "?scenario=smb-ready-play",
    ),
    "?scenario=smb-ready-play",
  );
  assert.match(
    source,
    /runnerSearchForSurface\(\s*debugSurface,\s*location\.search,\s*selectedCompatibilityRunnerSearch\s*\)/,
  );
  assert.match(
    source,
    /controllerScenarioInputExclusive = controllerScenario !== null/,
  );
  for (const name of [
    "createWarioWareNextMicrogameOverride",
    "observeWarioWareNextMicrogameSelection",
    "applyWarioWareNextMicrogameOverride",
  ]) {
    assert.doesNotMatch(extractFunction(name), /controllerScenario/);
  }
});

test("WarioWare next-microgame source guards preserve the hook boundary", () => {
  const apply = extractFunction("applyWarioWareNextMicrogameOverride");
  const regionSafe = extractFunction(
    "warioWareNextMicrogameOverrideRegionSafe",
  );
  assert.match(
    source,
    /observeWarioWareNextMicrogameSelection\(pc\);\s+applyWarioWareNextMicrogameOverride\(pc\);\s+stage = "compile";/,
  );
  assert.match(
    source,
    /const wariowareActiveMicrogameId =\s+warioWareNextMicrogameOverridePending\(\)\s+\? guestU32\(0x80295ed0\)\s+: null/,
  );
  assert.match(
    source,
    /const region = retainedRegion !== undefined\s+&& warioWareNextMicrogameOverrideRegionSafe\(\s*retainedRegion,\s*wariowareNextMicrogameOverride,\s*wariowareActiveMicrogameId\s*\)/,
  );
  assert.match(
    regionSafe,
    /isUint32\(activeMicrogameId\)\s+&& activeMicrogameId >= 1\s+&& activeMicrogameId <= wariowareMaximumRetailMicrogameId/,
  );
  assert.match(
    apply,
    /const argumentRegister = activationSetter \? 3 : 4/,
  );
  assert.match(
    apply,
    /writeRegister\(argumentRegister, wariowareRepellionMicrogameId\)/,
  );
  assert.equal(
    [...apply.matchAll(/writeRegister\(/g)].length,
    1,
  );
  assert.match(
    extractFunction("exactWarioWareRevisionZero"),
    /disc\?\.identifier === "GZWE01"\s+&& disc\.discId === 0\s+&& disc\.version === 0/,
  );
  assert.match(
    extractFunction("createWarioWareNextMicrogameOverride"),
    /eligible: requested && exactWarioWareRevisionZero\(disc\)/,
  );
  assert.match(
    extractFunction("warioWareNextMicrogameOverridePending"),
    /return override\.eligible === true && override\.applied !== true/,
  );
});

test("WarioWare snapshots expose the exact live Repellion state", () => {
  const context = makeContext();
  const { view } = context;
  const runtime = 0x802ab420;
  const playerObject = 0x802a9000;
  for (const address of [0x80295ed0, 0x80295ed4, 0x80295ed8, 0x80295edc]) {
    view.setUint32(address & 0x1fffffff, 0x63, false);
  }
  view.setUint32(0x002f6860, runtime, false);
  view.setUint16(0x002f6580, 0x0100, false);
  view.setUint32(0x002f6598, playerObject, false);
  view.setUint32(0x002f6818, 2, false);
  view.setUint32((playerObject + 0x1230) & 0x1fffffff, 3, false);

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.inspectWarioWareGameState())),
    {
      activeGameSlots: [
        { address: "0x80295ed0", id: 0x63 },
        { address: "0x80295ed4", id: 0x63 },
        { address: "0x80295ed8", id: 0x63 },
        { address: "0x80295edc", id: 0x63 },
      ],
      activeMicrogameId: 0x63,
      player0RepellionActive: true,
      repellionActive: true,
      cardDialogStateAddress: "0x802958ac",
      cardDialogState: 0,
      cardDialogChoiceAddress: "0x802958b4",
      cardDialogChoice: 0,
      noMemoryCardDialog: false,
      noCardFlowActive: false,
      runtimePointerAddress: "0x802f6860",
      runtime: "0x802ab420",
      gameplayButtonsAddress: "0x802f6580",
      gameplayButtons: 0x0100,
      aActive: true,
      playerObjectPointerAddress: "0x802f6598",
      playerObject: "0x802a9000",
      playerResultAddress: "0x802f6818",
      playerResult: 2,
      playerObjectResultAddress: "0x802aa230",
      playerObjectResult: 3,
      lastActiveGameplayInput: null,
      nextMicrogameOverride: {
        requested: false,
        eligible: false,
        applied: false,
        cycle: null,
        pc: null,
        original: null,
        forced: null,
        player: null,
        caller: null,
        lr: null,
        selectorCycle: null,
        selectorPc: null,
        selectorLr: null,
      },
    },
  );
});

test("WarioWare diagnostics fail closed on absent runtime pointers", () => {
  const snapshot = JSON.parse(JSON.stringify(
    makeContext().inspectWarioWareGameState(),
  ));
  assert.equal(snapshot.runtime, null);
  assert.equal(snapshot.gameplayButtonsAddress, null);
  assert.equal(snapshot.gameplayButtons, null);
  assert.equal(snapshot.aActive, null);
  assert.equal(snapshot.playerObject, null);
  assert.equal(snapshot.playerResult, null);
  assert.equal(snapshot.playerObjectResult, null);
});

test("WarioWare exposes the exact no-Memory-Card dialog state", () => {
  const context = makeContext();
  context.view.setInt32(0x002958ac, 11, false);
  context.view.setInt32(0x002958b4, 1, false);

  const snapshot = context.inspectWarioWareGameState();
  assert.equal(snapshot.cardDialogState, 11);
  assert.equal(snapshot.cardDialogChoice, 1);
  assert.equal(snapshot.noMemoryCardDialog, true);
  assert.equal(snapshot.noCardFlowActive, true);
  assert.equal(snapshot.repellionActive, false);

  context.view.setInt32(0x002958ac, 0x21, false);
  const confirmation = context.inspectWarioWareGameState();
  assert.equal(confirmation.noMemoryCardDialog, false);
  assert.equal(confirmation.noCardFlowActive, true);
});

test("WarioWare keeps game zero and signed result sentinels meaningful", () => {
  const context = makeContext();
  const { view } = context;
  const runtime = 0x802ab420;
  view.setUint32(0x00295ed0, 0, false);
  view.setUint32(0x00295ed4, 0x63, false);
  view.setUint32(0x002f6860, runtime, false);
  view.setUint32(0x002f6818, 0xffffffff, false);

  const snapshot = context.inspectWarioWareGameState();
  assert.equal(snapshot.activeMicrogameId, 0);
  assert.equal(snapshot.player0RepellionActive, false);
  assert.equal(snapshot.repellionActive, true);
  assert.equal(snapshot.playerResult, -1);
});

test("WarioWare retains the first same-sequence guest-consumed A receipt", () => {
  const context = makeContext();
  const { view } = context;
  const runtime = 0x802ab420;
  const playerObject = 0x802a9000;
  view.setUint32(0x00295ed0, 0x63, false);
  view.setUint32(0x002f6860, runtime, false);
  view.setUint16(0x002f6580, 0x0100, false);
  view.setUint32(0x002f6598, playerObject, false);
  view.setInt32((playerObject + 0x1230) & 0x1fffffff, -1, false);
  context.controllerAppliedSequence = 7;
  context.serialLastActiveHostPublication = {
    source: "periodic",
    pollIndex: 42,
    scheduledCycle: 100,
    observedCycle: 105,
    buttons: 0x0100,
    sequence: 7,
  };

  context.sampleWarioWareGameplayInput(120);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.inspectWarioWareGameState().lastActiveGameplayInput,
    )),
    {
      cycle: 120,
      buttons: 0x0100,
      controllerAppliedSequence: 7,
      hostPublication: {
        source: "periodic",
        pollIndex: 42,
        scheduledCycle: 100,
        observedCycle: 105,
        buttons: 0x0100,
        sequence: 7,
      },
      playerObject: "0x802a9000",
      playerObjectResult: -1,
    },
  );

  context.sampleWarioWareGameplayInput(130);
  assert.equal(
    context.inspectWarioWareGameState().lastActiveGameplayInput.cycle,
    120,
  );

  context.controllerAppliedSequence = 8;
  context.sampleWarioWareGameplayInput(140);
  assert.equal(
    context.inspectWarioWareGameState().lastActiveGameplayInput.cycle,
    120,
  );
  assert.equal(
    context.inspectWarioWareGameState()
      .lastActiveGameplayInput.controllerAppliedSequence,
    7,
  );

  view.setUint16(0x002f6580, 0, false);
  context.sampleWarioWareGameplayInput(150);
  assert.equal(
    context.inspectWarioWareGameState().lastActiveGameplayInput.cycle,
    120,
  );
});

test("WarioWare guest input latch requires live Repellion and a matching host A", () => {
  const context = makeContext();
  const runtime = 0x802ab420;
  context.view.setUint32(0x002f6860, runtime, false);
  context.view.setUint16(0x002f6580, 0x0100, false);
  context.serialLastActiveHostPublication = {
    source: "periodic",
    pollIndex: 1,
    scheduledCycle: 10,
    observedCycle: 10,
    buttons: 0x0100,
    sequence: 1,
  };

  context.sampleWarioWareGameplayInput(20);
  assert.equal(context.wariowareLastActiveGameplayInput, null);
  context.view.setUint32(0x00295ed0, 0x63, false);
  context.serialLastActiveHostPublication.buttons = 0x1000;
  context.sampleWarioWareGameplayInput(20);
  assert.equal(context.wariowareLastActiveGameplayInput, null);
  assert.match(
    source,
    /function sampleGuestGameplayInput\(sampleCycle\) \{[\s\S]*sampleWarioWareGameplayInput\(sampleCycle\);/,
  );
});

test("guest game diagnostics dispatch by exact retail identity", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GZLE01").inspectGuestGameState())),
    { game: "wind" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(makeContext("GMBE8P").inspectGuestGameState())),
    { game: "smb" },
  );
  assert.notEqual(makeContext("GZWE01").inspectGuestGameState(), null);
  assert.match(source, /guestGame: inspectGuestGameState\(\)/);
});
