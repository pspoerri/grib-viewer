// Node-run unit tests for the add-layer ensembleMode seed (Task 5).
// No framework; mirrors tests/epsMode.test.ts.
//   node --no-warnings tests/layerSeed.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { seedEnsembleMode } from "../src/lib/layerSeed.ts";

test("auto composite seeds det", () => {
  assert.equal(seedEnsembleMode("auto"), "det");
});

test("auto_eps composite seeds eps", () => {
  assert.equal(seedEnsembleMode("auto_eps"), "eps");
});

test("physical model leaves ensembleMode undefined", () => {
  assert.equal(seedEnsembleMode("iconeueps"), undefined);
  assert.equal(seedEnsembleMode("icondglobal"), undefined);
  assert.equal(seedEnsembleMode("iconch1"), undefined);
});

console.log("layerSeed tests passed");
