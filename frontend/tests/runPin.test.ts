import { test } from "node:test";
import assert from "node:assert/strict";
import { WxLayerManager } from "../src/lib/wxLayerManager.ts";

// Run pinning: the window cache and the fetch-identity signature must re-key
// on the pinned run so pinned and latest windows never mix, and pinning must
// flush the per-run caches. We poke privates (as any) because cacheKey /
// unitFetchSig are internal to the manager.

function makeMgr() {
  const map = { on: () => {}, off: () => {} } as unknown;
  return new WxLayerManager(map as never) as unknown as {
    setPinnedRun(model: string, run: string): void;
    cacheKey(u: unknown, bbox: string, ti: number): string;
    unitFetchSig(u: unknown): string;
    winCache: Map<string, unknown>;
    metaResolved: Map<string, unknown>;
    applyPlayhead(): void;
    units: unknown[];
  };
}

const U = { model: "icond2", key: "u0", layer: { variable: "t_2m" } };
const BBOX = "45.00,6.00,48.00,11.00";

test("cacheKey re-keys on the pinned run", () => {
  const mgr = makeMgr();
  mgr.applyPlayhead = () => {}; // keep the poke-level test inert
  const latest = mgr.cacheKey(U, BBOX, 3);
  assert.ok(latest.includes("|latest|"), latest);
  mgr.setPinnedRun("icond2", "2026-06-27T12:00:00Z");
  const pinned = mgr.cacheKey(U, BBOX, 3);
  assert.notEqual(pinned, latest);
  assert.ok(pinned.includes("2026-06-27T12:00:00Z"), pinned);
  // A different model keeps resolving latest (pin is per-model).
  const other = mgr.cacheKey({ ...U, model: "iconeu" }, BBOX, 3);
  assert.ok(other.includes("|latest|"), other);
});

test("cacheKey carries the quantized bbox + frame + agg identity", () => {
  const mgr = makeMgr();
  mgr.applyPlayhead = () => {};
  const a = mgr.cacheKey(U, BBOX, 3);
  assert.notEqual(a, mgr.cacheKey(U, BBOX, 4)); // frame
  assert.notEqual(a, mgr.cacheKey(U, "45.01,6.00,48.00,11.00", 3)); // bbox
  const agg = { ...U, layer: { ...U.layer, agg: "max", windowStartMs: 0, windowEndMs: 1 } };
  assert.notEqual(a, mgr.cacheKey(agg, BBOX, 3)); // windowed identity
});

test("unitFetchSig (abort identity) re-keys on the pinned run", () => {
  const mgr = makeMgr();
  mgr.applyPlayhead = () => {};
  const before = mgr.unitFetchSig(U);
  mgr.setPinnedRun("icond2", "2026-06-27T12:00:00Z");
  const after = mgr.unitFetchSig(U);
  assert.notEqual(before, after);
});

test("setPinnedRun flushes the window + meta caches; same pin is a no-op", () => {
  const mgr = makeMgr();
  let applies = 0;
  mgr.applyPlayhead = () => {
    applies++;
  };
  mgr.winCache.set("k", {});
  mgr.metaResolved.set("u0", {});
  mgr.setPinnedRun("icond2", "2026-06-27T12:00:00Z");
  assert.equal(mgr.winCache.size, 0);
  assert.equal(mgr.metaResolved.size, 0);
  assert.equal(applies, 1);
  // Re-pinning the same run must not thrash the caches again.
  mgr.winCache.set("k2", {});
  mgr.setPinnedRun("icond2", "2026-06-27T12:00:00Z");
  assert.equal(mgr.winCache.size, 1);
  assert.equal(applies, 1);
  // Unpinning flushes once more.
  mgr.setPinnedRun("icond2", "");
  assert.equal(mgr.winCache.size, 0);
  assert.equal(applies, 2);
});
