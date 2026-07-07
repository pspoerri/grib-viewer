import assert from "node:assert/strict";
import { timeFractions, nearestFracIndex, cellWidths } from "../src/lib/meteogramScale.ts";

const H = 3600_000;

// Variable-cadence horizon: 3 hourly frames, then a 6h jump. Index
// spacing would place the 6h frame at fraction 3/4; time spacing must
// place it at its true position (further right).
{
  const t0 = Date.UTC(2026, 5, 11, 0);
  const stepMs = [t0, t0 + 1 * H, t0 + 2 * H, t0 + 8 * H]; // 0,1,2,8h
  const f = timeFractions(stepMs);
  assert.equal(f.length, 4);
  assert.equal(f[0], 0);
  assert.equal(f[3], 1);
  // 2h of 8h total → 0.25, NOT the index fraction 2/3.
  assert.ok(Math.abs(f[2] - 0.25) < 1e-9, `f[2]=${f[2]} want 0.25`);
  assert.ok(f[2] < 2 / 3, "time fraction must trail the index fraction in a coarse tail");
}

// Degenerate cases.
assert.deepEqual(timeFractions([]), []);
assert.deepEqual(timeFractions([123]), [0.5]);

// nearestFracIndex inverts the mapping (hover/click hit-testing).
{
  const f = [0, 0.25, 1]; // from the variable-cadence series above
  assert.equal(nearestFracIndex(f, 0.0), 0);
  assert.equal(nearestFracIndex(f, 0.24), 1);
  assert.equal(nearestFracIndex(f, 0.9), 2);
  assert.equal(nearestFracIndex(f, 0.7), 2, "0.7 is closer to 1.0 (d=0.3) than to 0.25 (d=0.45)");
  assert.equal(nearestFracIndex(f, 0.6), 1, "0.6 is closer to 0.25 (d=0.35) than to 1.0 (d=0.4)");
}

// cellWidths tile the axis: a frame after a big time gap is wider.
{
  const f = [0, 0.25, 1];
  const w = cellWidths(f, 100); // innerW = 100px
  assert.equal(w.length, 3);
  // The last frame follows a 0.75-wide gap → much wider than the first two.
  assert.ok(w[2] > w[1] && w[2] > w[0], "coarse-tail cell must be widest");
  // Single / empty.
  assert.deepEqual(cellWidths([], 100), []);
  assert.deepEqual(cellWidths([0.5], 100), [100]);
}

console.log("meteogramScale: all assertions passed");
