#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sourcePath = new URL(
  "../crates/ppcwasmjit/examples/browser_boot.rs",
  import.meta.url,
);
const source = readFileSync(sourcePath, "utf8");

function extractFunctions(name) {
  const declarations = [];
  let searchFrom = 0;
  while (true) {
    const start = source.indexOf(`function ${name}(`, searchFrom);
    if (start === -1) return declarations;
    const bodyStart = source.indexOf("{", start);
    assert.notEqual(bodyStart, -1, `missing body for ${name}`);

    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] !== "}") continue;
      depth -= 1;
      if (depth !== 0) continue;
      declarations.push(source.slice(start, index + 1));
      searchFrom = index + 1;
      break;
    }
  }
}

const declarations = extractFunctions("createWeightedLruCache");
assert.equal(declarations.length, 2, "worker and presentation caches share the helper");
assert.equal(declarations[0], declarations[1], "weighted LRU implementations diverged");

const context = { Map, Math, Number };
vm.createContext(context);
vm.runInContext(declarations[0], context, { filename: "browser_boot.cache.js" });

test("weighted cache evicts the least recently used value", () => {
  const cache = context.createWeightedLruCache(4, 7, value => value.weight);
  const first = { weight: 3 };
  const second = { weight: 3 };
  const third = { weight: 3 };
  cache.set("first", first).set("second", second);
  assert.equal(cache.get("first"), first);

  cache.set("third", third);

  assert.equal(cache.get("second"), undefined);
  assert.equal(cache.get("first"), first);
  assert.equal(cache.get("third"), third);
  assert.equal(cache.weight, 6);
  assert.equal(cache.evictions, 1);
});

test("weighted cache also retains the entry-count guard", () => {
  const cache = context.createWeightedLruCache(2, 100, value => value.weight);
  cache.set("first", { weight: 1 });
  cache.set("second", { weight: 1 });
  cache.set("third", { weight: 1 });

  assert.equal(cache.get("first"), undefined);
  assert.equal(cache.size, 2);
  assert.equal(cache.weight, 2);
  assert.equal(cache.evictions, 1);
});

test("an individually oversized value is used without being retained", () => {
  const cache = context.createWeightedLruCache(4, 4, value => value.weight);
  cache.set("oversized", { weight: 5 });

  assert.equal(cache.get("oversized"), undefined);
  assert.equal(cache.size, 0);
  assert.equal(cache.weight, 0);
  assert.equal(cache.evictions, 1);
});

test("clearing a weighted cache resets its accounting", () => {
  const cache = context.createWeightedLruCache(1, 4, value => value.weight);
  cache.set("first", { weight: 1 });
  cache.set("second", { weight: 1 });
  cache.clear();

  assert.equal(cache.size, 0);
  assert.equal(cache.weight, 0);
  assert.equal(cache.evictions, 0);
  assert.equal(cache.maximumWeight, 4);
});
