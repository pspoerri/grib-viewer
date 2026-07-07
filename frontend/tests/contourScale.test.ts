import { test } from "node:test";
import assert from "node:assert/strict";
import { niceStep, dataRange, contourInterval } from "../src/lib/contourScale.ts";

test("niceStep snaps to 1/2/5×10ⁿ", () => {
  assert.equal(niceStep(1.47), 1);
  assert.equal(niceStep(1.6), 2);
  assert.equal(niceStep(333), 500);
  assert.equal(niceStep(1400), 1000);
});

test("dataRange returns p2–p98 of dequantized non-nodata values", () => {
  // raw 0..99 with scale 1, offset 100000 → 100000..100099; nodata -32768 skipped.
  const vals = [];
  for (let i = 0; i < 100; i++) vals.push(i);
  vals.push(-32768, -32768);
  const r = dataRange(vals, -32768, 1, 100000);
  assert.ok(r);
  assert.equal(r.lo, 100002); // floor(102*0.02)=2 → value 2 → 100002
  assert.ok(r.hi >= 100090 && r.hi <= 100099);
});

test("dataRange null when too few valid cells", () => {
  assert.equal(dataRange([-32768, -32768], -32768, 1, 0), null);
});

test("interval comes from DATA range, not the wide colormap range", () => {
  // pmsl-like: colormap 87000..108000 (interval would be ~1400 → 10 hPa), but
  // the actual field is 101000..102500 Pa → a ~100 Pa (1 hPa) interval.
  const colormapInterval = niceStep((108000 - 87000) / 12);
  const dataInterval = contourInterval(101000, 102500);
  assert.ok(dataInterval < colormapInterval, `data ${dataInterval} should be finer than colormap ${colormapInterval}`);
  assert.ok(dataInterval <= 200, `pmsl data interval ${dataInterval} Pa should be ≤ 200 (≤2 hPa)`);
});
