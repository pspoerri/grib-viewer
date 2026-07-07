import { test } from "node:test";
import assert from "node:assert/strict";
import { lapseGateKey } from "../src/api/mapConfig.ts";

test("lapseGateKey: on encodes bbox + level", () => {
  assert.equal(lapseGateKey(true, "46,7,48,10", 3), "1|46,7,48,10|3");
});

test("lapseGateKey: distinct viewport or level → distinct key", () => {
  assert.notEqual(lapseGateKey(true, "46,7,48,10", 3), lapseGateKey(true, "46,7,48,10", 4));
  assert.notEqual(lapseGateKey(true, "46,7,48,10", 3), lapseGateKey(true, "40,5,42,8", 3));
});

test("lapseGateKey: off collapses to one key regardless of bbox/level", () => {
  assert.equal(lapseGateKey(false, "46,7,48,10", 3), "0");
  assert.equal(lapseGateKey(false, "40,5,42,8", -1), "0");
  assert.equal(lapseGateKey(false, "46,7,48,10", 3), lapseGateKey(false, "x", 99));
});

test("lapseGateKey: same on-state + viewport + level → stable (gate early-returns)", () => {
  assert.equal(lapseGateKey(true, "46,7,48,10", 2), lapseGateKey(true, "46,7,48,10", 2));
});
