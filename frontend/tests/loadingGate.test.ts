import { test } from "node:test";
import assert from "node:assert/strict";
import { WxLayerManager } from "../src/lib/wxLayerManager.ts";

// Regression guard for the "0 requests in flight" stuck overlay.
//
// The GPU loading gate is `winInflight.size > 0`. A window fetch that SUCCEEDS
// re-runs applyPlayhead (which re-evaluates the gate at its tail), but a window
// that FAILS or resolves EMPTY (w === null — a 404, a network error, or a
// missing frame in thin/incomplete data) used to only clear the layer and
// never re-evaluate the gate, so `loading` stuck true and the centered overlay
// stayed up showing "0 requests in flight" forever. The fix re-evaluates the
// gate inside ensureWindow on every settle. We poke privates (as any) because
// ensureWindow/fetchWindow are internal to the manager.

function makeMgr(fetchImpl: () => Promise<unknown>) {
  const loadings: boolean[] = [];
  const map = { on: () => {}, off: () => {} } as unknown;
  const mgr = new WxLayerManager(
    map as never,
    (v: boolean) => loadings.push(v),
  ) as unknown as {
    lastLoading: boolean;
    fetchWindow: unknown;
    winInflight: Map<string, unknown>;
    ensureWindow: (u: unknown, meta: unknown, ti: number, vp: unknown) => Promise<unknown>;
  };
  mgr.lastLoading = true; // overlay already showing (a prior miss armed the gate)
  mgr.fetchWindow = fetchImpl;
  return { mgr, loadings };
}

const U = { model: "icond2", key: "u0", layer: { variable: "precip_1h", plane: 0 } };
const META = { timesteps: [], native_deg: 0.0625 };
const VP = { bbox: "0,0,1,1", lonSpan: 1, latSpan: 1 };

test("failed window fetch clears the loading gate", async () => {
  const { mgr, loadings } = makeMgr(() => Promise.reject(new Error("boom")));
  const w = await mgr.ensureWindow(U, META, 0, VP);
  assert.equal(w, null);
  assert.equal(mgr.winInflight.size, 0);
  assert.ok(loadings.includes(false), "onLoading(false) must fire after a failed window");
});

test("empty window (null — missing frame in thin data) clears the loading gate", async () => {
  const { mgr, loadings } = makeMgr(() => Promise.resolve(null));
  const w = await mgr.ensureWindow(U, META, 0, VP);
  assert.equal(w, null);
  assert.equal(mgr.winInflight.size, 0);
  assert.ok(loadings.includes(false), "onLoading(false) must fire after an empty window");
});

// A composite contributor whose footprint doesn't intersect the viewport
// (icond2 while the map shows the southern hemisphere) must not be fetched at
// all — the server 404s "window does not overlap the grid" for every window.
test("off-screen contributor domain suppresses the fetch entirely", async () => {
  let called = 0;
  const { mgr } = makeMgr(() => {
    called++;
    return Promise.resolve(null);
  });
  // domain is (w, s, e, n); VP is lat 0..1, lon 0..1 — icond2's Europe box misses it.
  const off = { ...U, domain: [-4, 43, 20, 58] };
  assert.equal(await mgr.ensureWindow(off, META, 0, VP), null);
  assert.equal(called, 0, "no fetch for a non-overlapping domain");
  const on = { ...U, domain: [0.5, 0.5, 2, 2] };
  await mgr.ensureWindow(on, META, 0, VP);
  assert.equal(called, 1, "overlapping domain still fetches");
});
