import { test } from "node:test";
import assert from "node:assert/strict";
import { stitchWindows, type Window } from "../src/lib/wxdata2.ts";

// A tile Window cut from a shared native lattice (dlon=dlat=1, origin 50N/0E),
// covering `nx`×`ny` cells whose value = its global row*100 + col.
function tile(lon0: number, lat0: number, nx: number, ny: number): Window {
  const values = new Int16Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      values[j * nx + i] = (50 - lat0 + j) * 100 + (lon0 + i);
    }
  }
  return {
    model: "m",
    variable: "t_2m",
    grid: { nx, ny, lat0, lon0, dlat: -1, dlon: 1 },
    values,
    scale: 0.1,
    offset: 0,
    nodata: -32768,
  };
}

test("stitchWindows: 2×2 tile mosaic reassembles the source lattice", () => {
  // Tiles overlap by one column/row (the server margin duplicates edge cells).
  const w = stitchWindows([tile(0, 50, 3, 3), tile(2, 50, 3, 3), tile(0, 48, 3, 3), tile(2, 48, 3, 3)]);
  assert.ok(w);
  assert.deepEqual(w.grid, { nx: 5, ny: 5, lat0: 50, lon0: 0, dlat: -1, dlon: 1 });
  for (let j = 0; j < 5; j++) {
    for (let i = 0; i < 5; i++) {
      assert.equal(w.values[j * 5 + i], j * 100 + i, `cell ${j},${i}`);
    }
  }
  assert.equal(w.scale, 0.1);
});

test("stitchWindows: a missing tile leaves a nodata hole", () => {
  const w = stitchWindows([tile(0, 50, 2, 2), null, tile(0, 48, 2, 2), tile(2, 48, 2, 2)]);
  assert.ok(w);
  assert.deepEqual(w.grid, { nx: 4, ny: 4, lat0: 50, lon0: 0, dlat: -1, dlon: 1 });
  assert.equal(w.values[0 * 4 + 0], 0); // present tile
  assert.equal(w.values[0 * 4 + 3], -32768); // hole where the NE tile 404'd
  assert.equal(w.values[3 * 4 + 3], 303); // SE tile
});

test("stitchWindows: single tile passes through unchanged", () => {
  const t = tile(4, 47, 3, 2);
  assert.equal(stitchWindows([null, t, null]), t);
});

test("stitchWindows: all-null → null", () => {
  assert.equal(stitchWindows([null, null]), null);
});

test("stitchWindows: a tile on a different lattice step is dropped, not blended", () => {
  const coarse = tile(0, 50, 3, 3);
  const fine = tile(4, 50, 3, 3);
  fine.grid = { ...fine.grid, dlon: 0.5, dlat: -0.5 };
  const w = stitchWindows([coarse, fine]);
  assert.ok(w);
  assert.deepEqual(w.grid, coarse.grid);
});
