import { test } from "node:test";
import assert from "node:assert/strict";
import { gridsAlign, type Grid } from "../src/lib/wxdata2.ts";

const base: Grid = { nx: 64, ny: 48, lat0: 48.5, lon0: 5.25, dlat: -0.02, dlon: 0.02 };

test("gridsAlign: identical grid-defs align (lapse samples z_model at value coords)", () => {
  assert.equal(gridsAlign(base, { ...base }), true);
});

test("gridsAlign: float origin/step within epsilon still aligns", () => {
  assert.equal(gridsAlign(base, { ...base, lat0: base.lat0 + 1e-9, dlon: base.dlon - 5e-10 }), true);
});

test("gridsAlign: a coarser level-fallback (different dims) does NOT align → lapse skipped", () => {
  assert.equal(gridsAlign(base, { ...base, nx: 32, ny: 24 }), false);
});

test("gridsAlign: a shifted origin (different bbox) does NOT align", () => {
  assert.equal(gridsAlign(base, { ...base, lon0: base.lon0 + 0.5 }), false);
  assert.equal(gridsAlign(base, { ...base, lat0: base.lat0 - 0.5 }), false);
});

test("gridsAlign: a different step (different level) does NOT align", () => {
  assert.equal(gridsAlign(base, { ...base, dlat: base.dlat * 2, dlon: base.dlon * 2 }), false);
});
