import { test } from "node:test";
import assert from "node:assert/strict";
import {
  quantizeCoord,
  requestBBox,
  splitPolarBBoxes,
  heightWindow,
} from "../src/lib/wxLayerManager.ts";
import type { Window } from "../src/lib/wxdata2.ts";

test("quantizeCoord rounds outward to 0.01°", () => {
  assert.equal(quantizeCoord(7.123, 1), 7.13);
  assert.equal(quantizeCoord(7.123, -1), 7.12);
  assert.equal(quantizeCoord(-7.123, 1), -7.12);
  assert.equal(quantizeCoord(-7.123, -1), -7.13);
  // -0 never leaks into the cache key string.
  assert.ok(Object.is(quantizeCoord(-0.001, 1), 0));
});

test("requestBBox pads ~15% per side and quantizes to 2 decimals", () => {
  // 10°-wide box → 1.5° pad per side at 0.15.
  const bbox = requestBBox(0, 40, 10, 50, 0.15);
  assert.equal(bbox, "38.50,-1.50,51.50,11.50");
});

test("requestBBox: tiny pans within the quantization grid share a key", () => {
  const a = requestBBox(7.001, 46.001, 8.001, 47.001, 0);
  const b = requestBBox(7.002, 46.003, 8.002, 47.003, 0);
  assert.equal(a, "46.00,7.00,47.01,8.01");
  assert.equal(b, a, "sub-0.01° moves must reuse the cache key");
});

test("requestBBox clamps to the valid lat/lon range", () => {
  const bbox = requestBBox(-179, -89, 179, 89, 0.15);
  const [s, w, n, e] = bbox.split(",").map(Number);
  assert.equal(s, -90);
  assert.equal(n, 90);
  assert.equal(w, -180);
  assert.equal(e, 180);
});

test("splitPolarBBoxes: mid-latitude viewport stays a single request", () => {
  assert.deepEqual(splitPolarBBoxes("40.00,-10.00,60.00,20.00"), [
    "40.00,-10.00,60.00,20.00",
  ]);
});

test("splitPolarBBoxes: a north-pole globe view extends to the pole", () => {
  // one request, not a separate band: a band would come back on a finer
  // lattice level than the budget-coarsened main window and stitch as holes
  assert.deepEqual(splitPolarBBoxes("40.00,-180.00,86.00,180.00"), [
    "40,-180,90,180",
  ]);
});

test("splitPolarBBoxes: both poles visible → one pole-to-pole request", () => {
  assert.deepEqual(splitPolarBBoxes("-88.00,-180.00,88.00,180.00"), [
    "-90,-180,90,180",
  ]);
});

test("heightWindow wraps the /data height plane onto the value grid", () => {
  const win: Window = {
    model: "icond2",
    variable: "t_2m",
    grid: { nx: 2, ny: 1, lat0: 50, lon0: 10, dlat: -1, dlon: 1 },
    values: new Int16Array([1, 2]),
    scale: 0.1,
    offset: 0,
    nodata: -32768,
    height: new Int16Array([500, -100]),
  };
  const z = heightWindow(win);
  assert.ok(z);
  assert.equal(z.variable, "z_model");
  assert.deepEqual(z.grid, win.grid); // identical grid → gridsAlign trivially true
  assert.equal(z.scale, 1);
  assert.equal(z.offset, 0);
  assert.deepEqual([...z.values], [500, -100]);
});

test("heightWindow: absent or mis-sized height plane → null", () => {
  const win: Window = {
    model: "icond2",
    variable: "t_2m",
    grid: { nx: 2, ny: 1, lat0: 50, lon0: 10, dlat: -1, dlon: 1 },
    values: new Int16Array([1, 2]),
    scale: 0.1,
    offset: 0,
    nodata: -32768,
  };
  assert.equal(heightWindow(win), null);
  assert.equal(heightWindow({ ...win, height: new Int16Array([1]) }), null);
});
